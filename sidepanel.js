// X 关注助手 - sidepanel 逻辑（v0.3：i18n + REST 接口 + 批量互关检测）

let state = {
  following: [],
  notFollow: [],
  selected: new Set(),
  whitelist: [],
  scanning: false,
};

const $ = (id) => document.getElementById(id);
const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;

// 应用 HTML 静态文案（data-i18n / data-i18n-ph / data-i18n-title）
function applyI18n() {
  document.documentElement.lang = chrome.i18n.getUILanguage() || 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = chrome.i18n.getMessage(el.dataset.i18n);
    if (v) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const v = chrome.i18n.getMessage(el.dataset.i18nPh);
    if (v) el.placeholder = v;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const v = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (v) el.title = v;
  });
}

async function init() {
  applyI18n();
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
    if (st && st.ok) {
      $('meLabel').textContent = t('meConnected') + st.userId;
      scan();
    } else {
      $('meLabel').textContent = t('meNotConnected');
    }
  } catch (e) {
    $('meLabel').textContent = t('meNotConnected');
  }
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (s && s.ok) state.whitelist = s.data.whitelist || [];
  renderWhitelist();
  loadSettings();
  renderHistory();
}

// 扫描：抓关注 + 批量互关检测（background 完成）
async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  $('scanStatus').textContent = t('scanStatusStart');
  $('listInfo').textContent = t('fetching');
  const box = $('scanBox');
  box.style.display = '';
  $('scanPhase').textContent = t('scanPhaseFetch');
  $('scanPct').textContent = '';
  $('scanFill').style.width = '0%';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SCAN' });
    if (!r || !r.ok) {
      box.style.display = 'none';
      $('scanStatus').textContent = t('scanFailed') + (r?.error || t('unknown'));
      state.scanning = false;
      return;
    }
    state.following = r.data.following;
    state.notFollow = r.data.notFollow;
    renderStats();
    renderItems();
    box.style.display = 'none';
    $('scanStatus').textContent = t('scanDone');
  } catch (e) {
    box.style.display = 'none';
    $('scanStatus').textContent = t('scanFailed') + String(e.message || e);
  }
  state.scanning = false;
}

// 扫描进度（background 广播：抓取阶段显示人数，互关阶段显示百分比）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'SCAN_PROGRESS') return;
  const box = $('scanBox');
  if (box.style.display === 'none') box.style.display = '';
  if (msg.phase === 'following') {
    $('scanPhase').textContent = t('scanFetchProgress', [String(msg.n)]);
    $('scanPct').textContent = String(msg.n);
  } else if (msg.phase === 'mutual') {
    const pct = msg.total ? Math.round(msg.checked / msg.total * 100) : 0;
    $('scanPhase').textContent = t('scanMutualProgress', [String(msg.checked), String(msg.total)]);
    $('scanPct').textContent = pct + '%';
    $('scanFill').style.width = pct + '%';
  }
});

// ─── 设置面板 ────────────────────────────────────────────────────────
async function loadSettings() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = (r && r.ok) ? r.data : {};
  $('setInterval').value = s.intervalMs ? Math.round(s.intervalMs / 1000) : 20;
  $('setJitter').value = s.jitterMs ? Math.round(s.jitterMs / 1000) : 10;
  $('setDailyLimit').value = s.dailyLimit ?? 100;
}

$('saveSettingsBtn').onclick = async () => {
  const iv = Math.max(5, parseInt($('setInterval').value || '20', 10));
  const jt = Math.max(0, parseInt($('setJitter').value || '10', 10));
  const dl = Math.max(1, parseInt($('setDailyLimit').value || '100', 10));
  const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = (r && r.ok) ? r.data : {};
  s.intervalMs = iv * 1000; s.jitterMs = jt * 1000; s.dailyLimit = dl;
  const sv = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: s });
  if (sv && sv.ok) {
    $('saveSettingsBtn').textContent = t('saved');
    setTimeout(() => { $('saveSettingsBtn').textContent = t('saveSettings'); }, 1500);
  } else {
    alert(t('saveFailed') + (sv?.error || t('unknown')));
  }
};

// ─── 导出 CSV ────────────────────────────────────────────────────────
function downloadCSV(filename, rows) {
  const csv = '\uFEFF' + rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function logRows(log, baseTime) {
  return (log || []).map(l => {
    const d = new Date(l.ts || baseTime || Date.now());
    return [d.toLocaleString(chrome.i18n.getUILanguage() || 'zh-CN', { hour12: false }), l.type, l.text];
  });
}

$('exportBtn').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'EXPORT_LOG' });
  const tsk = r && r.ok ? r.data : null;
  if (!tsk || !tsk.log || tsk.log.length === 0) { alert(t('noLog')); return; }
  const rows = [[t('csvTime'), t('csvType'), t('csvContent')], ...logRows(tsk.log, tsk.startedAt)];
  downloadCSV(t('exportLogName') + Date.now() + '.csv', rows);
};

// ─── 任务历史 ────────────────────────────────────────────────────────
async function renderHistory() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const hist = (r && r.ok && Array.isArray(r.data)) ? r.data : [];
  const box = $('taskHistory');
  box.innerHTML = '';
  if (hist.length === 0) {
    box.innerHTML = '<div class="empty" style="padding:12px">' + t('noHistory') + '</div>';
    return;
  }
  hist.slice(0, 5).forEach(h => {
    const d = new Date(h.finishedAt);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const lastText = (h.log && h.log.length) ? h.log[h.log.length - 1].text : '';
    const div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    div.innerHTML = `
      <div class="info">
        <div class="name">${dateStr} · ${h.done}/${h.total}</div>
        <div class="handle">${lastText}</div>
      </div>
      <button class="btn ghost" style="padding:3px 10px;font-size:11px">${t('export')}</button>`;
    div.querySelector('button').onclick = () => {
      const rows = [[t('csvTime'), t('csvType'), t('csvContent')], ...logRows(h.log, h.finishedAt)];
      downloadCSV(t('exportHistName') + dateStr.replace(/[\/\s:]/g, '_') + '.csv', rows);
    };
    box.appendChild(div);
  });
}

// ─── 分析（v2：互关健康度 + 僵尸粉检测 + 活跃度排名）──────────────────
function zombieScore(u) {
  let s = 0; const reasons = [];
  if (u.statuses < 20) { s += 2; reasons.push(t('reasonFewPosts')); }
  if (u.followers < 30 && u.statuses < 60) { s += 2; reasons.push(t('reasonInactive')); }
  if (u.created_at) {
    const days = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
    if (days < 30 && u.statuses < 60) { s += 1; reasons.push(t('reasonNew')); }
  }
  const desc = (u.description || '').toLowerCase();
  const spamWords = ['加微信', '代购', '返利', '优惠券', '私信', '跟单', '荐股', '虚拟币', '加密货币', '币圈', '合约', 'telegram', 'crypto', 'airdrop', 'buy followers', 'promo', 'vip', 'sale'];
  if (spamWords.some(w => desc.includes(w))) { s += 2; reasons.push(t('reasonMarketing')); }
  return { score: s, reasons };
}

function analyzeData() {
  const zombies = [];
  for (const u of state.following) {
    const z = zombieScore(u);
    if (z.score >= 3) zombies.push({ ...u, ...z });
  }
  const byStatus = [...state.following].sort((a, b) => b.statuses - a.statuses);
  return {
    mutual: state.following.length - state.notFollow.length,
    total: state.following.length,
    zombies,
    activeTop: byStatus.slice(0, 5),
    inactiveTop: byStatus.slice(-5).reverse(),
  };
}

function renderAnalysis() {
  const content = $('anContent');
  if (!state.following.length) {
    $('anNoData').style.display = '';
    content.style.display = 'none';
    return;
  }
  $('anNoData').style.display = 'none';
  content.style.display = '';
  const a = analyzeData();
  const rate = a.total ? Math.round(a.mutual / a.total * 100) : 0;
  $('anMutual').textContent = a.mutual;
  $('anRate').textContent = rate + '%';
  $('anZombie').textContent = a.zombies.length;
  const circ = 2 * Math.PI * 42;
  $('anRing').setAttribute('stroke-dasharray', (rate / 100 * circ) + ' ' + circ);

  const zbox = $('anZombieList');
  zbox.innerHTML = '';
  if (!a.zombies.length) {
    zbox.innerHTML = '<div class="empty" style="padding:14px">' + t('noZombies') + '</div>';
  } else {
    a.zombies.slice(0, 20).forEach(u => {
      const div = document.createElement('div');
      div.className = 'item';
      div.style.cursor = 'default';
      div.innerHTML = `
        <div class="avatar">${(u.name || '?')[0]}</div>
        <div class="info">
          <div class="name">${u.name}</div>
          <div class="handle">@${u.screen_name} · ${u.followers}${t('folSuffix')} · ${u.statuses}${t('postSuffix')}</div>
          <div class="meta"><span>${u.reasons.join(' / ')}</span></div>
        </div>`;
      zbox.appendChild(div);
    });
  }
  renderRank($('anActiveList'), a.activeTop);
  renderRank($('anInactiveList'), a.inactiveTop);
  renderFollowers();
}

function renderRank(box, list) {
  box.innerHTML = '';
  list.forEach(u => {
    const div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    div.innerHTML = `
      <div class="avatar">${(u.name || '?')[0]}</div>
      <div class="info">
        <div class="name">${u.name}</div>
        <div class="handle">@${u.screen_name}</div>
        <div class="meta"><span>${u.statuses}${t('postSuffix')}</span></div>
      </div>`;
    box.appendChild(div);
  });
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

$('anExportBtn').onclick = () => {
  if (!state.following.length) { alert(t('scanFirst')); return; }
  const a = analyzeData();
  const rate = a.total ? Math.round(a.mutual / a.total * 100) : 0;
  const d = new Date();
  const lang = chrome.i18n.getUILanguage() || 'zh-CN';
  let md = `# ${t('reportTitle')}（${d.toLocaleDateString(lang)}）\n\n`;
  md += `- ${t('reportTotal', [String(a.total)])}\n- ${t('reportMutual', [String(a.mutual)])}\n- ${t('reportNotFollow', [String(state.notFollow.length)])}\n- ${t('reportRate', [String(rate)])}\n- ${t('reportZombies', [String(a.zombies.length)])}\n\n`;
  md += `## ${t('reportZombieSection')}\n\n| @ | ${t('statFollowers')} | ${t('statFollowing')} | ${t('csvType')} |\n|---|---|---|---|\n`;
  a.zombies.forEach(u => { md += `| @${u.screen_name} | ${u.followers} | ${u.statuses} | ${u.reasons.join('、')} |\n`; });
  md += `\n## ${t('reportActiveSection')}\n\n`;
  a.activeTop.forEach((u, i) => { md += `${i + 1}. @${u.screen_name} — ${u.statuses}${t('postSuffix')}\n`; });
  md += `\n## ${t('reportInactiveSection')}\n\n`;
  a.inactiveTop.forEach((u, i) => { md += `${i + 1}. @${u.screen_name} — ${u.statuses}${t('postSuffix')}\n`; });
  downloadText(t('reportName') + Date.now() + '.md', md);
};

// ─── 智能过滤（按粉丝数/活跃度/语言，防误删）──────────────────────────
function langOf(u) {
  const s = (u.name || '') + (u.description || '');
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s) ? 'cjk' : 'other';
}
function filteredNotFollow() {
  const minF = parseInt($('fMinFlw').value || '0', 10);
  const minS = parseInt($('fMinSt').value || '0', 10);
  const lang = $('fLang').value;
  return state.notFollow.filter(u =>
    u.followers >= minF && u.statuses >= minS && (!lang || langOf(u) === lang));
}
['fMinFlw', 'fMinSt', 'fLang'].forEach(id => {
  $(id).addEventListener('input', () => renderItems());
});

// ─── 粉丝变化追踪（谁取关了你）────────────────────────────────────────
function renderTrackList(box, list, emptyText) {
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = `<div class="empty" style="padding:10px">${emptyText}</div>`; return; }
  list.slice(0, 20).forEach(u => {
    const label = u.name || u.screen_name || u.id;
    const div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    div.innerHTML = `
      <div class="avatar">${(label || '?')[0]}</div>
      <div class="info">
        <div class="name">${label}</div>
        <div class="handle">@${u.screen_name || u.id}</div>
      </div>`;
    box.appendChild(div);
  });
}

async function renderFollowers() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_FOLLOWERS_LAST' });
  const d = r && r.ok ? r.data : null;
  const st = $('anTrackStatus');
  if (!d) {
    st.textContent = t('trackEmpty');
    $('anTrackLost').style.display = 'none';
    $('anTrackGained').style.display = 'none';
    return;
  }
  const dt = new Date(d.checkedAt);
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  st.textContent = t('lastCheck', [timeStr, String(d.total)]) +
    (d.prevTotal != null ? t('diffNote', [String(d.prevTotal), String(d.lost.length), String(d.gained.length)]) : t('firstSnapshot'));
  renderTrackList($('anLostList'), d.lost, t('noUnfollow'));
  renderTrackList($('anGainedList'), d.gained, t('noNewFollowers'));
  $('anTrackLost').style.display = d.lost.length ? '' : 'none';
  $('anTrackGained').style.display = d.gained.length ? '' : 'none';
}

$('anTrackBtn').onclick = async () => {
  const btn = $('anTrackBtn');
  btn.disabled = true; btn.textContent = t('fetchingFollowers');
  $('anTrackStatus').textContent = t('fetchingFollowersLong');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TRACK_FOLLOWERS' });
    if (r && r.ok) await renderFollowers();
    else $('anTrackStatus').textContent = t('checkFailed') + (r?.error || t('unknown'));
  } catch (e) {
    $('anTrackStatus').textContent = t('checkFailed') + String(e.message || e);
  }
  btn.disabled = false; btn.textContent = t('checkFollowers');
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FOLLOWERS_PROGRESS') {
    const st = $('anTrackStatus');
    if (st && !st.textContent.startsWith(t('checkFailed'))) st.textContent = t('followersProgress', [String(msg.n)]);
  }
});

function renderStats() {
  $('stFollowing').textContent = state.following.length;
  $('stNotFollow').textContent = state.notFollow.length;
  $('badgeClean').textContent = state.notFollow.length > 99 ? '99+' : state.notFollow.length;
}

function renderItems() {
  const box = $('itemList');
  box.innerHTML = '';
  const list = filteredNotFollow();
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">' + t('emptyFiltered') + '</div>';
  } else {
    list.slice(0, 200).forEach(u => {
      const el = document.createElement('div');
      el.className = 'item';
      if (state.selected.has(u.id)) el.classList.add('selected');
      const wl = state.whitelist.some(w => (typeof w === 'object' ? w.id === u.id : w === u.id)) ? t('whitelistMark') : '';
      el.innerHTML = `
        <div class="avatar">${(u.name || '?')[0]}</div>
        <div class="info">
          <div class="name">${u.name}${wl}</div>
          <div class="handle">@${u.screen_name}</div>
          <div class="meta"><span>${u.followers}${t('folSuffix')}</span><span>${u.statuses}${t('postSuffix')}</span></div>
        </div>
        <div class="check"></div>`;
      el.onclick = () => {
        if (state.selected.has(u.id)) state.selected.delete(u.id); else state.selected.add(u.id);
        el.classList.toggle('selected');
        updateSel();
      };
      box.appendChild(el);
    });
  }
  let info = t('countInfo', [String(state.notFollow.length)]);
  if (list.length !== state.notFollow.length) info += t('countFiltered', [String(list.length)]);
  if (list.length > 200) info += t('countMore');
  $('listInfo').textContent = info;
}

function updateSel() {
  $('selCount').textContent = state.selected.size;
  $('unfollowBtn').disabled = state.selected.size === 0;
}

function selectAll() {
  filteredNotFollow().slice(0, 200).forEach(u => {
    if (!state.whitelist.some(w => (typeof w === 'object' ? w.id === u.id : w === u.id))) state.selected.add(u.id);
  });
  renderItems();
  updateSel();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    ['clean','task','whitelist','analyze','settings'].forEach(p => {
      $('panel-' + p).style.display = p === tab.dataset.tab ? '' : 'none';
    });
    if (tab.dataset.tab === 'task') { pollTask(); renderHistory(); }
    else if (tab.dataset.tab === 'analyze') renderAnalysis();
  };
});

async function startTask() {
  if (state.selected.size === 0) return;
  const targets = state.notFollow.filter(u => state.selected.has(u.id)).map(u => ({ id: u.id, screen_name: u.screen_name }));
  const r = await chrome.runtime.sendMessage({ type: 'START_TASK', targets });
  if (r && r.ok) {
    $('taskBox').style.display = '';
    $('taskEmpty').style.display = 'none';
    $('taskCount').textContent = t('taskAccepted', [String(r.data.accepted), String(r.data.skipped)]);
    $('taskStatus').textContent = t('taskRunning');
    state.selected.clear();
    updateSel();
    pollTask();
  } else {
    alert(t('startFailed') + (r?.error || t('unknown')));
  }
}

async function pollTask() {
  const r = await chrome.runtime.sendMessage({ type: 'TASK_STATUS' });
  if (!r || !r.ok || !r.data) { $('taskEmpty').style.display = ''; return; }
  const tsk = r.data;
  $('taskBox').style.display = '';
  $('taskEmpty').style.display = 'none';
  $('taskStatus').textContent = tsk.paused ? t('taskPaused') : (tsk.done >= tsk.total ? t('taskDone') : t('taskRunning'));
  $('taskProgress').style.width = (tsk.total ? Math.round(tsk.done / tsk.total * 100) : 0) + '%';
  $('taskCount').textContent = `${tsk.done} / ${tsk.total}`;
  const log = $('taskLog');
  log.innerHTML = '';
  tsk.log.forEach(l => {
    const div = document.createElement('div');
    div.className = l.type;
    div.textContent = l.text;
    log.appendChild(div);
  });
  if (tsk.done < tsk.total) setTimeout(pollTask, 2000);
}

$('unfollowBtn').onclick = startTask;
$('selectAllLink').onclick = selectAll;
$('refreshBtn').onclick = scan;

$('pauseBtn').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'PAUSE_TASK' });
  if (r && r.ok) $('taskStatus').textContent = r.paused ? t('taskPaused') : t('taskRunning');
};
$('stopBtn').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_TASK' });
  $('taskBox').style.display = 'none';
  $('taskEmpty').style.display = '';
};

function renderWhitelist() {
  const box = $('wlList');
  box.innerHTML = '';
  state.whitelist.forEach(w => {
    const id = (typeof w === 'object') ? w.id : w;
    const label = (typeof w === 'object' && w.screen_name) ? '@' + w.screen_name : 'ID ' + id;
    const first = (label.replace('@', '')[0] || '?').toUpperCase();
    const div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    div.innerHTML = `<div class="avatar" style="width:30px;height:30px;font-size:12px">${first}</div>
      <div class="info"><div class="name">${label}</div><div class="handle">${id}</div></div>
      <button class="btn ghost" style="padding:3px 10px;font-size:11px">${t('remove')}</button>`;
    div.querySelector('button').onclick = async () => {
      state.whitelist = state.whitelist.filter(x => (typeof x === 'object' ? x.id !== id : x !== id));
      await saveWl();
      renderWhitelist();
    };
    box.appendChild(div);
  });
  if (state.whitelist.length === 0) box.innerHTML = '<div class="empty">' + t('noWl') + '</div>';
}

async function saveWl() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const settings = (s && s.ok) ? s.data : {};
  settings.whitelist = state.whitelist;
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: settings });
}

$('wlAddBtn').onclick = async () => {
  const v = $('wlInput').value.trim().replace('@', '');
  if (!v) return;
  if (/^\d+$/.test(v)) {
    state.whitelist.push({ id: v, screen_name: v });
    $('wlInput').value = '';
    await saveWl();
    renderWhitelist();
  } else {
    const btn = $('wlAddBtn');
    btn.disabled = true; btn.textContent = t('resolving');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'RESOLVE_USER', screen_name: v });
      if (r && r.ok) {
        state.whitelist.push({ id: r.data.id, screen_name: r.data.screen_name });
        $('wlInput').value = '';
        await saveWl();
        renderWhitelist();
      } else {
        alert(t('resolveFailed') + (r?.error || t('unknown')));
      }
    } catch (e) {
      alert(t('resolveFailed') + String(e.message || e));
    }
    btn.disabled = false; btn.textContent = t('add');
  }
};
$('wlInput').onkeydown = (e) => { if (e.key === 'Enter') $('wlAddBtn').click(); };

init();
