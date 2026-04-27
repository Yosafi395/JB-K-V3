/**
 * proxy-pool.js — CF Workers 代理池（CJS 版）
 * 搬自 GhostReg Python/ESM 实现。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');

const WORKERS_JS = path.join(__dirname, '..', 'workers', 'ghostreg_proxy.js');

// 应用级 ladder_proxy 状态：
// Node 内置 fetch 不接受外部 undici 的 dispatcher 选项（UND_ERR_INVALID_ARG），
// 必须用 setGlobalDispatcher 替换全局 agent 才能让 fetch 走梯子。
let _origDispatcher = null;       // 备份默认 dispatcher，以便清空时恢复
let _currentLadder = null;        // 当前生效的梯子地址
function applyLadderProxy(ladderProxy) {
  if (ladderProxy === _currentLadder) return;
  if (!_origDispatcher) _origDispatcher = getGlobalDispatcher();
  if (ladderProxy) {
    setGlobalDispatcher(new ProxyAgent(ladderProxy));
  } else {
    setGlobalDispatcher(_origDispatcher);
  }
  _currentLadder = ladderProxy || null;
}

class ProxyPool {
  // ladderProxy: 形如 'http://127.0.0.1:7890'，用于本进程访问 api.cloudflare.com / *.workers.dev
  constructor(apiToken, accountId, ladderProxy = '') {
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.ladderProxy = ladderProxy || '';
    applyLadderProxy(this.ladderProxy);
    this.workers = [];
    this._subdomain = '';
  }

  // 兼容旧调用点（_fetchOpts 现在不需要 dispatcher，全局已设置）
  get _fetchOpts() { return {}; }

  get _headers() { return { Authorization: `Bearer ${this.apiToken}` }; }

  // 部署到目标数量 N（增量模式）：
  //   N > 当前 → 只新部署缺的几个（保留已有）
  //   N < 当前 → 删除多余的（从尾部开始）
  //   N = 当前 → 健康检查并刷新一遍
  async deploy(targetCount = 1) {
    let script;
    try { script = fs.readFileSync(WORKERS_JS, 'utf-8'); } catch {
      console.error('[ProxyPool] workers/ghostreg_proxy.js not found');
      return false;
    }
    this._subdomain = await this._getSubdomain();
    if (!this._subdomain) { console.error('[ProxyPool] Cannot get workers.dev subdomain'); return false; }

    const cur = this.workers.length;

    // 缩容：删除尾部多余的
    if (targetCount < cur) {
      const toRemove = this.workers.splice(targetCount);
      for (const w of toRemove) {
        try {
          await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/scripts/${w.name}`,
            { method: 'DELETE', headers: this._headers, signal: AbortSignal.timeout(10000), ...this._fetchOpts });
          console.log(`[ProxyPool] Removed: ${w.name}`);
        } catch (e) { console.warn(`[ProxyPool] Remove ${w.name} failed:`, e.message); }
      }
      return this.workers.length > 0;
    }

    // 扩容：从 cur 开始新部署到 targetCount
    let ok = cur;
    for (let i = cur; i < targetCount; i++) {
      const name = `ghostreg-p${i}`;
      if (await this._deployOne(name, script)) {
        const url = `https://${name}.${this._subdomain}.workers.dev`;
        this.workers.push({ name, url, healthy: true });
        console.log(`[ProxyPool] Worker #${i} deployed: ${url}`);
        ok++;
      } else {
        console.error(`[ProxyPool] Worker #${i} deploy failed`);
      }
    }
    console.log(`[ProxyPool] Total: ${ok}/${targetCount} workers`);
    return ok > 0;
  }

  // 启动时调用：从 CF 列出已存在的 ghostreg-p* Workers 并恢复实例（不重新部署）
  async restoreFromCloud() {
    this._subdomain = await this._getSubdomain();
    if (!this._subdomain) { return 0; }
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/scripts`,
        { headers: this._headers, signal: AbortSignal.timeout(15000), ...this._fetchOpts },
      );
      const data = await r.json();
      if (!data.success) { console.warn('[ProxyPool] restoreFromCloud: list failed'); return 0; }
      const scripts = (data.result || [])
        .filter(s => s.id && s.id.startsWith('ghostreg-p'))
        .sort((a, b) => {
          const ai = parseInt(a.id.replace('ghostreg-p', '')) || 0;
          const bi = parseInt(b.id.replace('ghostreg-p', '')) || 0;
          return ai - bi;
        });
      this.workers = scripts.map(s => ({
        name: s.id,
        url: `https://${s.id}.${this._subdomain}.workers.dev`,
        healthy: true, // 后续 healthCheck 会修正
      }));
      console.log(`[ProxyPool] Restored ${this.workers.length} worker(s) from CF`);
      return this.workers.length;
    } catch (e) {
      console.warn('[ProxyPool] restoreFromCloud error:', e.message);
      return 0;
    }
  }

  async _deployOne(name, script) {
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/scripts/${name}`;
    const metadata = JSON.stringify({ main_module: 'worker.js', bindings: [] });
    const boundary = '----CFBoundary' + crypto.randomBytes(8).toString('hex');
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${script}\r\n`,
      `--${boundary}--\r\n`,
    ];
    try {
      const r = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...this._headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.from(parts.join(''), 'utf-8'),
        signal: AbortSignal.timeout(30000),
        ...this._fetchOpts,
      });
      const data = await r.json();
      if ((r.status === 200 || r.status === 201) && data.success) {
        await fetch(`${apiUrl}/subdomain`, {
          method: 'POST',
          headers: { ...this._headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
          signal: AbortSignal.timeout(10000),
          ...this._fetchOpts,
        });
        return true;
      }
      console.error(`[ProxyPool] Deploy ${name} failed:`, JSON.stringify(data.errors || data).slice(0, 300));
    } catch (e) { console.error(`[ProxyPool] Deploy ${name} error:`, e.message); }
    return false;
  }

  async _getSubdomain() {
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/subdomain`,
        { headers: this._headers, signal: AbortSignal.timeout(10000), ...this._fetchOpts },
      );
      return (await r.json())?.result?.subdomain || '';
    } catch (e) { console.error('[ProxyPool] Get subdomain error:', e.message); return ''; }
  }

  getWorkerUrl(groupId = 0) {
    if (!this.workers.length) return null;
    const w = this.workers[groupId % this.workers.length];
    return w.healthy ? w.url : null;
  }

  async healthCheck() {
    const results = {};
    for (const w of this.workers) {
      try {
        // workers.dev 在国内被墙，必须走梯子
        const r = await fetch(`${w.url}/health`, { signal: AbortSignal.timeout(10000), ...this._fetchOpts });
        if (r.ok) {
          const data = await r.json();
          w.healthy = data?.status === 'ok';
        } else { w.healthy = false; }
        results[w.name] = { healthy: w.healthy, url: w.url };
      } catch (e) {
        w.healthy = false;
        results[w.name] = { healthy: false, error: e.message };
      }
    }
    return results;
  }

  async cleanup() {
    for (const w of this.workers) {
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/scripts/${w.name}`,
          { method: 'DELETE', headers: this._headers, signal: AbortSignal.timeout(10000), ...this._fetchOpts },
        );
        console.log(`[ProxyPool] Deleted: ${w.name}`);
      } catch (e) { console.warn(`[ProxyPool] Delete ${w.name} failed:`, e.message); }
    }
    this.workers = [];
  }

  get available() { return this.workers.some(w => w.healthy); }
  get count() { return this.workers.length; }

  statusDict() {
    return {
      deployed: this.count,
      healthy: this.workers.filter(w => w.healthy).length,
      workers: this.workers.map(w => ({ name: w.name, url: w.url, healthy: w.healthy })),
    };
  }
}

// ── 通过 Worker /proxy 转发 fetch ──
// 注：是否走梯子由全局 dispatcher 决定（applyLadderProxy 设置）
async function fetchViaWorker(workerUrl, targetUrl, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const headers = init.headers || {};
  const cookies = init._cookies || '';

  const payload = { target_url: targetUrl, method, headers, cookies };
  if (init.redirect === 'manual') payload.redirect = 'manual';

  if (method !== 'GET' && method !== 'HEAD' && init.body != null) {
    const bodyStr = typeof init.body === 'string' ? init.body : init.body.toString();
    try { payload.json_body = JSON.parse(bodyStr); } catch { payload.body = bodyStr; }
  }

  const r = await fetch(`${workerUrl}/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: init.signal || AbortSignal.timeout(30000),
  });

  if (!r.ok) {
    let detail = ''; try { detail = (await r.text()).slice(0, 200); } catch {}
    throw new Error(`Worker proxy HTTP ${r.status}: ${detail}`);
  }

  const wd = await r.json();
  const innerHeaders = new Headers();
  if (wd.headers) for (const [k, v] of Object.entries(wd.headers)) innerHeaders.set(k, v);

  return {
    status: wd.status || 0,
    ok: wd.status >= 200 && wd.status < 300,
    headers: innerHeaders,
    _rawHeaders: wd.headers || {},
    text: async () => wd.body || '',
    json: async () => JSON.parse(wd.body || '{}'),
    _setCookies: Array.isArray(wd.headers?.['set-cookie'])
      ? wd.headers['set-cookie']
      : String(wd.headers?.['set-cookie'] ?? '').split(/,(?=\s*\w+=)/).map(s => s.trim()).filter(Boolean),
  };
}

module.exports = { ProxyPool, fetchViaWorker, applyLadderProxy };
