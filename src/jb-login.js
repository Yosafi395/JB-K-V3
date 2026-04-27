/**
 * jb-login.js — email+password → login → OAuth → refresh_token + license_ids
 * 支持直连和 CF Worker 代理两种模式。
 */
const crypto = require('crypto');
const { fetchViaWorker } = require('./proxy-pool');

const JB_BASE = 'https://account.jetbrains.com';
const JB_TOKEN_URL = 'https://oauth.account.jetbrains.com/oauth2/token';
const REDIRECT_URI = `${JB_BASE}/oauth2/ide/callback`;
const CLIENT_ID = 'ide';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Cookie Jar ──
class CookieJar {
  constructor() { this.cookies = new Map(); }
  // 从标准 fetch Response 更新
  updateFromFetch(res) {
    for (const c of (res.headers?.getSetCookie?.() ?? [])) {
      const [kv] = c.split(';');
      const eq = (kv || '').indexOf('=');
      if (eq !== -1) this.cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  // 从 Worker 代理 Response 更新
  updateFromWorker(res) {
    const SKIP = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
    for (const raw of (res._setCookies || [])) {
      // 每个 raw 可能是 "name=value; Path=/; ..." 或逗号拼接的多个
      for (const part of raw.split(/,(?=\s*\w+=)/)) {
        const [kv] = part.split(';');
        const eq = (kv || '').indexOf('=');
        if (eq === -1) continue;
        const name = kv.slice(0, eq).trim();
        if (SKIP.has(name.toLowerCase())) continue;
        if (name) this.cookies.set(name, kv.slice(eq + 1).trim());
      }
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  xsrf() {
    for (const [name, value] of this.cookies) {
      if (name.toLowerCase().includes('_st')) return value;
    }
    return '';
  }
}

// ── 统一 fetch 封装：直连 or Worker 代理 ──
async function pFetch(url, init, workerUrl) {
  if (!workerUrl) {
    // 直连：把 _cookies 放到 Cookie header
    if (init?._cookies) {
      const headers = { ...(init.headers || {}), Cookie: init._cookies };
      const { _cookies, ...rest } = init;
      return fetch(url, { ...rest, headers });
    }
    return fetch(url, init);
  }
  // Worker 代理
  return fetchViaWorker(workerUrl, url, init);
}

// pFetch + 429 auto-retry (exponential backoff)
async function pFetchRetry(url, init, workerUrl, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await pFetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(30000) }, workerUrl);
    const status = res.status ?? (res.ok ? 200 : 500);
    if (status === 429) {
      const retryAfter = Number(res.headers?.get?.('Retry-After') ?? res._rawHeaders?.['retry-after'] ?? 5);
      const wait = Math.min(retryAfter * Math.pow(2, attempt), 60) * 1000;
      console.log(`[429] ${url.slice(0, 60)}... waiting ${wait / 1000}s (${attempt + 1}/${maxRetries})`);
      await sleep(wait);
      continue;
    }
    return res;
  }
  throw new Error(`429 after ${maxRetries} retries: ${url.slice(0, 60)}`);
}

/**
 * 用 email + password 登录 JetBrains 并获取 tokens + license IDs。
 * @param {string} email
 * @param {string} password
 * @param {string|null} workerUrl  CF Worker URL（null = 直连）
 */
async function loginAndDiscover(email, password, workerUrl = null) {
  const jar = new CookieJar();
  const T = 30000;

  function updateJar(res) {
    if (workerUrl) jar.updateFromWorker(res);
    else jar.updateFromFetch(res);
  }

  async function jsonText(res) {
    return typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
  }

  // 1. 打开登录页（走 Worker，保持后续 step 2-4 IP 一致）
  const loginPage = await pFetchRetry(`${JB_BASE}/login`, {
    headers: { 'User-Agent': UA }, _cookies: jar.header(),
  }, workerUrl);
  updateJar(loginPage);

  const jsonH = () => ({
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': jar.xsrf(),
    'User-Agent': UA,
  });

  // 2. 创建 session
  const sesRes = await pFetchRetry(`${JB_BASE}/api/auth/sessions`, {
    method: 'POST', headers: jsonH(), body: '{}', _cookies: jar.header(),
  }, workerUrl);
  updateJar(sesRes);
  if (!sesRes.ok) throw new Error(`Session failed: ${sesRes.status}`);
  const { id: sid } = await jsonText(sesRes);

  // 3. 提交 email
  const emRes = await pFetchRetry(`${JB_BASE}/api/auth/sessions/${sid}/email/login`, {
    method: 'POST', headers: jsonH(), body: JSON.stringify({ email }), _cookies: jar.header(),
  }, workerUrl);
  updateJar(emRes);
  const emData = await jsonText(emRes);
  if (emData.state !== 'PASSWORD_REQUIRED') throw new Error(`Email state: ${emData.state}`);

  // 4. 提交 password
  const pwRes = await pFetchRetry(`${JB_BASE}/api/auth/sessions/${sid}/password`, {
    method: 'POST', headers: jsonH(), body: JSON.stringify({ password }), _cookies: jar.header(),
  }, workerUrl);
  updateJar(pwRes);
  if (!pwRes.ok) throw new Error(pwRes.status === 401 ? 'Wrong password' : `Password failed: ${pwRes.status}`);

  // 5. OAuth PKCE
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  let url = `${JB_BASE}/oauth/login?client_id=${CLIENT_ID}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid+offline_access+r_ide_auth` +
    `&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;

  // OAuth redirect 链（全走 Worker 保持 IP 一致）
  let code = null;
  for (let i = 0; i < 15; i++) {
    const r = await pFetch(url, {
      method: 'GET', headers: { 'User-Agent': UA },
      redirect: 'manual', _cookies: jar.header(),
    }, workerUrl);
    updateJar(r);
    const loc = r.headers?.get?.('location') ?? r._rawHeaders?.['location'] ?? '';
    if (loc.includes('ide/callback') && loc.includes('code=')) {
      code = new URL(loc.startsWith('http') ? loc : `${JB_BASE}${loc}`).searchParams.get('code');
      break;
    }
    if (!loc) break;
    url = loc.startsWith('http') ? loc : `${JB_BASE}${loc}`;
  }
  if (!code) throw new Error('OAuth code failed');

  // 6. 换 token（不走 Worker，直连即可）
  const tokRes = await pFetchRetry(JB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: codeVerifier,
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    }).toString(),
  }, null); // 直连
  if (!tokRes.ok) throw new Error(`Token exchange failed: ${tokRes.status}`);
  const tokens = await tokRes.json();
  if (!tokens.refresh_token) throw new Error('No refresh_token');

  // 7. 拿 license IDs（走 Worker）
  const licPage = await pFetchRetry(`${JB_BASE}/licenses`, {
    headers: { 'User-Agent': UA }, _cookies: jar.header(),
  }, workerUrl);
  const html = typeof licPage.text === 'function' ? await licPage.text() : '';
  const lids = [...new Set((html.match(/id="license-([A-Z0-9]{10})"/g) || []).map(m => m.match(/([A-Z0-9]{10})/)[1]))];

  return { refresh_token: tokens.refresh_token, id_token: tokens.id_token, license_ids: lids };
}

module.exports = { loginAndDiscover };
