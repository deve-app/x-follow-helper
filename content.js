// X 关注助手 - content script
// 职责：
//  1) 从 X 页面提取会话令牌（csrf / userId / cookie）发给 background
//  2) 作为同源 API 代理：background 发 API_FETCH 消息 → content script 在 x.com
//     页面里同源 fetch（自动带 cookie 会话），返回 { status, data }
//  ⚠️ 不要在 background 直接 fetch 并手动带 Cookie 头（浏览器禁止设置 forbidden header）

(() => {
  if (window.__xHelperInjected) return;
  window.__xHelperInjected = true;

  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  function getCookieRaw(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : null;
  }

  function extractTokens() {
    const csrf = getCookieRaw('ct0');
    if (!csrf) return null;
    const userId = extractUserId();
    if (!userId) return null;
    return { csrf, userId, cookie: document.cookie };
  }

  function extractUserId() {
    const twidRaw = getCookieRaw('twid');
    if (twidRaw) {
      const m = twidRaw.match(/u(?:%3D|=)(\d+)/i);
      if (m) return m[1];
    }
    // 兜底：页面 JSON 脚本里的 rest_id
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.includes('"rest_id"')) {
          const m = t.match(/"rest_id"\s*:\s*"(\d+)"/);
          if (m) return m[1];
        }
      }
    } catch (e) {}
    return null;
  }

  function sendTokens() {
    const tokens = extractTokens();
    if (!tokens) return false;
    try {
      chrome.runtime.sendMessage({ type: 'AUTH_TOKENS', tokens }, () => {
        if (chrome.runtime.lastError) { /* background 未就绪，忽略 */ }
      });
      return true;
    } catch (e) { return false; }
  }

  // ─── 同源 API 代理 ─────────────────────────────────────────────────
  async function handleApiFetch(msg) {
    const csrf = getCookieRaw('ct0');
    if (!csrf) return { ok: false, status: 401, error: '未登录或令牌未找到' };
    const headers = {
      'authorization': msg.bearer || BEARER,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      ...(msg.extraHeaders || {}),
    };
    const res = await fetch(msg.url, {
      method: msg.method || 'GET',
      headers,
      body: msg.body || undefined,
      credentials: 'include',   // 同源自动带 cookie，绝不手动设置 Cookie 头
    });
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { ok: true, status: res.status, data };
  }

  // 立即发送令牌；失败重试（页面可能还在加载）
  if (!sendTokens()) {
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      if (sendTokens() || retries >= 10) clearInterval(timer);
    }, 2000);
  }
  // 令牌可能轮换，定期刷新
  setInterval(sendTokens, 30000);

  // 响应 background 的令牌请求 + API 代理请求
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'REQUEST_TOKENS') {
      const tokens = extractTokens();
      if (tokens) sendResponse({ ok: true, tokens });
      else sendResponse({ ok: false, error: '未登录或令牌未找到' });
    } else if (msg.type === 'API_FETCH') {
      handleApiFetch(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // 异步响应
    }
  });

  console.log('[X关注助手] content loaded');
})();
