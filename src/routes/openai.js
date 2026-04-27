const express = require('express');
const { convertRequest } = require('../converter/openai-to-jb');
const { convertStreamToOpenAI } = require('../converter/jb-to-openai');
const accountManager = require('../account-manager');
const jb = require('../jb-client');
const modelsCache = require('../models-cache');

const router = express.Router();

// /v1/models — 从本地缓存读取，永不阻塞 Cursor 启动
router.get('/v1/models', (req, res) => {
  try {
    const data = modelsCache.listForOpenAI();
    res.json({ object: 'list', data });
  } catch (err) {
    console.error('GET /v1/models error:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

router.post('/v1/chat/completions', async (req, res) => {
  // 解析模型后缀，决定走原生 reasoning-effort / 原生 thinking-budget / prompt 注入 / 不动
  const resolved = modelsCache.resolveModel(req.body.model);

  // ── 调试日志：按模型简介 ──
  const _dbgMsgs = (req.body.messages || []).map((m, i) => {
    const c = m.content;
    let preview;
    if (c === null || c === undefined) preview = '(null)';
    else if (typeof c === 'string') preview = c.length > 80 ? c.slice(0, 80) + '...' : c;
    else if (Array.isArray(c)) preview = `[${c.length} blocks]`;
    else preview = JSON.stringify(c).slice(0, 80);
    return `  [${i}] ${m.role}: ${preview}`;
  });
  console.log(`\n[DEBUG /v1/chat/completions] model=${req.body.model} -> profile=${resolved.profile} mode=${resolved.mode}${resolved.level ? '/' + resolved.level : ''} stream=${req.body.stream} messages=${(req.body.messages||[]).length}\n${_dbgMsgs.join('\n')}`);

  // 客户端断开时取消上游 fetch（避免空跑浪费 token）
  const clientAbort = new AbortController();
  const onClientClose = () => { clientAbort.abort('client closed'); };
  res.once('close', onClientClose);

  const MAX_RETRIES = 3;
  const excludeIds = [];
  // 上游 terminated 错误也算一次失败，但只重试 1 次（避免风暴）
  let terminatedRetried = false;
  // 当前 attempt 用的账号（catch 里要拿来加 excludeIds）
  let currentAccount = null;

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 客户端已断开就直接退出，不要再调上游
        if (clientAbort.signal.aborted) {
          console.log('[chat] client aborted before request, skip');
          return;
        }

        const account = accountManager.getNext(excludeIds);
        currentAccount = account;
        if (!account) {
          if (!res.headersSent) res.status(503).json({ error: { message: 'No active accounts', type: 'server_error' } });
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

          const status = jbRes.status;
          if (!res.headersSent) res.status(status).json({ error: { message: errText, type: 'api_error' } });
          return;
        }

        const isStream = req.body.stream !== false;
        await convertStreamToOpenAI(jbRes.body, res, req.body.model, isStream, {
          promptInject: resolved.mode === 'prompt_inject',
        });
        return;
      } catch (err) {
        // 客户端主动断开 / signal abort：不算上游错误，安静退出
        if (clientAbort.signal.aborted || /aborted|AbortError/i.test(err.name || err.message)) {
          console.log('[chat] aborted by client');
          return;
        }
        // 上游 terminated（梯子断线 / JB 心跳断）：换一个账号重试一次
        // 关键：把当前账号加 excludeIds，避免下一轮又抽到同一个（同节点同样会 terminated）
        if (/terminated|UND_ERR|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message) && !terminatedRetried) {
          terminatedRetried = true;
          if (currentAccount) excludeIds.push(currentAccount.id);
          console.warn(`[chat] upstream terminated on ${currentAccount?.email || '?'}, retry with another account: ${err.message}`);
          continue;
        }
        console.error('POST /v1/chat/completions error:', err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: { message: 'Upstream error: ' + err.message, type: 'upstream_error' } });
        } else if (!res.writableEnded && !clientAbort.signal.aborted) {
          // 已经开始流式了 + 客户端没断开 → 发个错误事件再结束
          try {
            res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch {}
        }
        return;
      }
    }

    if (!res.headersSent) {
      res.status(429).json({ error: { message: 'All accounts quota exhausted', type: 'rate_limit_error' } });
    }
  } finally {
    res.removeListener('close', onClientClose);
  }
});

module.exports = router;
