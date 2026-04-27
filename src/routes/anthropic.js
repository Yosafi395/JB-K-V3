const express = require('express');
const { convertRequest } = require('../converter/anthropic-to-jb');
const { convertStreamToAnthropic } = require('../converter/jb-to-anthropic');
const accountManager = require('../account-manager');
const jb = require('../jb-client');
const modelsCache = require('../models-cache');

const router = express.Router();

router.post('/v1/messages', async (req, res) => {
  const resolved = modelsCache.resolveModel(req.body.model);

  // 客户端断开守护
  const clientAbort = new AbortController();
  const onClientClose = () => { clientAbort.abort('client closed'); };
  res.once('close', onClientClose);

  const MAX_RETRIES = 3;
  const excludeIds = [];
  let terminatedRetried = false;
  let currentAccount = null;

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (clientAbort.signal.aborted) return;

        const account = accountManager.getNext(excludeIds);
        currentAccount = account;
        if (!account) {
          if (!res.headersSent) res.status(503).json({
            type: 'error',
            error: { type: 'overloaded_error', message: 'No active accounts' },
          });
          return;
        }

        const jwt = await accountManager.ensureValidJwt(account);
        const jbBody = convertRequest(req.body, resolved);
        const jbRes = await jb.chatStream(jwt, jbBody, clientAbort.signal);

        if (!jbRes.ok) {
          const errText = await jbRes.text();

          if (jbRes.status === 477) {
            const switched = await accountManager.markQuotaExhausted(account);
            if (!switched) excludeIds.push(account.id);
            console.log(`[477] ${account.email}: ${switched ? 'switched license' : 'exhausted'}, retry ${attempt + 1}/${MAX_RETRIES}`);
            continue;
          }

          if (!res.headersSent) res.status(jbRes.status).json({
            type: 'error',
            error: { type: 'api_error', message: errText },
          });
          return;
        }

        const isStream = req.body.stream !== false;
        await convertStreamToAnthropic(jbRes.body, res, req.body.model, isStream);
        return;
      } catch (err) {
        if (clientAbort.signal.aborted || /aborted|AbortError/i.test(err.name || err.message)) {
          console.log('[anthropic-chat] aborted by client');
          return;
        }
        if (/terminated|UND_ERR|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message) && !terminatedRetried) {
          terminatedRetried = true;
          if (currentAccount) excludeIds.push(currentAccount.id);
          console.warn(`[anthropic-chat] upstream terminated on ${currentAccount?.email || '?'}, retry with another account: ${err.message}`);
          continue;
        }
        console.error('POST /v1/messages error:', err.message);
        if (!res.headersSent) {
          res.status(502).json({
            type: 'error',
            error: { type: 'api_error', message: err.message },
          });
        }
        return;
      }
    }

    if (!res.headersSent) {
      res.status(429).json({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'All accounts quota exhausted' },
      });
    }
  } finally {
    res.removeListener('close', onClientClose);
  }
});

module.exports = router;
