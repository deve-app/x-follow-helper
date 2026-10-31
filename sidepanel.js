// X 关注助手 - sidepanel 逻辑（v0.2：REST 接口 + 批量互关检测）

let state = {
  following: [],
  notFollow: [],
  selected: new Set(),
  whitelist: [],
  scanning: false,
};

const $ = (id) => document.getElementById(id);

async function init() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
    if (st && st.ok) {
      $('meLabel').textContent = '已连接 · ' + st.userId;
      scan();
    } else {
      $('meLabel').textContent = '未连接（请打开 x.com 页面）';
    }
  } catch (e) {
    $('meLabel').textContent = '未连接（请打开 x.com 页面）';
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
  $('scanStatus').textContent = '扫描中（抓关注列表 + 互关检测）...';
  $('listInfo').textContent = '正在抓取...';
  const box = $('scanBox');
  box.style.display = '';
  $('scanPhase').textContent = '正在抓取关注列表...';
  $('scanPct').textContent = '';
  $('scanFill').style.width = '0%';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SCAN' });
    if (!r || !r.ok) {
      box.style.display = 'none';
      $('scanStatus').textContent = '扫描失败: ' + (r?.error || '未知');
      state.scanning = false;
      return;
    }
    state.following = r.data.following;
    state.notFollow = r.data.notFollow;
    renderStats();
    renderItems();
    box.style.display = 'none';
    $('scanStatus').textContent = '扫描完成 ✓';
  } catch (e) {
    box.style.display = 'none';
    $('scanStatus').textContent = '扫描失败: ' + String(e.message || e);
  }
  state.scanning = false;
}

// 扫描进度（background 广播：抓取阶段显示人数，互关阶段显示百分比）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'SCAN_PROGRESS') return;
  const box = $('scanBox');
  if (box.style.display === 'none') box.style.display = '';
  if (msg.phase === 'following') {
    $('scanPhase').textContent = `正在抓取关注列表... 已抓取 ${msg.n} 人`;
    $('scanPct').textContent = `${msg.n} 人`;
  } else if (msg.phase === 'mutual') {
    const pct = msg.total ? Math.round(msg.checked / msg.total * 100) : 0;
    $('scanPhase').textContent = `正在检测互关... ${msg.checked}/${msg.total}`;
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
    $('saveSettingsBtn').textContent = '已保存 ✓';
    setTimeout(() => { $('saveSettingsBtn').textContent = '保存设置'; }, 1500);
  } else {
    alert('保存失败: ' + (sv?.error || '未知'));
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
    return [d.toLocaleString('zh-CN', { hour12: false }), l.type, l.text];
  });
}

$('exportBtn').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'EXPORT_LOG' });
  const t = r && r.ok ? r.data : null;
  if (!t || !t.log || t.log.length === 0) { alert('当前没有任务日志'); return; }
  const rows = [['时间', '类型', '内容'], ...logRows(t.log, t.startedAt)];
  downloadCSV(`X关注助手_取关日志_${Date.now()}.csv`, rows);
};

// ─── 任务历史 ────────────────────────────────────────────────────────
async function renderHistory() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const hist = (r && r.ok && Array.isArray(r.data)) ? r.data : [];
  const box = $('taskHistory');
  box.innerHTML = '';
  if (hist.length === 0) {
    box.innerHTML = '<div class="empty" style="padding:12px">暂无历史任务</div>';
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
      <button class="btn ghost" style="padding:3px 10px;font-size:11px">导出</button>`;
    div.querySelector('button').onclick = () => {
      const rows = [['时间', '类型', '内容'], ...logRows(h.log, h.finishedAt)];
      downloadCSV(`X关注助手_历史任务_${dateStr.replace(/[\/\s:]/g, '_')}.csv`, rows);
    };
    box.appendChild(div);
  });
}

// ─── 分析（v2：互关健康度 + 僵尸粉检测 + 活跃度排名）──────────────────
function zombieScore(u) {
  let s = 0; const reasons = [];
  if (u.statuses < 20) { s += 2; reasons.push('帖数极少'); }
  if (u.followers < 30 && u.statuses < 60) { s += 2; reasons.push('粉丝极少且不活跃'); }
  if (u.created_at) {
    const days = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
    if (days < 30 && u.statuses < 60) { s += 1; reasons.push('新号'); }
  }
  const desc = (u.description || '').toLowerCase();
  const spamWords = ['加微信', '代购', '返利', '优惠券', '私信', '跟单', '荐股', '虚拟币', '加密货币', '币圈', '合约', 'telegram', 'crypto', 'airdrop', 'buy followers', 'promo', 'vip', 'sale'];
  if (spamWords.some(w => desc.includes(w))) { s += 2; reasons.push('疑似营销词'); }
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
    zbox.innerHTML = '<div class="empty" style="padding:14px">没有明显可疑账号 🎉</div>';
  } else {
    a.zombies.slice(0, 20).forEach(u => {
      const div = document.createElement('div');
      div.className = 'item';
      div.style.cursor = 'default';
      div.innerHTML = `
        <div class="avatar">${(u.name || '?')[0]}</div>
        <div class="info">
          <div class="name">${u.name}</div>
          <div class="handle">@${u.screen_name} · ${u.followers} 粉 · ${u.statuses} 帖</div>
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
        <div class="meta"><span>${u.statuses} 帖</span></div>
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
  if (!state.following.length) { alert('先扫描一次'); return; }
  const a = analyzeData();
  const rate = a.total ? Math.round(a.mutual / a.total * 100) : 0;
  const d = new Date();
  let md = `# X 关注健康度报告（${d.toLocaleDateString('zh-CN')}）\n\n`;
  md += `- 关注总数：${a.total}\n- 互关：${a.mutual}\n- 未互关：${state.notFollow.length}\n- 互关率：${rate}%\n- 疑似僵尸/营销号：${a.zombies.length}\n\n`;
  md += `## 疑似僵尸/营销号\n\n| @用户名 | 粉丝 | 帖数 | 原因 |\n|---|---|---|---|\n`;
  a.zombies.forEach(u => { md += `| @${u.screen_name} | ${u.followers} | ${u.statuses} | ${u.reasons.join('、')} |\n`; });
  md += `\n## 最活跃 Top 5\n\n`;
  a.activeTop.forEach((u, i) => { md += `${i + 1}. @${u.screen_name} — ${u.statuses} 帖\n`; });
  md += `\n## 最不活跃 Top 5\n\n`;
  a.inactiveTop.forEach((u, i) => { md += `${i + 1}. @${u.screen_name} — ${u.statuses} 帖\n`; });
  downloadText(`X关注助手_分析报告_${Date.now()}.md`, md);
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
    st.textContent = '还没检查过粉丝变化，点「检查粉丝变化」建立首次快照';
    $('anTrackLost').style.display = 'none';
    $('anTrackGained').style.display = 'none';
    return;
  }
  const t = new Date(d.checkedAt);
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  st.textContent = `上次检查 ${timeStr} · 当前粉丝 ${d.total}` +
    (d.prevTotal != null ? `（上次 ${d.prevTotal}，取关 ${d.lost.length} / 新增 ${d.gained.length}）` : '（首次快照）');
  renderTrackList($('anLostList'), d.lost, '没有发现取关');
  renderTrackList($('anGainedList'), d.gained, '没有新粉丝');
  $('anTrackLost').style.display = d.lost.length ? '' : 'none';
  $('anTrackGained').style.display = d.gained.length ? '' : 'none';
}

$('anTrackBtn').onclick = async () => {
  const btn = $('anTrackBtn');
  btn.disabled = true; btn.textContent = '抓取粉丝中...';
  $('anTrackStatus').textContent = '正在抓取粉丝列表（约 1-3 分钟）...';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TRACK_FOLLOWERS' });
    if (r && r.ok) await renderFollowers();
    else $('anTrackStatus').textContent = '检查失败: ' + (r?.error || '未知');
  } catch (e) {
    $('anTrackStatus').textContent = '检查失败: ' + String(e.message || e);
  }
  btn.disabled = false; btn.textContent = '检查粉丝变化';
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FOLLOWERS_PROGRESS') {
    const st = $('anTrackStatus');
    if (st && !st.textContent.startsWith('检查失败')) st.textContent = `正在抓取粉丝列表... 已抓取 ${msg.n} 人`;
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
    box.innerHTML = '<div class="empty">没有符合过滤条件的未互关账号</div>';
  } else {
    list.slice(0, 200).forEach(u => {
      const el = document.createElement('div');
      el.className = 'item';
      if (state.selected.has(u.id)) el.classList.add('selected');
      const wl = state.whitelist.some(w => (typeof w === 'object' ? w.id === u.id : w === u.id)) ? ' · 白名单' : '';
      el.innerHTML = `
        <div class="avatar">${(u.name || '?')[0]}</div>
        <div class="info">
          <div class="name">${u.name}${wl}</div>
          <div class="handle">@${u.screen_name}</div>
          <div class="meta"><span>${u.followers} 粉</span><span>${u.statuses} 帖</span></div>
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
  const filterNote = list.length !== state.notFollow.length ? `，过滤后 ${list.length}` : '';
  $('listInfo').textContent = `共 ${state.notFollow.length} 个未互关${filterNote}` + (list.length > 200 ? '，显示前 200' : '');
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

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    ['clean','task','whitelist','analyze','settings'].forEach(p => {
      $('panel-' + p).style.display = p === t.dataset.tab ? '' : 'none';
    });
    if (t.dataset.tab === 'task') { pollTask(); renderHistory(); }
    else if (t.dataset.tab === 'analyze') renderAnalysis();
  };
});

async function startTask() {
  if (state.selected.size === 0) return;
  const targets = state.notFollow.filter(u => state.selected.has(u.id)).map(u => ({ id: u.id, screen_name: u.screen_name }));
  const r = await chrome.runtime.sendMessage({ type: 'START_TASK', targets });
  if (r && r.ok) {
    $('taskBox').style.display = '';
    $('taskEmpty').style.display = 'none';
    $('taskCount').textContent = `接受 ${r.data.accepted} 个（跳过 ${r.data.skipped}：超上限）`;
    $('taskStatus').textContent = '进行中';
    state.selected.clear();
    updateSel();
    pollTask();
  } else {
    alert('启动失败: ' + (r?.error || '未知'));
  }
}

async function pollTask() {
  const r = await chrome.runtime.sendMessage({ type: 'TASK_STATUS' });
  if (!r || !r.ok || !r.data) { $('taskEmpty').style.display = ''; return; }
  const t = r.data;
  $('taskBox').style.display = '';
  $('taskEmpty').style.display = 'none';
  $('taskStatus').textContent = t.paused ? '已暂停' : (t.done >= t.total ? '完成 ✓' : '进行中');
  $('taskProgress').style.width = (t.total ? Math.round(t.done / t.total * 100) : 0) + '%';
  $('taskCount').textContent = `${t.done} / ${t.total}`;
  const log = $('taskLog');
  log.innerHTML = '';
  t.log.forEach(l => {
    const div = document.createElement('div');
    div.className = l.type;
    div.textContent = l.text;
    log.appendChild(div);
  });
  if (t.done < t.total) setTimeout(pollTask, 2000);
}

$('unfollowBtn').onclick = startTask;
$('selectAllLink').onclick = selectAll;
$('refreshBtn').onclick = scan;

$('pauseBtn').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'PAUSE_TASK' });
  if (r && r.ok) $('taskStatus').textContent = r.paused ? '已暂停' : '进行中';
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
      <button class="btn ghost" style="padding:3px 10px;font-size:11px">移除</button>`;
    div.querySelector('button').onclick = async () => {
      state.whitelist = state.whitelist.filter(x => (typeof x === 'object' ? x.id !== id : x !== id));
      await saveWl();
      renderWhitelist();
    };
    box.appendChild(div);
  });
  if (state.whitelist.length === 0) box.innerHTML = '<div class="empty">暂无白名单账号</div>';
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
    btn.disabled = true; btn.textContent = '解析中...';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'RESOLVE_USER', screen_name: v });
      if (r && r.ok) {
        state.whitelist.push({ id: r.data.id, screen_name: r.data.screen_name });
        $('wlInput').value = '';
        await saveWl();
        renderWhitelist();
      } else {
        alert('解析失败: ' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('解析失败: ' + String(e.message || e));
    }
    btn.disabled = false; btn.textContent = '添加';
  }
};
$('wlInput').onkeydown = (e) => { if (e.key === 'Enter') $('wlAddBtn').click(); };

init();
