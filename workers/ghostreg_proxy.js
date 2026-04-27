/**
 * GhostReg HTTP Reverse Proxy Worker
 * 
 * 完整的 HTTP 反向代理，支持：
 * - GET/POST/PUT/DELETE 等所有 HTTP 方法
 * - JSON body 转发
 * - 自定义 Headers 透传
 * - Cookie 转发
 * - 多种调用方式（query param / JSON body / path-based）
 * 
 * 部署后每次请求自动获取不同的 CF 出口 IP（来自全球 300+ Cloudflare 数据中心）
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 健康检查
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: 'ghostreg-proxy-1.0',
        time: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 获取出口 IP
    if (pathname === '/ip') {
      try {
        const resp = await fetch('https://httpbin.org/ip');
        const data = await resp.json();
        return new Response(JSON.stringify({
          origin: data.origin,
          cf_colo: request.cf?.colo || 'unknown',
          cf_ray: request.headers.get('cf-ray') || 'unknown',
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 代理端点：/proxy
    if (pathname === '/proxy') {
      return handleProxy(request, url);
    }

    // 首页 — 简单说明
    return new Response(JSON.stringify({
      name: 'GhostReg Proxy',
      endpoints: {
        '/health': 'Health check',
        '/ip': 'Get exit IP',
        '/proxy': 'HTTP reverse proxy (see docs)',
      },
      usage: {
        'GET': '/proxy?url=https://example.com',
        'POST': '/proxy (JSON body with target_url, method, headers, body)',
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};


async function handleProxy(request, url) {
  const method = request.method;

  // === GET 模式：/proxy?url=TARGET ===
  if (method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers: buildForwardHeaders(request),
        redirect: 'follow',
      });
      return buildResponse(resp);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // === POST 模式：完整代理请求 ===
  // Body 格式:
  // {
  //   "target_url": "https://account.jetbrains.com/api/auth/sessions",
  //   "method": "POST",            // 可选，默认 POST
  //   "headers": { ... },          // 可选，转发给目标的 Headers
  //   "body": "...",               // 可选，字符串或 JSON 字符串
  //   "json_body": { ... },        // 可选，自动 JSON.stringify
  //   "cookies": "k=v; k2=v2"      // 可选，Cookie 字符串
  // }
  if (method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const targetUrl = payload.target_url;
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing target_url in body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const targetMethod = (payload.method || 'POST').toUpperCase();
    
    // 构建请求 Headers
    const targetHeaders = new Headers();
    
    // 用户指定的 headers
    if (payload.headers) {
      for (const [key, value] of Object.entries(payload.headers)) {
        targetHeaders.set(key, value);
      }
    }

    // Cookie
    if (payload.cookies) {
      targetHeaders.set('Cookie', payload.cookies);
    }

    // 构建请求体
    let targetBody = null;
    if (targetMethod !== 'GET' && targetMethod !== 'HEAD') {
      if (payload.json_body !== undefined) {
        targetBody = JSON.stringify(payload.json_body);
        if (!targetHeaders.has('Content-Type')) {
          targetHeaders.set('Content-Type', 'application/json');
        }
      } else if (payload.body !== undefined) {
        targetBody = typeof payload.body === 'string' 
          ? payload.body 
          : JSON.stringify(payload.body);
      }
    }

    const redirectMode = (payload.redirect || 'follow').toLowerCase() === 'manual' ? 'manual' : 'follow';

    try {
      const resp = await fetch(targetUrl, {
        method: targetMethod,
        headers: targetHeaders,
        body: targetBody,
        redirect: redirectMode,
      });

      // 构建响应
      const respBody = (redirectMode === 'manual' && resp.status >= 300 && resp.status < 400) ? '' : await resp.text();
      const respHeaders = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });

      return new Response(JSON.stringify({
        status: resp.status,
        headers: respHeaders,
        body: respBody,
        cf_colo: request.cf?.colo || 'unknown',
      }), {
        status: 200,  // 外层始终 200，内层 status 在 body 里
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ 
        error: e.message,
        target_url: targetUrl,
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // OPTIONS (CORS)
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      }
    });
  }

  return new Response(JSON.stringify({ error: `Method ${method} not supported` }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}


function buildForwardHeaders(request) {
  const headers = new Headers();
  // 转发基本浏览器 headers
  const forward = ['accept', 'accept-language', 'accept-encoding', 'user-agent'];
  for (const h of forward) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  return headers;
}


function buildResponse(resp) {
  // 透传原始响应
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  // 移除可能导致问题的 headers
  headers.delete('content-encoding');
  headers.delete('content-length');
  
  return new Response(resp.body, {
    status: resp.status,
    headers: headers,
  });
}
