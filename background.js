// X 关注助手 - background service worker
// REST v1.1 接口（稳定）+ 429 退避 + 断点恢复 + 编程注入 + 批量队列
// ⚠️ 所有 X API 请求都经由 content script 同源 fetch（API_FETCH 消息路由），
//    不在 background 直接 fetch——service worker 无法带页面 cookie 会话，
//    手动设置 Cookie 头会被浏览器拒绝（forbidden header）。

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const KEEPALIVE_ALARM = 'x-helper-keepalive';

const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;

let authTokens = null;   // { csrf, userId, cookie }
let authTabId = null;    // 提供令牌/API 代理的 x.com 标签页
let running = false;

// ─── 存储 ────────────────────────────────────────────────────────────
function getStored(key, fb = null) {
  return new Promise(r => chrome.storage.local.get(key, o => r(o[key] !== undefined ? o[key] : fb)));
}
function setStored(key, val) {
  return new Promise(r => chrome.storage.local.set({ [key]: val }, r));
}

// ─── 工具 ────────────────────────────────────────────────────────────
function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function makeTxId() {
  // x-client-transaction-id：X 只校验存在+格式（实测随机 base64url 串即 200）
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ensureAuth() {
  if (!authTokens) authTokens = await getStored('authTokens', null);
  if (!authTokens || !authTokens.csrf) throw new Error(t('notConnected'));
  return authTokens;
}

// 找到可用的 x.com 标签页（优先上次的；找不到就编程注入 content.js 再试）
async function findContentTab() {
  if (authTabId) {
    try {
      const tab = await chrome.tabs.get(authTabId);
      if (tab && tab.url && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) return authTabId;
    } catch (e) {}
    authTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_TOKENS' });
      authTabId = tab.id;
      return authTabId;
    } catch (e) {
      // 页面在扩展加载前已打开 → 编程注入后重试
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_TOKENS' });
        authTabId = tab.id;
        return authTabId;
      } catch (e2) { /* 该标签不可用，试下一个 */ }
    }
  }
  return null;
}

// 经由 content script 的同源请求（自动带 cookie 会话）
async function apiViaContent(url, options = {}) {
  const auth = await ensureAuth();
  const tabId = await findContentTab();
  if (!tabId) throw new Error(t('notConnected'));
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: 'API_FETCH',
    url,
    method: options.method || 'GET',
    extraHeaders: options.headers || {},
    body: options.body || undefined,
  });
  if (!resp || !resp.ok) throw new Error(resp?.error || t('contentNoResp'));
  return resp; // { ok, status, data }
}

// 带 429 退避的 API 调用（返回 { status, data }）
async function apiFetch(url, options = {}, cfg = {}) {
  const maxRetries = cfg.maxRetries ?? 4;
  const baseMin = cfg.baseMin ?? 45000;
  const baseMax = cfg.baseMax ?? 75000;
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await apiViaContent(url, options);
    } catch (e) {
      if (attempt++ >= maxRetries) throw new Error(t('networkError') + e.message);
      await sleep(randomDelay(2000, 5000) * attempt);
      continue;
    }
    if (res.status === 429) {
      if (attempt++ >= maxRetries) throw new Error(t('rateLimited'));
      const wait = randomDelay(baseMin, baseMax) * attempt;
      broadcast({ type: 'rate_limited', wait });
      await sleep(wait);
      continue;
    }
    return res;
  }
}

// ─── 接口：抓关注列表（friends/list.json 分页）─────────────────────────
async function fetchFollowingPage(userId, cursor) {
  const params = new URLSearchParams({
    user_id: userId, count: '200', skip_status: 'false', include_user_entities: 'true',
  });
  if (cursor && cursor !== '-1') params.set('cursor', cursor);
  const res = await apiFetch(`https://x.com/i/api/1.1/friends/list.json?${params}`);
  if (res.status !== 200) throw new Error(t('followingApiError') + res.status);
  return res.data;
}

async function fetchAllFollowing(userId, onProgress) {
  const all = [];
  const seen = new Set();   // 去重
  let cursor = '-1';
  while (true) {
    const json = await fetchFollowingPage(userId, cursor);
    const users = json.users || [];
    for (const u of users) {
      const uid = u.id_str || u.rest_id || u.id;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      // X 2026 新版响应：老字段可能没了，兼容 core/relationship_counts/tweet_counts 结构
      const core = u.core || {};
      const rc = u.relationship_counts || core.relationship_counts || {};
      const tc = u.tweet_counts || core.tweet_counts || {};
      all.push({
        id: uid,
        name: u.name || core.name || '',
        screen_name: u.screen_name || core.screen_name || '',
        followers: u.followers_count ?? rc.followers ?? 0,
        statuses: u.statuses_count ?? tc.tweets ?? 0,
        created_at: u.created_at || core.created_at || '',
        description: u.description || (u.profile_bio || {}).description || '',
      });
    }
    onProgress?.(all.length);
    const next = json.next_cursor_str || '0';
    if (next === '0' || users.length === 0) break;
    cursor = next;
    await sleep(randomDelay(1500, 3000));  // 翻页间隔防限流
  }
  return all;
}

// ─── 接口：抓粉丝列表（followers/list.json 分页，用于取关追踪）────────
async function fetchFollowersPage(userId, cursor) {
  const params = new URLSearchParams({
    user_id: userId, count: '200', skip_status: 'false', include_user_entities: 'true',
  });
  if (cursor && cursor !== '-1') params.set('cursor', cursor);
  const res = await apiFetch(`https://x.com/i/api/1.1/followers/list.json?${params}`);
  if (res.status !== 200) throw new Error(t('followersApiError') + res.status);
  return res.data;
}

async function fetchAllFollowers(userId, onProgress) {
  const all = [];
  const seen = new Set();
  let cursor = '-1';
  while (true) {
    const json = await fetchFollowersPage(userId, cursor);
    const users = json.users || [];
    for (const u of users) {
      const uid = u.id_str || u.rest_id || u.id;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      all.push({ id: uid, screen_name: u.screen_name || '', name: u.name || '' });
    }
    onProgress?.(all.length);
    const next = json.next_cursor_str || '0';
    if (next === '0' || users.length === 0) break;
    cursor = next;
    await sleep(randomDelay(1500, 3000));
  }
  return all;
}

// ─── 接口：批量互关检测（friendships/lookup.json，100 个/批）────────────
async function checkMutuals(userIds, onProgress) {
  const results = {};
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100);
    const res = await apiFetch(
      `https://x.com/i/api/1.1/friendships/lookup.json?user_id=${chunk.join(',')}`,
      {}, { baseMin: 30000, baseMax: 60000 });
    if (res.status !== 200) { await sleep(randomDelay(3000, 6000)); continue; }
    const json = res.data;
    for (const entry of json) {
      const eid = entry.id_str || entry.rest_id || entry.id;
      if (eid) results[eid] = (entry.connections || []).includes('followed_by');
    }
    onProgress?.(i + chunk.length, userIds.length);
    await sleep(randomDelay(1000, 2000));
  }
  return results;
}

// ─── 接口：取关（必须带 x-client-transaction-id，否则 404）─────────────
async function unfollow(userId) {
  const res = await apiFetch(`https://x.com/i/api/1.1/friendships/destroy.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-client-transaction-id': makeTxId(),
    },
    body: new URLSearchParams({ user_id: userId }).toString(),
  }, { baseMin: 60000, baseMax: 120000 });
  if (res.status === 401 || res.status === 403) throw new Error(t('loginExpired'));
  if (res.status !== 200) throw new Error(t('unfollowFailed') + res.status);
  return res.data;
}

// ─── 每日上限 ─────────────────────────────────────────────────────────
async function getDaily() {
  const d = await getStored('dailyUnfollow', null);
  if (!d || d.date !== todayStr()) return { date: todayStr(), count: 0 };
  return d;
}
async function bumpDaily() {
  const d = await getDaily(); d.count++;
  await setStored('dailyUnfollow', d); return d;
}

// ─── 批量取关队列（持久化 + 断点恢复）──────────────────────────────────
let task = null; // 内存态；storage 为准

async function startBatch(users, settings, tabId) {
  task = {
    active: true, paused: false,
    queue: users.map(u => ({ id: u.id, screen_name: u.screen_name })),
    done: 0, total: users.length, settings, tabId,
    log: [], startedAt: Date.now(),
  };
  await setStored('unfollowState', task);
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  processQueue();
  return task;
}

async function processQueue() {
  if (running) return;
  running = true;
  try {
    let state = await getStored('unfollowState', null);
    while (state && state.active && !state.paused && state.queue.length > 0) {
      const limit = state.settings.dailyLimit || 0;
      if (limit > 0) {
        const daily = await getDaily();
        if (daily.count >= limit) {
          state.paused = true; state.cappedAt = Date.now();
          await setStored('unfollowState', state);
          broadcast({ type: 'TASK_CAPPED', limit, count: daily.count });
          return;
        }
      }
      const user = state.queue[0];
      state.current = user;
      // 白名单检查（必须在取关之前！）
      const isWhitelisted = (state.settings.whitelist || []).some(w => (typeof w === 'object' ? w.id === user.id : w === user.id));
      if (isWhitelisted) {
        state.queue.shift(); state.done++;
        state.log.push({ type: 'skip', text: t('skipWl') + user.screen_name, ts: Date.now() });
        await setStored('unfollowState', state);
        broadcast({ type: 'TASK_UPDATED' });
        state = await getStored('unfollowState', null);
        if (!state || !state.active || state.paused || state.queue.length === 0) break;
        continue;
      }
      try {
        await unfollow(user.id);
        state.queue.shift(); state.done++;
        await setStored('unfollowState', state);
        await bumpDaily();
        state.log.push({ type: 'ok', text: t('unfollowedOk') + user.screen_name, ts: Date.now() });
        broadcast({ type: 'TASK_UPDATED' });
      } catch (err) {
        state.queue.shift();
        await setStored('unfollowState', state);
        state.log.push({ type: 'err', text: `@${user.screen_name} ${err.message}`, ts: Date.now() });
        broadcast({ type: 'TASK_UPDATED' });
      }
      state = await getStored('unfollowState', null);
      if (!state || !state.active || state.paused || state.queue.length === 0) break;
      const min = (state.settings.intervalMs || 20000) / 1000;
      const max = min + (state.settings.jitterMs || 10000) / 1000;
      await sleep(randomDelay(min, max) * 1000);
      state = await getStored('unfollowState', null);
    }
    // 完成 / 取消
    const final = await getStored('unfollowState', null);
    if (final && final.active && final.queue.length === 0) {
      final.log.push({ type: 'done', text: t('taskDoneBg'), ts: Date.now() });
      await setStored('unfollowState', final);
      broadcast({ type: 'TASK_UPDATED' });
      await saveHistory(final);
      await clearState();
    }
  } finally { running = false; }
}

async function clearState() {
  await chrome.storage.local.remove('unfollowState');
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ─── 任务历史（保留最近 20 次，可导出 CSV）────────────────────────────
async function saveHistory(task) {
  const hist = (await getStored('taskHistory', [])) || [];
  hist.unshift({
    finishedAt: Date.now(),
    done: task.done, total: task.total,
    log: (task.log || []).slice(-200),
  });
  await setStored('taskHistory', hist.slice(0, 20));
}

async function resumeIfNeeded() {
  const state = await getStored('unfollowState', null);
  if (state && state.active && !state.paused && !running) processQueue();
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === KEEPALIVE_ALARM) resumeIfNeeded(); });
chrome.runtime.onStartup.addListener(resumeIfNeeded);
resumeIfNeeded();

// ─── 编程注入：已打开的 X 标签页（解决"未连接"）─────────────────────────
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) { /* 注入失败忽略 */ }
    }
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(() => injectIntoExistingTabs());
chrome.runtime.onStartup.addListener(() => injectIntoExistingTabs());
injectIntoExistingTabs();

// ─── 侧边栏 ───────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── 消息路由 ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'AUTH_TOKENS':
          authTokens = msg.tokens;
          if (sender.tab?.id) authTabId = sender.tab.id;
          await setStored('authTokens', msg.tokens);
          sendResponse({ ok: true });
          break;
        case 'GET_AUTH_STATUS':
          if (!authTokens) authTokens = await getStored('authTokens', null);
          sendResponse({ ok: !!authTokens, userId: authTokens?.userId || null });
          break;
        case 'SCAN': {
          // 抓关注列表 + 批量互关检测 → 未互关列表
          chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });  // 防 SW 休眠中断长扫描
          try {
            const auth = await ensureAuth();
            const users = await fetchAllFollowing(auth.userId, n => broadcast({ type: 'SCAN_PROGRESS', phase: 'following', n }));
            const mutual = await checkMutuals(users.map(u => u.id), (checked, total) => broadcast({ type: 'SCAN_PROGRESS', phase: 'mutual', checked, total }));
            const notFollow = users.filter(u => !mutual[u.id]);
            sendResponse({ ok: true, data: { following: users, notFollow } });
          } finally {
            chrome.alarms.clear(KEEPALIVE_ALARM);
          }
          break;
        }
        case 'START_TASK': {
          const settings = await getStored('settings', null) || { intervalMs: 20000, jitterMs: 10000, dailyLimit: 100, whitelist: [] };
          const daily = await getDaily();
          const remaining = Math.max(0, settings.dailyLimit - daily.count);
          const targets = msg.targets.slice(0, remaining);
          const tsk = await startBatch(targets, settings, sender.tab?.id);
          sendResponse({ ok: true, data: { accepted: targets.length, skipped: msg.targets.length - targets.length, dailyUsed: daily.count, dailyLimit: settings.dailyLimit } });
          break;
        }
        case 'PAUSE_TASK': {
          const state = await getStored('unfollowState', null);
          if (state) { state.paused = !state.paused; await setStored('unfollowState', state); }
          sendResponse({ ok: true, paused: state?.paused ?? false });
          break;
        }
        case 'STOP_TASK': {
          const state = await getStored('unfollowState', null);
          if (state) {
            state.active = false;
            await setStored('unfollowState', state);
            if (state.log && state.log.length) {
              state.log.push({ type: 'done', text: t('taskStopped'), ts: Date.now() });
              await saveHistory(state);
            }
          }
          await clearState();
          sendResponse({ ok: true });
          break;
        }
        case 'TASK_STATUS': {
          const state = await getStored('unfollowState', null);
          sendResponse({ ok: true, data: state ? {
            done: state.done, total: state.total, paused: state.paused,
            queueLen: state.queue.length, log: state.log.slice(-50),
          } : null });
          break;
        }
        case 'EXPORT_LOG': {
          const state = await getStored('unfollowState', null);
          sendResponse({ ok: true, data: state ? {
            done: state.done, total: state.total, log: state.log,
            startedAt: state.startedAt,
          } : null });
          break;
        }
        case 'GET_HISTORY':
          sendResponse({ ok: true, data: await getStored('taskHistory', []) });
          break;
        case 'RESOLVE_USER': {
          // @用户名 → user_id（REST users/show.json；失败提示改用数字 ID）
          const auth = await ensureAuth();
          const tabId = await findContentTab();
          if (!tabId) throw new Error(t('notConnected'));
          const resp = await chrome.tabs.sendMessage(tabId, {
            type: 'API_FETCH',
            url: `https://x.com/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(msg.screen_name)}`,
            method: 'GET',
            extraHeaders: { 'x-client-transaction-id': makeTxId() },
            body: undefined,
          });
          if (!resp || !resp.ok) throw new Error(resp?.error || t('contentNoResp'));
          if (resp.status !== 200) {
            sendResponse({ ok: false, error: t('resolveFailedBg', [String(resp.status)]) });
          } else {
            const u = resp.data;
            sendResponse({ ok: true, data: {
              id: u.id_str || u.rest_id || u.id,
              name: u.name || '',
              screen_name: u.screen_name || msg.screen_name,
            } });
          }
          break;
        }
        case 'TRACK_FOLLOWERS': {
          // 抓全量粉丝 → 与上次快照对比 → 取关你的人 / 新粉丝
          chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
          try {
            const auth = await ensureAuth();
            const prev = await getStored('followersSnapshot', null);
            const users = await fetchAllFollowers(auth.userId, n => broadcast({ type: 'FOLLOWERS_PROGRESS', n }));
            const byId = {};
            for (const u of users) byId[u.id] = u;
            const newIds = new Set(users.map(u => u.id));
            let lost = [], gained = [];
            if (prev && prev.ids) {
              lost = prev.ids.filter(id => !newIds.has(id)).map(id => ({
                id,
                screen_name: (prev.users || {})[id]?.screen_name || id,
                name: (prev.users || {})[id]?.name || '',
              }));
              gained = users.filter(u => !prev.ids.includes(u.id));
            }
            const result = {
              checkedAt: Date.now(),
              total: users.length,
              prevDate: prev ? prev.date : null,
              prevTotal: prev ? prev.ids.length : null,
              lost, gained,
            };
            await setStored('followersSnapshot', { date: Date.now(), ids: [...newIds], users: byId });
            await setStored('followersLast', result);
            sendResponse({ ok: true, data: result });
          } finally {
            chrome.alarms.clear(KEEPALIVE_ALARM);
          }
          break;
        }
        case 'GET_FOLLOWERS_LAST':
          sendResponse({ ok: true, data: await getStored('followersLast', null) });
          break;
        case 'GET_SETTINGS':
          sendResponse({ ok: true, data: await getStored('settings', null) || { intervalMs: 20000, jitterMs: 10000, dailyLimit: 100, whitelist: [] } });
          break;
        case 'SAVE_SETTINGS':
          await setStored('settings', msg.data);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: t('unknownMsg') + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
