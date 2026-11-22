'use strict';
// 总览只复用现有仪表与统计，不发请求、不录制、不生成新的航行判断。
function dashboardAge(timestamp, now) {
  return Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(now) && now >= timestamp
    ? Math.floor((now - timestamp) / 1000) : null;
}

function dashboardNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function dashboardDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '时长未知';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}分${String(whole % 60).padStart(2, '0')}秒`;
}

function dashboardBrief(value, limit = 160) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function dashboardSet(id, value) {
  const node = el(id), text = typeof value === 'string' && value ? value : '—';
  if (node && node.textContent !== text) node.textContent = text;
}

function dashboardRead(id) {
  const text = el(id)?.textContent;
  return typeof text === 'string' && text.trim() ? text.trim() : '—';
}

function dashboardWind(wind, now) {
  const age = dashboardAge(wind?.ts, now);
  const valid = age !== null && now - wind.ts <= 10000
    && Number.isFinite(wind.from) && wind.from >= 0 && wind.from < 360
    && Number.isFinite(wind.spd) && wind.spd >= 0 && wind.spd <= 100;
  const note = !wind ? '尚无风力仪数据'
    : age === null ? '风力仪时间未知或无效'
    : now - wind.ts > 10000 ? `${dataAgeText(age)}前上报，已过期，不作当前风况`
    : !valid ? `${dataAgeText(age)}前上报，风读数无效`
    : `${dataAgeText(age)}前上报 · 风力仪来向`;
  return { direction: valid ? dashboardNumber(wind.from) + '°' : '—',
    speed: valid ? dashboardNumber(wind.spd * KNOT, 1) + ' kn' : '—', note };
}

function dashboardFleet(devices, now) {
  const boats = devices.filter(d => d.kind === 'boat');
  const online = boats.filter(d => dashboardAge(d.ts, now) !== null && now - d.ts <= 30000
    && Number.isFinite(d.lat) && Math.abs(d.lat) <= 90
    && Number.isFinite(d.lng) && Math.abs(d.lng) <= 180).length;
  return { online, total: boats.length };
}

function dashboardModelStatus(service, busy, standalone) {
  if (standalone) return '单文件模式 · 可本地分析，AI需打开服务端页面';
  if (!service) return 'AI服务未连接或暂不可用 · 本地统计仍可用';
  if (!service.configured) return 'AI未配置 · 可先查看本地统计';
  const model = dashboardBrief(service.model, 80) || '已配置模型';
  return busy ? `AI解读中 · ${model}` : `AI已配置 · ${model} · 手动点击才调用`;
}

function dashboardReportView(report, raceCd) {
  const summary = report?.summary;
  if (!summary) return { verdict: '—', evidence: '还没有已完成报告，请到记录范围结束时再分析。',
    time: '—', note: '统计只针对手动录制的样本，不自动判断圈数或名次。' };
  const comparison = summary.comparison || {}, quality = summary.quality || {};
  const titles = { left: '样本内：左侧推进较快', right: '样本内：右侧推进较快',
    even: '样本内：两侧无明显差异', insufficient: '证据不足，暂不选边' };
  const favored = quality.geometry_changed ? 'insufficient' : comparison.favored;
  let verdict = titles[favored] || titles.insufficient;
  const analysis = favored !== 'insufficient' && titles[favored] ? report.analysis : null;
  const brief = dashboardBrief(analysis?.summary);
  if (brief) verdict += '。AI：' + brief;
  let evidence = `有效配对 ${dashboardNumber(summary.paired_windows)} 个30秒窗 · `
    + `左 ${dashboardNumber(summary.left?.boat_count)} 艘 / 右 ${dashboardNumber(summary.right?.boat_count)} 艘`;
  const strength = favored === 'insufficient' ? '不足'
    : comparison.confidence === 'moderate' ? '中' : comparison.confidence === 'low' ? '低' : '未评级';
  evidence += ` · 证据强度：${strength}`;
  const firstEvidence = Array.isArray(analysis?.evidence)
    ? analysis.evidence.find(item => typeof item === 'string' && item.trim()) : '';
  if (firstEvidence) evidence += '。AI依据：' + dashboardBrief(firstEvidence, 120);
  else if (Number.isFinite(comparison.median_delta_kn)) {
    evidence += ` · 左减右中位推进差 ${dashboardNumber(comparison.median_delta_kn, 2)} kn`;
  }
  const scope = COACH_SCOPES[summary.scope] || '范围未知';
  const date = Number.isFinite(report.createdAt) && report.createdAt > 0
    ? new Date(report.createdAt).toLocaleString('zh-CN', { hour12: false }) : '记录时间未知';
  let time = `${scope} · ${date} · ${dashboardBrief(report.label, 100) || '原场次未记录'}`;
  if (report.analysis && typeof report.model === 'string' && report.model) time += ' · 模型 ' + dashboardBrief(report.model, 80);
  let note = !raceCd ? '历史报告；当前未选择场次，尚未核对适用性。'
    : !report.raceCd ? '历史报告未记录场次，尚未确认适用于当前场次。'
    : report.raceCd !== raceCd ? '其他场次的历史报告，不能直接用于当前场次。'
    : '已录制的历史样本，不代表当前或下一航段仍有同样优势。';
  note += '仅供之后同方向迎风航段参考，先复核当前风况和赛道。';
  if (quality.geometry_changed) note += '录制中参考航标明显移动，暂停选边。';
  return { verdict, evidence, time, note };
}

// 由主界面每秒调用；这里不另起定时器，也不绑定导航或请求事件。
function refreshDashboard(now = nowMs()) {
  const selected = S.dev.get(S.focusBoat);
  const boat = selected?.kind === 'boat' ? selected : null;
  const age = dashboardAge(boat?.ts, now);
  const fresh = !!boat && predictionFresh(boat, now);
  const positionFresh = !!boat && freshPosition(boat, now);
  const race = S.race;
  dashboardSet('dashRace', race ? [race.levelName, race.roundName].filter(Boolean).join(' · ') : '—');
  dashboardSet('dashBoat', boat ? boat.name || '已选本船' : '—');
  dashboardSet('dashFresh', !boat ? '未选择本船' : age === null ? '设备时间未知或无效'
    : !fresh ? `已过期 · ${dataAgeText(age)}前上报` : `${dataAgeText(age)}前上报`);
  dashboardSet('dashSpeed', fresh ? dashboardRead('speedValue') : '—');
  for (const [target, source] of [['dash30', 'distance30'], ['dash60', 'distance60']]) {
    dashboardSet(target, fresh && S.showPred ? dashboardRead(source) : '—');
  }
  const positionNote = S.tacticsNote || (boat ? boatTactics(boat, now).note : '');
  dashboardSet('dashPositionNote', !boat ? '先选择本船，位置参考需要有效船位和航标。'
    : positionNote || '等待有效船位、起航线和1标参考。');
  dashboardSet('dashDataNote', !boat ? '先选择自己的船，查看航程和比赛位置。'
    : !fresh ? '本船数据过期或时间无效，等待新位置后恢复航程预判。'
    : S.fullDeckNote || dashboardRead('deckNote'));

  const calibrated = Number.isFinite(S.startAt);
  dashboardSet('dashCountdownLabel', calibrated && now > S.startAt ? '手动起航后' : '距手动起航');
  const eta = positionFresh ? dashboardRead('startEta') : '—';
  dashboardSet('dashCountdown', calibrated ? dashboardRead('startCountdown') : '—');
  dashboardSet('dashEta', eta);
  dashboardSet('dashDelta', calibrated && eta !== '—' ? dashboardRead('startDelta') : '—');
  const clockLabel = calibrated ? (now >= S.startAt ? '手动起航后' : '距手动起航') + '。' : '';
  dashboardSet('dashStartNote', clockLabel + dashboardRead('startHint'));

  const wind = dashboardWind(S.wind, now);
  dashboardSet('dashWindDirection', wind.direction);
  dashboardSet('dashWindSpeed', wind.speed);
  dashboardSet('dashWindAge', wind.note);
  const current = S.cur || {};
  const hasCurrent = Number.isFinite(current.dir) && Number.isFinite(current.spd) && current.spd > 0.01;
  dashboardSet('dashCurrent', hasCurrent
    ? `去向 ${dashboardNumber(current.dir)}° · ${dashboardNumber(current.spd, 1)} kn（手动假设）`
    : '未设置手动水流假设');
  const fleet = dashboardFleet([...S.dev.values()], now);
  dashboardSet('dashFleet', fleet.total ? `${fleet.online} / ${fleet.total}` : '—');
  const snapshotAge = dashboardAge(S.lastMeta, now);
  const connection = S.errors > 0 ? `实时拉取失败 ×${S.errors}`
    : snapshotAge === null ? '等待实时快照'
    : snapshotAge > 5 ? `快照已${dataAgeText(snapshotAge)}未刷新` : `快照${dataAgeText(snapshotAge)}前更新`;
  dashboardSet('dashConnection', connection + ' · 船队在线按30秒内有效位置上报计');

  const session = coachState.session;
  const report = coachReport() || coachState.reports[0];
  const scope = session?.scope || report?.summary?.scope || el('coachScope')?.value;
  const elapsed = session && dashboardAge(session.startedAt, now);
  dashboardSet('dashRecording', session
    ? `记录中 · ${dashboardDuration(elapsed === null ? null : Math.min(elapsed, COACH_LIMIT_MS / 1000))}`
    : report ? `已完成样本 · ${dashboardDuration(report.summary?.duration_s)}` : '未在记录');
  dashboardSet('dashScope', COACH_SCOPES[scope] || '—');
  const reportView = dashboardReportView(report, race?.raceCd);
  dashboardSet('dashReport', reportView.verdict);
  dashboardSet('dashEvidence', reportView.evidence);
  dashboardSet('dashReportTime', reportView.time);
  dashboardSet('dashReportNote', reportView.note);
  dashboardSet('dashAIService', dashboardModelStatus(coachState.service, coachState.busy, DIRECT || !!API_BASE));
}
