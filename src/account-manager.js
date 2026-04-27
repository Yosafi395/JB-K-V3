const { v4: uuidv4 } = require('uuid');
const { loadCredentials, saveCredentials } = require('./config');
const jb = require('./jb-client');
const { loginAndDiscover } = require('./jb-login');

let accounts = [];
let roundRobinIndex = 0;
let refreshTimer = null;

function init() {
  accounts = loadCredentials();
  startRefreshLoop();
  console.log(`Account manager: loaded ${accounts.length} account(s)`);
}

function getAll() {
  return accounts.map(a => ({
    id: a.id,
    email: a.email,
    status: a.status,
    license_id: a.license_id,
    license_ids: a.license_ids || [],
    license_idx: a.license_idx || 0,
    added_at: a.added_at,
    last_used_at: a.last_used_at,
  }));
}

async function addFromOAuth(tokens, licenseId) {
  const { id_token, refresh_token } = tokens;
  if (!licenseId) throw new Error('License ID is required');

  const payload = jb.decodeJwtPayload(id_token);
  const email = payload.email || payload.preferred_username || 'unknown';

  const existing = accounts.find(a => a.email === email);
  if (existing) {
    existing.refresh_token = refresh_token;
    existing.id_token = id_token;
    existing.id_token_expires_at = (payload.exp || 0) * 1000;
    existing.license_id = licenseId;
    existing.status = 'active';
    await refreshJwt(existing);
    persist();
    return existing;
  }

  const userInfo = await jb.getUserInfo(id_token);
  if (!userInfo.ok) {
    await jb.registerGrazie(id_token);
  }

  const account = {
    id: uuidv4(),
    email,
    refresh_token,
    license_id: licenseId,
    id_token,
    id_token_expires_at: (payload.exp || 0) * 1000,
    jwt: null,
    jwt_expires_at: 0,
    status: 'active',
    added_at: Date.now(),
    last_used_at: null,
  };

  await refreshJwt(account);
  accounts.push(account);
  persist();
  return account;
}

async function addManual(refreshToken, licenseId) {
  if (!licenseId) throw new Error('License ID is required');

  const tokens = await jb.refreshIdToken(refreshToken);
  const payload = jb.decodeJwtPayload(tokens.id_token);
  const email = payload.email || payload.preferred_username || 'unknown';

  const existing = accounts.find(a => a.email === email);
  if (existing) {
    existing.refresh_token = tokens.refresh_token || refreshToken;
    existing.license_id = licenseId;
    existing.id_token = tokens.id_token;
    existing.id_token_expires_at = (payload.exp || 0) * 1000;
    existing.status = 'active';
    await refreshJwt(existing);
    persist();
    return existing;
  }

  const userInfo = await jb.getUserInfo(tokens.id_token);
  if (!userInfo.ok) {
    await jb.registerGrazie(tokens.id_token);
  }

  const account = {
    id: uuidv4(),
    email,
    refresh_token: tokens.refresh_token || refreshToken,
    license_id: licenseId,
    id_token: tokens.id_token,
    id_token_expires_at: (payload.exp || 0) * 1000,
    jwt: null,
    jwt_expires_at: 0,
    status: 'active',
    added_at: Date.now(),
    last_used_at: null,
  };

  await refreshJwt(account);
  accounts.push(account);
  persist();
  return account;
}

// 批量导入账号（并发，默认 5 路同时）
// 支持两种模式：
//   1. 有 refresh_token + license_id → 直接导入
//   2. 只有 email + password → 自动登录拿 token + license_ids
// proxyPool: 可选的 ProxyPool 实例（有 = 并发走 Worker，无 = 串行直连）
async function batchImport(items, dedupe = true, proxyPool = null) {
  const results = { added: 0, skipped: 0, failed: 0, details: [] };

  // 先过滤去重
  const toProcess = [];
  for (const item of items) {
    const email = item.email || 'unknown';
    if (dedupe && accounts.find(a => a.email === email)) {
      results.skipped++;
      results.details.push({ email, status: 'skipped' });
    } else {
      toProcess.push(item);
    }
  }

  const needLogin = toProcess.some(i => !i.refresh_token && i.password);
  const hasProxy = proxyPool && proxyPool.available;

  // 单个账号的登录处理
  async function loginOne(item, groupId) {
    const email = item.email || 'unknown';
    try {
      let rt = item.refresh_token;
      let allLids = item.licenseIds || (item.license_id ? [item.license_id] : []);

      if (!rt && item.password) {
        const workerUrl = hasProxy ? proxyPool.getWorkerUrl(groupId) : null;
        const lr = await loginAndDiscover(email, item.password, workerUrl);
        rt = lr.refresh_token;
        allLids = lr.license_ids;
      }

      if (!rt) throw new Error('No refresh_token (no password provided)');
      if (!allLids[0]) throw new Error('No license found (not activated?)');
      return { email, rt, allLids, ok: true };
    } catch (err) {
      return { email, ok: false, error: err.message };
    }
  }

  let loginResults;

  if (needLogin && hasProxy) {
    // ── 有 CF 代理池：并发（每 5 个一组，分配到不同 Worker） ──
    const CONCURRENCY = Math.min(proxyPool.count * 3, 10);
    console.log(`[import] Concurrent mode: ${CONCURRENCY} parallel, ${proxyPool.count} workers`);
    loginResults = [];
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const chunk = toProcess.slice(i, i + CONCURRENCY);
      const batch = await Promise.all(chunk.map((item, j) => loginOne(item, i + j)));
      loginResults.push(...batch);
    }
  } else if (needLogin) {
    // ── 无代理：串行 + 2 秒间隔 ──
    console.log(`[import] Serial mode: 2s interval`);
    loginResults = [];
    for (let i = 0; i < toProcess.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      console.log(`[import] (${i + 1}/${toProcess.length}) ${toProcess[i].email}...`);
      loginResults.push(await loginOne(toProcess[i], 0));
    }
  } else {
    // ── 已有 token：直接处理 ──
    loginResults = toProcess.map(item => {
      const allLids = item.licenseIds || (item.license_id ? [item.license_id] : []);
      return { email: item.email, rt: item.refresh_token, allLids, ok: !!item.refresh_token };
    });
  }

  // 串行写入 addManual
  for (const lr of loginResults) {
    if (!lr.ok) {
      results.failed++;
      results.details.push({ email: lr.email, status: 'error', error: lr.error || 'missing token' });
      continue;
    }
    try {
      const account = await addManual(lr.rt, lr.allLids[0]);
      if (lr.allLids.length > 1) {
        account.license_ids = lr.allLids;
        account.license_idx = 0;
        persist();
      }
      results.added++;
      results.details.push({ email: lr.email, status: 'ok', licenses: lr.allLids.length });
      console.log(`[import] ${lr.email}: OK (${lr.allLids.length} licenses)`);
    } catch (err) {
      results.failed++;
      results.details.push({ email: lr.email, status: 'error', error: err.message });
    }
  }

  return results;
}

function remove(id) {
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  accounts.splice(idx, 1);
  persist();
  return true;
}

function getNext(excludeIds = []) {
  const active = accounts.filter(a => a.status === 'active' && !excludeIds.includes(a.id));
  if (active.length === 0) return null;
  const account = active[roundRobinIndex % active.length];
  roundRobinIndex++;
  account.last_used_at = Date.now();
  return account;
}

// 477 配额耗尽时调用：先切同账号的下一个 licenseId，全用完才标记 exhausted
async function markQuotaExhausted(account) {
  const ids = account.license_ids || [];
  const curIdx = account.license_idx || 0;

  // 尝试切到下一个 licenseId
  for (let i = 1; i < ids.length; i++) {
    const nextIdx = (curIdx + i) % ids.length;
    try {
      account.license_id = ids[nextIdx];
      account.license_idx = nextIdx;
      await refreshJwt(account);
      console.log(`[quota] ${account.email}: switched to license ${ids[nextIdx]} (${nextIdx + 1}/${ids.length})`);
      persist();
      return true; // 切换成功，账号仍 active
    } catch {}
  }

  // 所有 licenseId 都不行了
  account.status = 'quota_exhausted';
  account.exhausted_at = Date.now();
  console.log(`[quota] ${account.email}: all ${ids.length || 1} licenses exhausted`);
  persist();
  return false; // 账号已 exhausted
}

async function ensureValidJwt(account) {
  const now = Date.now();

  if (!account.id_token || now > account.id_token_expires_at - 300000) {
    try {
      const tokens = await jb.refreshIdToken(account.refresh_token);
      account.id_token = tokens.id_token;
      if (tokens.refresh_token) account.refresh_token = tokens.refresh_token;
      const payload = jb.decodeJwtPayload(tokens.id_token);
      account.id_token_expires_at = (payload.exp || 0) * 1000;
    } catch (err) {
      account.status = 'error';
      persist();
      throw new Error(`Failed to refresh id_token for ${account.email}: ${err.message}`);
    }
  }

  if (!account.jwt || now > account.jwt_expires_at - 1800000) {
    await refreshJwt(account);
  }

  persist();
  return account.jwt;
}

async function refreshJwt(account) {
  try {
    const result = await jb.provideAccess(account.id_token, account.license_id);
    if (!result.token) throw new Error('No token in provide-access response');
    account.jwt = result.token;
    const jwtPayload = jb.decodeJwtPayload(result.token);
    account.jwt_expires_at = (jwtPayload.exp || 0) * 1000;
    account.status = 'active';
  } catch (err) {
    account.status = 'error';
    persist();
    throw new Error(`Failed to get JWT for ${account.email}: ${err.message}`);
  }
}

async function updateLicenseId(id, licenseId) {
  const account = accounts.find(a => a.id === id);
  if (!account) throw new Error('Account not found');
  account.license_id = licenseId;
  const now = Date.now();
  if (!account.id_token || now > account.id_token_expires_at - 300000) {
    const tokens = await jb.refreshIdToken(account.refresh_token);
    account.id_token = tokens.id_token;
    if (tokens.refresh_token) account.refresh_token = tokens.refresh_token;
    const payload = jb.decodeJwtPayload(tokens.id_token);
    account.id_token_expires_at = (payload.exp || 0) * 1000;
  }
  await refreshJwt(account);
  persist();
  return account;
}

async function forceRefresh(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) throw new Error('Account not found');
  await ensureValidJwt(account);
  persist();
  return account;
}

async function getQuotaForAccount(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) throw new Error('Account not found');
  const jwt = await ensureValidJwt(account);
  return jb.getQuota(jwt);
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    for (const account of accounts) {
      // 正常刷新 active 账号的 JWT
      if (account.status === 'active') {
        try {
          await ensureValidJwt(account);
        } catch (err) {
          console.error(`Auto-refresh failed for ${account.email}: ${err.message}`);
        }
        continue;
      }

      // 每日自动恢复 quota_exhausted 账号（JB 配额每日重置）
      if (account.status === 'quota_exhausted' && account.exhausted_at) {
        const hoursSince = (Date.now() - account.exhausted_at) / 3600000;
        if (hoursSince >= 24) {
          console.log(`[quota] Attempting daily recovery for ${account.email}...`);
          // 重置到第一个 licenseId 重新尝试
          account.license_idx = 0;
          if (account.license_ids && account.license_ids.length > 0) {
            account.license_id = account.license_ids[0];
          }
          try {
            await ensureValidJwt(account);
            account.status = 'active';
            account.exhausted_at = null;
            console.log(`[quota] ${account.email}: recovered!`);
            persist();
          } catch (err) {
            console.log(`[quota] ${account.email}: still unavailable (${err.message})`);
          }
        }
      }
    }
  }, 600000);
}

function persist() {
  saveCredentials(accounts);
}

// 内部使用：返回内存中完整的账号数组（含 refresh_token 等敏感字段）
// 仅供同进程内 panel-api 使用，不可经 HTTP 暴露
function _getRaw() { return accounts; }

module.exports = {
  init, getAll, addFromOAuth, addManual, batchImport, remove, updateLicenseId,
  getNext, ensureValidJwt, forceRefresh, getQuotaForAccount, markQuotaExhausted,
  _getRaw,
};
