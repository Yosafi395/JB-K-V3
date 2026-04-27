// 全局缓存：从 quota-summary 拿到的每账号配额，用于列表渲染时同步显示进度条
let _quotaByAccount = {};

document.addEventListener('DOMContentLoaded', async () => {
  // Check panel auth
  const res = await fetch('/api/accounts');
  if (res.status === 401) {
    location.href = '/panel/login.html';
    return;
  }
  // 先加载列表（快），同时后台触发聚合配额查询（慢，10-30 秒）
  loadAccounts();
  loadQuotaSummary(false);
  loadSyncInfo();
});

// ── 模型同步 ──
async function loadSyncInfo() {
  try {
    const r = await fetch('/api/models/info');
    const d = await r.json();
    const badge = document.getElementById('syncBadge');
    if (!d.synced) {
      badge.textContent = '未同步（使用兜底列表）';
      badge.style.color = '#dc2626';
    } else {
      const date = new Date(d.synced_at);
      badge.textContent = `已同步 ${d.count} 个模型 · ${date.toLocaleString()}`;
      badge.style.color = '#16a34a';
    }
  } catch {}
}

async function syncModels(btn) {
  const msg = document.getElementById('syncMsg');
  msg.style.color = '#64748b';
  msg.textContent = '同步中（从 JB 拉取上游列表）...';
  await withLoading(btn, '同步中...', async () => {
    try {
      const r = await fetch('/api/models/sync', { method: 'POST' });
      const d = await r.json();
      if (!d.ok) { msg.style.color = '#dc2626'; msg.textContent = '同步失败: ' + (d.error || '未知错误'); return; }
      const provText = Object.entries(d.providers).map(([k, v]) => `${k} ${v}`).join(' · ');
      msg.style.color = '#16a34a';
      msg.textContent = `同步成功！共 ${d.count} 个模型 (${provText})`;
      loadSyncInfo();
    } catch (err) {
      msg.style.color = '#dc2626';
      msg.textContent = '同步失败: ' + err.message;
    }
  });
}

// 千分位 + 单位
function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtTokenK(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('en-US');
}

// 加载/刷新顶部聚合统计 + 列表进度条数据
//   force=true  → 后端跳过缓存重新探测（点立即重新探测时用）
//   force=false → 优先用 5 分钟内的缓存
async function loadQuotaSummary(force = false) {
  const status = document.getElementById('sum-status');
  status.textContent = force ? '正在重新探测全部 license 配额...' : '正在加载配额（最多 30 秒）...';
  try {
    const res = await fetch('/api/accounts/quota-summary' + (force ? '?force=1' : ''));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '加载失败');

    // 顶部统计
    document.getElementById('sum-accounts').textContent = d.total_accounts;
    document.getElementById('sum-accounts-sub').textContent = `${d.active_accounts} 个 active / ${d.total_licenses} 份 license`;

    document.getElementById('sum-max').textContent = fmtTokenK(d.total_max);
    document.getElementById('sum-max-sub').textContent = fmtNum(d.total_max) + ' tokens';

    document.getElementById('sum-used').textContent = fmtTokenK(d.total_used);
    const usedPct = d.total_max > 0 ? (d.total_used / d.total_max * 100) : 0;
    document.getElementById('sum-used-sub').textContent = usedPct.toFixed(2) + '%';

    document.getElementById('sum-remaining').textContent = fmtTokenK(d.total_remaining);
    document.getElementById('sum-remaining-sub').textContent = (d.healthy_licenses) + ' 份健康 license';

    document.getElementById('sum-bar').style.width = usedPct + '%';

    let viaInfo = '';
    if (d.via_proxy) viaInfo = ` · 走 ${d.proxy_workers} Workers 代理 · ${d.concurrency} 路并发`;
    else viaInfo = ` · 直连 · ${d.concurrency || 3} 路并发`;
    if (d.cached) {
      status.textContent = `缓存（${d.cached_age_sec} 秒前）${viaInfo}`;
    } else {
      status.textContent = `已更新 ${new Date(d.generated_at).toLocaleTimeString()}${viaInfo}`;
    }

    // 把每账号配额存到全局，供列表渲染同步
    _quotaByAccount = {};
    for (const a of (d.accounts || [])) {
      _quotaByAccount[a.account_id] = a;
    }
    // 列表已经渲染过的话，把进度条补上
    renderQuotaIntoList();
  } catch (err) {
    status.innerHTML = '<span style="color:#dc2626">加载失败: ' + esc(err.message) + '</span>';
  }
}

// 把全局缓存的每账号配额渲染进每行的进度条位置
function renderQuotaIntoList() {
  for (const id in _quotaByAccount) {
    const el = document.getElementById('quota-' + id);
    if (!el) continue;
    const a = _quotaByAccount[id];
    if (a.error) {
      el.innerHTML = `<span class="muted">配额不可用 (${esc(a.error)})</span>`;
      continue;
    }
    const used = a.total_used || 0;
    const max = a.total_max || 0;
    const pct = max > 0 ? (used / max * 100) : 0;
    const remaining = max - used;
    const licenseDots = a.licenses.map(l => {
      // 0-50% 绿 / 50-90% 黄 / ≥90% 红 / 不可用 灰
      let c;
      if (!l.ok || !l.max) c = '#94a3b8';
      else {
        const ratio = l.used / l.max;
        c = ratio < 0.5 ? '#16a34a' : (ratio < 0.9 ? '#f59e0b' : '#dc2626');
      }
      const title = l.ok ? `${l.id}: ${fmtNum(l.used)} / ${fmtNum(l.max)}` : `${l.id}: ${l.error || 'ERROR'}`;
      return `<span title="${esc(title)}" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:2px"></span>`;
    }).join('');
    el.innerHTML = `
      <div class="account-meta" style="margin-top:6px">
        <span>${fmtTokenK(used)} / ${fmtTokenK(max)} (${pct.toFixed(1)}%)</span>
        <span style="margin-left:8px">${licenseDots}</span>
        <span class="muted" style="margin-left:6px">剩 ${fmtTokenK(remaining)}</span>
      </div>
      <div class="quota-bar"><div class="quota-fill" style="width:${Math.min(pct,100)}%;background:${pct < 50 ? '#22c55e' : pct < 90 ? '#f59e0b' : '#dc2626'}"></div></div>`;
  }
}

// 通用：给按钮加 loading 状态
async function withLoading(btn, text, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function loadAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const res = await fetch('/api/accounts');
    const accounts = await res.json();

    if (accounts.length === 0) {
      container.innerHTML = '<p class="muted">暂无账号</p>';
      return;
    }

    container.innerHTML = accounts.map(acc => `
      <div class="account-row">
        <div class="account-info">
          <div class="account-email">${esc(acc.email)}</div>
          <div class="account-meta">
            <span class="status status-${acc.status}">${statusText(acc.status)}</span>
            <span>${esc(acc.license_id || '')}${acc.license_ids?.length > 1 ? ` (${acc.license_idx + 1}/${acc.license_ids.length})` : ''}</span>
          </div>
          <div id="quota-${acc.id}"><span class="muted" style="font-size:11px">配额加载中...</span></div>
        </div>
        <div class="account-actions">
          <button class="btn-sm" onclick="withLoading(this,'刷新中...',()=>refreshAccount('${acc.id}'))">刷新</button>
          <button class="btn-danger" onclick="deleteAccount(this,'${acc.id}')">删除</button>
        </div>
      </div>`).join('');

    // 列表渲染好后，如果已经有聚合数据缓存就立刻填进度条
    renderQuotaIntoList();
  } catch (err) {
    container.innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
  }
}

function statusText(s) {
  const map = { active: '正常', error: '异常', quota_exhausted: '配额耗尽' };
  return map[s] || s;
}

async function refreshAccount(id) {
  try {
    await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
    await loadAccounts();
    loadQuotaSummary(true); // 刷新后强制重新探测配额
  } catch (err) {
    alert('刷新失败: ' + err.message);
  }
}

async function deleteAccount(btn, id) {
  if (!confirm('确定删除该账号？')) return;
  await withLoading(btn, '删除中...', async () => {
    try {
      await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      await loadAccounts();
      loadQuotaSummary(true); // 删除后立即重新统计
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  });
}

async function startOAuth() {
  try {
    const res = await fetch('/auth/start');
    const data = await res.json();
    document.getElementById('oauth-url').href = data.url;
    document.getElementById('oauth-form').classList.remove('hidden');
    document.getElementById('manual-form').classList.add('hidden');
  } catch (err) {
    alert('启动登录失败: ' + err.message);
  }
}

async function submitOAuthCallback(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  await withLoading(btn, '添加中...', async () => {
    const callbackUrl = document.getElementById('oauth-callback').value.trim();
    const licenseId = document.getElementById('oauth-license').value.trim();
    const res = await fetch('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_url: callbackUrl, license_id: licenseId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    hideOAuthForm();
    await loadAccounts();
    loadQuotaSummary(true); // 新加账号 → 立即重新统计
  }).catch(err => alert('添加失败: ' + err.message));
}

function hideOAuthForm() {
  document.getElementById('oauth-form').classList.add('hidden');
  document.getElementById('oauth-callback').value = '';
  document.getElementById('oauth-license').value = '';
}

function showManualForm() {
  document.getElementById('manual-form').classList.remove('hidden');
  document.getElementById('oauth-form').classList.add('hidden');
}

function hideManualForm() {
  document.getElementById('manual-form').classList.add('hidden');
}

async function addManual(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  await withLoading(btn, '添加中...', async () => {
    const rt = document.getElementById('manual-rt').value.trim();
    const lid = document.getElementById('manual-lid').value.trim();
    const res = await fetch('/api/accounts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt, license_id: lid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    hideManualForm();
    document.getElementById('manual-rt').value = '';
    document.getElementById('manual-lid').value = '';
    await loadAccounts();
    loadQuotaSummary(true); // 手动导入后 → 立即重新统计
  }).catch(err => alert('添加失败: ' + err.message));
}

// ── 批量导入 ──
function showBatchForm() {
  document.getElementById('batch-form').classList.remove('hidden');
  document.getElementById('oauth-form').classList.add('hidden');
  document.getElementById('manual-form').classList.add('hidden');
}

function hideBatchForm() {
  document.getElementById('batch-form').classList.add('hidden');
  document.getElementById('batch-json').value = '';
  document.getElementById('batch-msg').textContent = '';
}

// 智能解析：自动检测 JSON / email----password / email password / email,password / JSON对象数组 等格式
function smartParseAccounts(raw) {
  // 1. 尝试 JSON 数组
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 支持 [{email, password, refresh_token, ...}] 或 [{email, refresh_token, license_id}]
      const items = parsed.filter(o => o && (o.email || o.mail));
      if (items.length > 0) return { items: items.map(o => ({ ...o, email: o.email || o.mail })), format: 'JSON数组' };
    }
  } catch {}

  // 2. 按行解析文本
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  const items = [];

  for (const line of lines) {
    // 跳过 JSON 片段行（花括号、方括号、逗号结尾的纯结构行）
    if (/^[{}\[\],]+$/.test(line)) continue;
    // 跳过 "task_id" / "success" / "elapsed" 等 JSON 字段行
    if (/^\s*"(task_id|success|error|elapsed|timestamp)"/.test(line)) continue;

    let email = '', password = '';

    // 尝试从 JSON 对象行提取 {"email":"...", "password":"..."}
    if (line.includes('"email"')) {
      try {
        let jsonStr = line;
        // 去掉行尾逗号
        if (jsonStr.endsWith(',')) jsonStr = jsonStr.slice(0, -1);
        // 尝试补全花括号
        if (!jsonStr.startsWith('{')) jsonStr = '{' + jsonStr;
        if (!jsonStr.endsWith('}')) jsonStr = jsonStr + '}';
        const obj = JSON.parse(jsonStr);
        if (obj.email) { items.push(obj); continue; }
      } catch {}
    }

    // email----password
    if (line.includes('----')) {
      const parts = line.split('----');
      email = parts[0].trim();
      password = parts[1]?.trim() || '';
    }
    // email:::password 或 email::password
    else if (line.includes(':::') || line.includes('::')) {
      const sep = line.includes(':::') ? ':::' : '::';
      const parts = line.split(sep);
      email = parts[0].trim();
      password = parts[1]?.trim() || '';
    }
    // email:password (但不匹配 http:// 或含@前的冒号)
    else if (line.includes(':') && line.includes('@') && !line.includes('://')) {
      const atIdx = line.indexOf('@');
      const colonIdx = line.indexOf(':', atIdx);
      if (colonIdx > atIdx) {
        email = line.slice(0, colonIdx).trim();
        password = line.slice(colonIdx + 1).trim();
      }
    }
    // Tab 分隔
    else if (line.includes('\t')) {
      const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) { email = parts[0]; password = parts[1]; }
    }
    // 逗号分隔 (email,password)
    else if (line.includes(',') && line.includes('@')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 2 && parts[0].includes('@')) { email = parts[0]; password = parts[1]; }
    }
    // 管道符分隔
    else if (line.includes('|')) {
      const parts = line.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) { email = parts[0]; password = parts[1]; }
    }
    // 空格分隔（email password）
    else if (line.includes(' ') && line.includes('@')) {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 2 && parts[0].includes('@')) { email = parts[0]; password = parts[1]; }
    }
    // 单独一个邮箱
    else if (line.includes('@') && !line.includes(' ')) {
      email = line;
    }

    if (email && email.includes('@')) {
      items.push({ email, password });
    }
  }

  if (items.length === 0) return null;
  return { items, format: '文本解析' };
}

async function batchImport(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = document.getElementById('batch-msg');
  const raw = document.getElementById('batch-json').value.trim();
  const dedupe = document.getElementById('batch-dedupe').checked;

  if (!raw) { msg.style.color = '#dc2626'; msg.textContent = '请输入数据'; return; }

  const parsed = smartParseAccounts(raw);
  if (!parsed || parsed.items.length === 0) {
    msg.style.color = '#dc2626';
    msg.textContent = '无法识别格式，请检查输入内容';
    return;
  }

  const hasTokens = parsed.items.some(i => i.refresh_token);
  msg.style.color = '#64748b';
  msg.textContent = `检测到 ${parsed.items.length} 个账号 (${parsed.format})${hasTokens ? '' : ' [将自动登录获取凭证]'}，导入中...`;

  await withLoading(btn, '导入中...', async () => {
    const res = await fetch('/api/import/batch-import/pre-activated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: parsed.items, dedupe }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.style.color = '#166534';
    msg.textContent = `完成: 新增 ${data.added}, 跳过 ${data.skipped}, 失败 ${data.failed}`;
    if (data.added > 0) {
      await loadAccounts();
      loadQuotaSummary(true); // 批量导入完成 → 重新探测全部配额
    }
  }).catch(err => {
    msg.style.color = '#dc2626';
    msg.textContent = '导入失败: ' + err.message;
  });
}

// ── CF 代理池 ──
function showCfPanel() {
  const p = document.getElementById('cf-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) cfLoadSettings();
}

async function cfLoadSettings() {
  try {
    const r = await fetch('/api/cf/settings');
    const d = await r.json();
    document.getElementById('cfApiToken').value = d.api_token || '';
    document.getElementById('cfAccountId').value = d.account_id || '';
    document.getElementById('cfCount').value = d.workers_count || 3;
    document.getElementById('cfLadder').value = d.ladder_proxy || '';
    if (d.deployed) {
      cfBadge(true, d.deployed.healthy + '/' + d.deployed.deployed + ' Workers');
    }
  } catch {}
}

async function cfDeploy(btn) {
  const token = document.getElementById('cfApiToken').value.trim();
  const accountId = document.getElementById('cfAccountId').value.trim();
  const count = parseInt(document.getElementById('cfCount').value) || 3;
  const ladder = document.getElementById('cfLadder').value.trim();
  if (!token || !accountId) { alert('请填写 API Token 和 Account ID'); return; }

  await withLoading(btn, '部署中...', async () => {
    await fetch('/api/cf/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: token, account_id: accountId, workers_count: count, ladder_proxy: ladder }),
    });
    const r = await fetch('/api/cf/deploy', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      cfBadge(true, d.status.healthy + '/' + d.status.deployed + ' Workers');
      document.getElementById('cfMsg').innerHTML = '<span style="color:#16a34a">Workers 部署成功!</span>';
    } else {
      cfBadge(false, '部署失败');
      document.getElementById('cfMsg').innerHTML = '<span style="color:#dc2626">' + (d.error || '部署失败') + '</span>';
    }
  });
}

async function cfHealth() {
  document.getElementById('cfMsg').textContent = '检查中...';
  const r = await fetch('/api/cf/health', { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    const entries = Object.entries(d.health);
    document.getElementById('cfMsg').innerHTML = entries.map(([n, i]) =>
      n + ': ' + (i.healthy ? '<span style="color:#16a34a">OK</span>' : '<span style="color:#dc2626">Down</span>') + (i.url ? ' — ' + i.url : '')
    ).join('<br>');
  } else {
    document.getElementById('cfMsg').innerHTML = '<span style="color:#dc2626">' + (d.error || '检查失败') + '</span>';
  }
}

async function cfCleanup() {
  if (!confirm('确认删除所有 Workers？')) return;
  await fetch('/api/cf/cleanup', { method: 'POST' });
  cfBadge(false, '未部署');
  document.getElementById('cfMsg').textContent = 'Workers 已删除';
}

function cfBadge(ok, text) {
  const b = document.getElementById('cfBadge');
  b.textContent = text;
  b.style.background = ok ? 'rgba(22,163,74,.15)' : '#e2e8f0';
  b.style.color = ok ? '#16a34a' : '#64748b';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
