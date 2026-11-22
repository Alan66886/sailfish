'use strict';
// 按钮和下拉的接线、水流输入框
let activeSheet = null, sheetOpener = null, sheetBackground = [];
function closeSheet() {
  if (!activeSheet) return;
  const sheet = el(activeSheet);
  sheet.classList.remove('open');
  sheet.hidden = true;
  sheet.removeAttribute('role'); sheet.removeAttribute('aria-modal');
  el('sheetBackdrop').classList.remove('open');
  for (const [node, inert] of sheetBackground) node.inert = inert;
  sheetBackground = [];
  if (sheetOpener) sheetOpener.setAttribute('aria-expanded', 'false');
  activeSheet = null;
  if (sheetOpener && sheetOpener.offsetParent !== null) sheetOpener.focus();
  sheetOpener = null;
}
function openSheet(id, opener) {
  const wasOpen = activeSheet === id;
  closeSheet();
  if (wasOpen) return;
  activeSheet = id; sheetOpener = opener;
  const sheet = el(id);
  sheet.hidden = false;
  sheet.classList.add('open');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  el('sheetBackdrop').classList.add('open');
  sheetBackground = ['top', 'mapStage', 'raceDeck', 'startAssist', 'coachPanel', 'morePage', 'dashboardPage', 'mobileNav']
    .map(el)
    .filter(node => node && !node.contains(sheet)).map(node => [node, node.inert]);
  for (const [node] of sheetBackground) node.inert = true;
  if (sheetOpener) sheetOpener.setAttribute('aria-expanded', 'true');
  const closeButton = sheet.querySelector('.sheet-close');
  if (closeButton) closeButton.focus();
}
function showScreen(screen) {
  const allowed = ['race', 'start', 'tactics', 'more', 'dashboard'];
  if (!allowed.includes(screen)) return;
  closeSheet();
  S.screen = screen;
  document.body.dataset.screen = screen;
  const visibility = {
    mapStage: screen === 'race' || screen === 'start', raceDeck: screen === 'race',
    startAssist: screen === 'start', coachPanel: screen === 'tactics',
    morePage: screen === 'more', dashboardPage: screen === 'dashboard',
  };
  for (const [id, visible] of Object.entries(visibility)) el(id).hidden = !visible;
  for (const [id, target] of [['navRace', 'race'], ['navStart', 'start'], ['navTactics', 'tactics'], ['navMore', 'more']]) {
    const selected = screen === target || (target === 'more' && screen === 'dashboard');
    el(id).setAttribute('aria-current', selected ? 'page' : 'false');
    el(id).classList.toggle('active', selected);
  }
  el('dashboardOpen').setAttribute('aria-pressed', String(screen === 'dashboard'));
  if (visibility.mapStage) {
    S.view.fitNow = true;
    requestAnimationFrame(resize);
  }
  refreshAppReadouts();
}

function setAppTheme(theme) {
  S.theme = theme === 'night' ? 'night' : 'day';
  document.documentElement.dataset.theme = S.theme;
  el('themeToggle').setAttribute('aria-pressed', String(S.theme === 'day'));
  el('themeToggle').setAttribute('aria-label', S.theme === 'day' ? '切换夜间模式' : '切换强光日间模式');
  el('themeToggle').setAttribute('title', S.theme === 'day' ? '日间高对比 · 切换夜间' : '夜间 · 切换日间高对比');
  const themeLabel = el('themeToggle').querySelector('span');
  if (themeLabel) themeLabel.textContent = S.theme === 'day' ? '日间' : '夜间';
  try { localStorage.setItem('sailfish.theme', S.theme); } catch (_) {}
}

function restoreAppTheme() {
  let saved = 'day';
  try { saved = localStorage.getItem('sailfish.theme') || 'day'; } catch (_) {}
  setAppTheme(saved);
}

function updateMapWeather(now) {
  const wind = S.wind;
  const validTime = wind && Number.isFinite(wind.ts) && wind.ts > 0 && wind.ts <= now;
  const age = validTime ? Math.floor((now - wind.ts) / 1000) : null;
  const valid = validTime && now - wind.ts <= TACTIC_MAX_AGE_MS
    && Number.isFinite(wind.from) && wind.from >= 0 && wind.from < 360
    && Number.isFinite(wind.spd) && wind.spd >= 0 && wind.spd <= 100;
  if (valid) {
    const compass = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const direction = compass[Math.round(wind.from / 45) % 8];
    setText('windTxt', `${(wind.spd * KNOT).toFixed(1)} kn · ${direction}`);
    setText('mapWindState', `风从 ${Math.round(wind.from)}° · ${age}秒前`);
  } else {
    setText('windTxt', '风况 —');
    setText('mapWindState', age === null ? '暂无有效风数据' : `${dataAgeText(age)}前 · 已过期`);
  }
  el('mapWindState').classList.toggle('stale', !valid);
}

function refreshAppReadouts() {
  const now = nowMs(), boat = S.dev.get(S.focusBoat);
  updateMapDataState(now);
  const officialLink = el('officialMapLink');
  if (officialLink) officialLink.setAttribute('href', S.race?.raceCd
    ? 'https://www.saill.cn/sf-admin/html/race/live/open_trac.html?raceCd=' + encodeURIComponent(S.race.raceCd)
    : 'https://www.saill.cn/');
  const prediction = boat && S.anchor && S.showPred && predictionFresh(boat, now) ? predict(boat, PRED_SEC) : null;
  updatePredictionInfo(boat, prediction, now);
  updateMapWeather(now);
  const onBoat = S.view.mode === 'boat' && S.view.follow;
  el('mapLocate').setAttribute('aria-label', onBoat ? '回到全场' : '跟随我的船');
  el('mapLocate').setAttribute('aria-pressed', String(onBoat));
  const locateLabel = el('mapLocate').querySelector('span');
  if (locateLabel) locateLabel.textContent = onBoat ? '全场' : '本船';
  if (typeof refreshDashboard === 'function') refreshDashboard(now);
}

function dataAgeText(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`;
}

function updateMapDataState(now) {
  const node = el('mapDataState');
  if (!node) return;
  const boats = [...S.dev.values()].filter(d => d.kind === 'boat');
  const valid = boats.map(d => d.ts).filter(ts => Number.isFinite(ts) && ts > 0 && ts <= now);
  const latest = valid.length ? Math.max(...valid) : null;
  node.hidden = !boats.length || latest !== null && now - latest <= PRED_MAX_AGE_MS;
  if (!node.hidden) {
    node.textContent = latest === null ? '官方位置时间无效 · 等待设备上报'
      : '官方位置未更新 · 最后上报 ' + new Date(latest).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
  }
}

for (const [id, screen] of [['navRace', 'race'], ['navStart', 'start'], ['navTactics', 'tactics'],
  ['navMore', 'more'], ['dashboardOpen', 'dashboard'], ['dashboardMore', 'dashboard'],
  ['dashGoRace', 'race'], ['dashGoStart', 'start'], ['dashGoTactics', 'tactics'], ['dashGoMore', 'more']]) {
  el(id).onclick = () => showScreen(screen);
}
el('themeToggle').onclick = () => setAppTheme(S.theme === 'day' ? 'night' : 'day');
el('listBtn').onclick = e => openSheet('list', e.currentTarget);
el('cfgBtn').onclick = () => showScreen('more');
el('navList').onclick = e => openSheet('list', e.currentTarget);
el('navSettings').onclick = () => { showScreen('more'); el('sel').focus(); };
el('coachOpen').onclick = () => showScreen('tactics');
el('cfgClose').onclick = () => showScreen('race');
el('listClose').onclick = closeSheet;
el('coachClose').onclick = () => showScreen('race');
el('layerClose').onclick = closeSheet;
el('mapLayers').onclick = e => openSheet('layerPanel', e.currentTarget);
el('mapLocate').onclick = () => {
  if (S.view.mode === 'boat' && S.view.follow) resetView();
  else if (!focusMyBoat()) { el('boatSel').focus(); return; }
  refreshAppReadouts();
};
el('sheetBackdrop').onclick = closeSheet;
el('navBoat').onclick = () => {
  showScreen('race');
  const sel = el('boatSel'); sel.focus();
  try { if (sel.showPicker) sel.showPicker(); } catch (_) {}
};
el('navFollow').onclick = () => { resetView(); showScreen('race'); };
for (const [id, key] of [['layerTrails', 'trails'], ['layerLabels', 'labels'],
  ['layerOtherPredictions', 'otherPredictions'], ['layerGrid', 'grid']]) {
  el(id).checked = S.layers[key];
  el(id).onchange = e => { S.layers[key] = e.target.checked; };
}
el('analysisToggle').onclick = () => {
  const on = document.body.classList.toggle('analysis-open');
  el('analysisToggle').setAttribute('aria-pressed', String(on));
  el('analysisToggle').textContent = on ? '隐藏起航线详情' : '起航线详情';
  closeSheet();
};
document.addEventListener('keydown', e => {
  if (!activeSheet) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const nodes = [...el(activeSheet).querySelectorAll('button, select, input')]
    .filter(n => !n.disabled && n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!el(activeSheet).contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
el('follow').onclick = () => {
  S.view.follow = !S.view.follow;
  if (S.view.follow) S.view.fitNow = true;
  el('follow').textContent = '自动框住:' + (S.view.follow ? '开' : '关');
};
el('pred').onclick = () => {
  S.showPred = !S.showPred;
  el('pred').textContent = '预判线:' + (S.showPred ? '开' : '关');
  el('pred').setAttribute('aria-pressed', String(S.showPred));
};
el('lay').onclick = () => {
  S.showLay = !S.showLay;
  el('lay').textContent = '1标layline:' + (S.showLay ? '开' : '关');
  el('lay').setAttribute('aria-pressed', String(S.showLay));
};
el('sel').onchange = e => loadRounds(e.target.value);
el('round').onchange = e => selectRace(e.target.value);
el('boatSel').onchange = e => {
  S.focusBoat = e.target.value;
  if (S.focusBoat) focusMyBoat();
  else resetView();
  refreshAppReadouts();
};

function updateBoatPicker() {
  const boats = [...S.dev.values()].filter(d => d.kind === 'boat');
  const signature = JSON.stringify(boats.map(d => [d.key, d.name]));
  if (signature === S.boatOptions) return;
  S.boatOptions = signature;
  const sel = el('boatSel');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = '选择我的船';
  sel.appendChild(placeholder);
  for (const dv of boats) {
    const o = document.createElement('option');
    o.value = dv.key; o.textContent = dv.name;
    sel.appendChild(o);
  }
  if (!boats.some(d => d.key === S.focusBoat)) S.focusBoat = '';
  sel.value = S.focusBoat;
}

function updatePredictionInfo(dv, pr, now) {
  let text = '选择“我的船”查看30秒 / 1分钟航程';
  if (!S.showPred) text = '航程预判已关闭';
  else if (dv) {
    const age = Number.isFinite(dv.ts) && dv.ts > 0 ? now - dv.ts : null;
    const name = dv.name + ' · ';
    if (age === null || age < 0) text = name + '数据时间未知，暂不预判';
    else if (age > PRED_MAX_AGE_MS) text = name + '数据已过期，暂停预判';
    else if (!pr) text = name + '静止或航向 / 速度不足，暂不预判';
    else {
      const p30 = pr.pts.find(p => p.t === 30), p60 = pr.pts.find(p => p.t === 60);
      text = name + `30秒 ≈ ${Math.round(p30.distance)}米 · 1分钟 ≈ ${Math.round(p60.distance)}米`
        + `｜按${Math.floor(age / 1000)}秒前上报位置起算，保持航向 / 速度`
        + (pr.hasCur ? ' · 含手动水流假设' : '');
    }
  }
  const node = el('predInfo');
  if (node.textContent !== text) node.textContent = text;
  updateRaceDeck(dv, pr, now);
}

function setText(id, text) {
  const node = el(id);
  if (node.textContent !== text) node.textContent = text;
}

function updateRaceDeck(dv, pr, now) {
  const fresh = !!dv && predictionFresh(dv, now);
  const age = dv && Number.isFinite(dv.ts) && dv.ts > 0 && dv.ts <= now
    ? Math.floor((now - dv.ts) / 1000) : null;
  setText('deckFresh', !dv ? '未选船' : age === null ? '时间未知' : `${dataAgeText(age)}前上报`);
  el('deckFresh').classList.toggle('stale', !!dv && (!fresh || now - dv.ts > TACTIC_MAX_AGE_MS));
  setText('speedValue', fresh && Number.isFinite(dv.spd) && dv.spd >= 0
    ? (dv.spd * KNOT).toFixed(1) : '—');
  const p30 = pr && pr.pts.find(p => p.t === 30), p60 = pr && pr.pts.find(p => p.t === 60);
  setText('distance30', p30 ? String(Math.round(p30.distance)) : '—');
  setText('distance60', p60 ? String(Math.round(p60.distance)) : '—');
  const tactics = boatTactics(dv, now);
  setText('startDistance', tactics.startDistance === null ? '—' : String(Math.round(tactics.startDistance)));
  setText('markDistance', tactics.markDistance === null ? '—' : String(Math.round(tactics.markDistance)));
  setText('markProgress', tactics.markProgress === null ? '—' : tactics.markProgress.toFixed(1));
  el('markProgress').style.color = tactics.markProgress < 0 ? 'var(--danger)' : '';
  let note = '先选择自己的船，查看航程和比赛位置。';
  if (dv) {
    if (!fresh) note = '数据过期或时间无效，等待新位置后恢复。';
    else {
      const predictionNote = !S.showPred ? '航程预判已关闭'
        : !pr ? '航程需有效航向和速度'
        : '航程从最新上报位置起算，保持当前航向 / 速度';
      note = predictionNote + (pr && pr.hasCur ? '（含手动水流假设）' : '')
        + '。' + tactics.note;
    }
  }
  S.fullDeckNote = note;
  S.tacticsNote = tactics.note;
  let compact = !dv ? '选择我的船，查看30秒与1分钟预估位置'
    : !fresh ? '数据已过期或时间无效 · 预判暂停'
    : !S.showPred ? '航程预判已关闭'
    : !pr ? '等待有效航向与速度'
    : `从${age}秒前位置外推 · 保持航向/速度` + (pr.hasCur ? ' · 含手动水流' : '');
  setText('deckNote', compact);
  el('navFollow').setAttribute('aria-pressed', String(S.view.follow));
  updateStartAssist(dv, now);
}

/* ---------- 水流输入 ---------- */
function readCur() {
  const d = num(el('curDir').value);
  const s = num(el('curSpd').value);
  S.cur.dir = d === null ? null : ((d % 360) + 360) % 360;
  S.cur.spd = s === null ? 0 : Math.max(0, s);
  const on = S.cur.dir !== null && S.cur.spd > 0.01;
  el('curTxt').textContent = on
    ? `流 ${S.cur.dir.toFixed(0)}° ${S.cur.spd.toFixed(1)} kn`
    : '流 —';
}
el('curDir').oninput = readCur;
el('curSpd').oninput = readCur;
readCur();
// 链接里也能带水流:?cur=90,1.2(去向度,节)
function curFromQP() {
  const q = new URLSearchParams(location.search).get('cur');
  if (!q) return;
  const [d, s] = q.split(',');
  if (d !== undefined) el('curDir').value = d.trim();
  if (s !== undefined) el('curSpd').value = s.trim();
  readCur();
}
curFromQP();
restoreAppTheme();
