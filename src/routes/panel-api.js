const express = require('express');
const fs = require('fs');
const path = require('path');
const accountManager = require('../account-manager');
const jb = require('../jb-client');
const { loadConfig } = require('../config');
const { ProxyPool } = require('../proxy-pool');
const modelsCache = require('../models-cache');

const router = express.Router();

// ── 配额聚合缓存（5 分钟 TTL，避免短时间内重复打 JB API）──
let _quotaCache = { ts: 0, data: null };
const QUOTA_CACHE_TTL = 5 * 60 * 1000;

// 工作分配计数器（每次探测一个 license 都 +1，保证均匀分散到各 Worker）
let _workerCursor = 0;
function _pickWorker(pool) {
  if (!pool || !pool.available) return null;
  const healthy = pool.workers.filter(w => w.healthy);
  if (healthy.length === 0) return null;
  const w = healthy[_workerCursor % healthy.length];
  _workerCursor++;
  return w.url;
}

// 探测 1 个账号的全部 license 配额
// 返回: { account_id, email, status, license_id, license_idx, licenses: [{id, used, max, ok}], total_used, total_max, error? }
async function probeAccountQuota(account, pool) {
  const result = {
    account_id: account.id,
    email: account.email,
    status: account.status,
    license_id: account.license_id,
    license_idx: account.license_idx || 0,
    licenses: [],
    total_used: 0,
    total_max: 0,
  };

  const ids = (account.license_ids && account.license_ids.length) ? account.license_ids
            : (account.license_id ? [account.license_id] : []);
  if (ids.length === 0) { result.error = 'no_license'; return result; }

  let idToken = account.id_token;
  try {
    if (!idToken || Date.now() > (account.id_token_expires_at || 0) - 300000) {
      // 刷新 id_token 也走 Worker（避免 OAuth 端点限频）
      const refreshWorker = _pickWorker(pool);
      const tokens = await jb.refreshIdToken(account.refresh_token, refreshWorker);
      idToken = tokens.id_token;
    }
  } catch (err) {
    result.error = 'refresh_failed: ' + err.message;
    return result;
  }

  // 一个账号的多个 license 并发探测（每个 license 独立分配 Worker）
  // 旧版串行 5 license = 10 秒 → 并发 = 2 秒
  const licenseProbes = await Promise.all(ids.map(async (lid) => {
    for (let retry = 0; retry < 3; retry++) {
      const workerUrl = _pickWorker(pool);
      try {
        const r = await jb.provideAccess(idToken, lid, workerUrl);
        const q = await jb.getQuota(r.token, workerUrl);
        const used = parseFloat(q.current?.tariffQuota?.current?.amount || q.current?.current?.amount || 0);
        const max = parseFloat(q.current?.tariffQuota?.maximum?.amount || q.current?.maximum?.amount || 0);
        if (!isFinite(max) || max <= 0 || !isFinite(used) || used < 0 || used > max * 1.5) {
          return { id: lid, used: 0, max: 0, ok: false, error: 'invalid_quota' };
        }
        const usedClamped = Math.min(used, max);
        return { id: lid, used: usedClamped, max, ok: true };
      } catch (err) {
        if (err.message.includes('429') && retry < 2) {
          await new Promise(r => setTimeout(r, (retry + 1) * 2000));
          continue;
        }
        return { id: lid, used: 0, max: 0, ok: false, error: err.message };
      }
    }
    return { id: lid, used: 0, max: 0, ok: false, error: 'unknown' };
  }));
  for (const lp of licenseProbes) {
    result.licenses.push(lp);
    if (lp.ok) {
      result.total_used += lp.used;
      result.total_max += lp.max;
    }
  }
  return result;
}

// 并发池（限制并发数）
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 聚合配额：所有账号 + 所有 license（5 分钟缓存）
// 有 Worker 池 → 高并发（每 worker 8 路 = 总 8*N 路，上限 50）
// 无 Worker 池 → 低并发（3 路串行）避免被 JB 限频
async function buildQuotaSummary(forceRefresh = false) {
  if (!forceRefresh && _quotaCache.data && Date.now() - _quotaCache.ts < QUOTA_CACHE_TTL) {
    return { ..._quotaCache.data, cached: true, cached_age_sec: Math.floor((Date.now() - _quotaCache.ts) / 1000) };
  }

  const allAccounts = accountManager._getRaw();
  // 跳过死号：status='error' 永远拿不到配额；status='quota_exhausted' 当前 license 全废
  // 仅探测 active 账号；其它直接给空 license 数组（在 UI 上显示为灰色不可用）
  const skipped = allAccounts.filter(a => a.status !== 'active').map(a => ({
    account_id: a.id,
    email: a.email,
    status: a.status,
    license_id: a.license_id,
    license_idx: a.license_idx || 0,
    licenses: [],
    total_used: 0,
    total_max: 0,
    skipped: true,
  }));
  const toProbe = allAccounts.filter(a => a.status === 'active');

  const pool = (proxyPool && proxyPool.available) ? proxyPool : null;
  // 并发度：有 Worker 池 → 8 × Worker 数（上限 50），无池 → 3
  const concurrency = pool ? Math.min(pool.workers.filter(w => w.healthy).length * 8, 50) : 3;
  _workerCursor = 0;
  const probed = await runWithConcurrency(toProbe, concurrency, (a) => probeAccountQuota(a, pool));

  // 合并：探测结果 + 跳过的死号
  const combined = [...probed, ...skipped];

  const summary = {
    cached: false,
    generated_at: Date.now(),
    via_proxy: !!pool,
    proxy_workers: pool ? pool.workers.filter(w => w.healthy).length : 0,
    concurrency,
    total_accounts: allAccounts.length,
    probed_accounts: toProbe.length,
    skipped_accounts: skipped.length,
    active_accounts: toProbe.length,
    total_licenses: combined.reduce((sum, p) => sum + p.licenses.length, 0),
    healthy_licenses: combined.reduce((sum, p) => sum + p.licenses.filter(l => l.ok).length, 0),
    total_used: combined.reduce((sum, p) => sum + (p.total_used || 0), 0),
    total_max: combined.reduce((sum, p) => sum + (p.total_max || 0), 0),
    accounts: combined,
  };
  summary.total_remaining = summary.total_max - summary.total_used;

  _quotaCache = { ts: Date.now(), data: summary };
  return summary;
}

function invalidateQuotaCache() { _quotaCache = { ts: 0, data: null }; }

// ── CF 代理池状态 ──
let proxyPool = null;
const CF_SETTINGS_FILE = path.join(__dirname, '..', '..', 'cf_settings.json');

function loadCfSettings() {
  try { return JSON.parse(fs.readFileSync(CF_SETTINGS_FILE, 'utf-8')); }
  catch { return { api_token: '', account_id: '', workers_count: 1, ladder_proxy: '' }; }
}
function saveCfSettings(s) { fs.writeFileSync(CF_SETTINGS_FILE, JSON.stringify(s, null, 2)); }

router.get('/api/accounts', (req, res) => {
  res.json(accountManager.getAll());
});

// 一次性返回聚合配额：用于面板顶部统计 + 列表进度条
// ?force=1 强制刷新缓存
router.get('/api/accounts/quota-summary', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const data = await buildQuotaSummary(force);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/manual', async (req, res) => {
  const { refresh_token, license_id } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }
  try {
    const account = await accountManager.addManual(refresh_token, license_id || '');
    invalidateQuotaCache();
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/accounts/:id', (req, res) => {
  const ok = accountManager.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  invalidateQuotaCache();
  res.json({ ok: true });
});

router.post('/api/accounts/:id/license', async (req, res) => {
  const { license_id } = req.body;
  if (!license_id) return res.status(400).json({ error: 'license_id is required' });
  try {
    const account = await accountManager.updateLicenseId(req.params.id, license_id);
    invalidateQuotaCache();
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/:id/refresh', async (req, res) => {
  try {
    await accountManager.forceRefresh(req.params.id);
    invalidateQuotaCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/accounts/:id/quota', async (req, res) => {
  try {
    const quota = await accountManager.getQuotaForAccount(req.params.id);
    res.json(quota);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 批量导入（V2 激活器 / 手动推送） ──
// POST /api/import/batch-import/pre-activated
// Header: x-batch-import-api-key
// Body: { accounts: [{ email, refresh_token, license_id, ... }], dedupe: true }
router.post('/api/import/batch-import/pre-activated', async (req, res) => {
  const config = loadConfig();
  const importKey = config.batch_import_key;

  // 鉴权：如果配置了 batch_import_key 则校验
  if (importKey) {
    const reqKey = req.headers['x-batch-import-api-key'] || req.headers['x-api-key'];
    if (reqKey !== importKey) {
      return res.status(401).json({ error: 'Invalid batch import key' });
    }
  }

  const { accounts: items, dedupe } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'accounts array required' });
  }

  req.setTimeout(600000);
  res.setTimeout(600000);

  try {
    const result = await accountManager.batchImport(items, dedupe !== false, proxyPool);
    if (result.added > 0) invalidateQuotaCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 上游模型同步 ──
router.get('/api/models/info', (req, res) => {
  res.json(modelsCache.info());
});

router.post('/api/models/sync', async (req, res) => {
  try {
    const account = accountManager.getNext();
    if (!account) return res.status(503).json({ ok: false, error: '没有可用账号，请先添加账号' });
    const jwt = await accountManager.ensureValidJwt(account);
    const data = await modelsCache.syncFromJB(jwt, jb.getProfiles);
    res.json({
      ok: true,
      synced_at: data.synced_at,
      count: data.count,
      providers: data.models.reduce((m, x) => { m[x.provider] = (m[x.provider] || 0) + 1; return m; }, {}),
    });
  } catch (err) {
    console.error('POST /api/models/sync error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CF 代理池管理 ──
router.get('/api/cf/settings', (req, res) => {
  const s = loadCfSettings();
  res.json({ ...s, deployed: proxyPool && proxyPool.available ? proxyPool.statusDict() : null });
});

router.post('/api/cf/settings', (req, res) => {
  const { api_token, account_id, workers_count, ladder_proxy } = req.body;
  saveCfSettings({
    api_token: api_token || '', account_id: account_id || '',
    workers_count: Math.max(1, Math.min(workers_count || 1, 20)),
    ladder_proxy: ladder_proxy || '',
  });
  res.json({ ok: true });
});

router.post('/api/cf/deploy', async (req, res) => {
  const s = loadCfSettings();
  if (!s.api_token || !s.account_id) return res.status(400).json({ ok: false, error: '请先配置 API Token 和 Account ID' });
  try {
    if (proxyPool) await proxyPool.cleanup();
    proxyPool = new ProxyPool(s.api_token, s.account_id, s.ladder_proxy || '');
    const count = Math.max(1, Math.min(s.workers_count || 1, 10));
    const ok = await proxyPool.deploy(count);
    if (!ok) { proxyPool = null; return res.json({ ok: false, error: 'Workers 部署失败，请检查 API Token 和 Account ID' }); }
    const health = await proxyPool.healthCheck();
    res.json({ ok: true, status: proxyPool.statusDict(), health });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/api/cf/health', async (req, res) => {
  if (!proxyPool || !proxyPool.count) return res.json({ ok: false, error: '没有已部署的 Workers' });
  res.json({ ok: true, health: await proxyPool.healthCheck() });
});

router.post('/api/cf/cleanup', async (req, res) => {
  if (proxyPool) { await proxyPool.cleanup(); proxyPool = null; }
  res.json({ ok: true });
});

// POST /api/import/batch-import/raw
// 纯文本格式：每行 email----password（仅记录，不含 token，需后续手动补充）
router.post('/api/import/batch-import/raw', async (req, res) => {
  const config = loadConfig();
  const importKey = config.batch_import_key;

  if (importKey) {
    const reqKey = req.headers['x-batch-import-api-key'] || req.headers['x-api-key'];
    if (reqKey !== importKey) {
      return res.status(401).json({ error: 'Invalid batch import key' });
    }
  }

  const { text, dedupe } = req.body;
  if (!text) return res.status(400).json({ error: 'text field required' });

  // 解析 email----password 格式
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = lines.map(line => {
    const parts = line.split('----');
    return { email: parts[0], password: parts[1] || '' };
  });

  res.json({ parsed: parsed.length, note: 'Raw import only records email/password. Use pre-activated endpoint with tokens for full functionality.' });
});

// 启动时调用：根据 cf_settings.json 恢复 proxyPool 状态（不重新部署，只列出已有的）
async function restoreProxyPoolOnStartup() {
  const s = loadCfSettings();
  if (!s.api_token || !s.account_id) {
    console.log('[ProxyPool] No CF credentials, skip restore');
    return;
  }
  try {
    proxyPool = new ProxyPool(s.api_token, s.account_id, s.ladder_proxy || '');
    const n = await proxyPool.restoreFromCloud();
    if (n === 0) { proxyPool = null; return; }
    // 后台健康检查（不阻塞启动）
    proxyPool.healthCheck().then(() => {
      const healthy = proxyPool.workers.filter(w => w.healthy).length;
      console.log(`[ProxyPool] Health check: ${healthy}/${n} healthy`);
    });
  } catch (err) {
    console.warn('[ProxyPool] Restore failed:', err.message);
    proxyPool = null;
  }
}

module.exports = router;
module.exports.restoreProxyPoolOnStartup = restoreProxyPoolOnStartup;
