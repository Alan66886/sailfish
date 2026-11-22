'use strict';
// 手动标记样本范围；原始轨迹只留在本页，AI只接收匿名汇总。
const COACH_LIMIT_MS = 90 * 60 * 1000;
const COACH_STORAGE = 'sailfish.coach.v1';
const COACH_SCOPES = { first_upwind_leg: '首个迎风段', first_lap: '第一圈', first_race: '第一场' };
const coachState = {
  session: null, reports: [], activeId: '', service: null, busy: false, message: '', aiStatus: null,
};

function loadCoachReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(COACH_STORAGE) || '[]');
    if (Array.isArray(saved)) coachState.reports = saved.filter(r => r && typeof r.id === 'string'
      && Number.isFinite(r.createdAt) && r.summary && r.summary.version === 1
      && COACH_SCOPES[r.summary.scope] && r.summary.comparison && r.summary.quality).slice(0, 8);
  } catch (_) { /* 存储不可用时，仍可在本页录制。 */ }
  coachState.activeId = coachState.reports[0]?.id || '';
}

function saveCoachReports() {
  try { localStorage.setItem(COACH_STORAGE, JSON.stringify(coachState.reports)); return true; }
  catch (_) { coachState.message = '浏览器无法保存报告；关闭页面前可导出摘要。'; return false; }
}

function coachReport() {
  return coachState.reports.find(r => r.id === coachState.activeId);
}

function coachGeometry(now) {
  const ends = startEnds(), target = mark1();
  if (!S.anchor || !ends || !ends.every(d => freshPosition(d, now)) || !freshPosition(target, now)) return null;
  const points = ends.map(d => project(d.lat, d.lng));
  const origin = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  const mark = project(target.lat, target.lng);
  const dx = mark.x - origin.x, dy = mark.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length < 100 || length > 20000) return null;
  return { origin, mark, length, ux: dx / length, uy: dy / length, bearing: brg360(dx, dy) };
}

function startCoachRecording() {
  if (coachState.session) return;
  const now = nowMs(), boat = S.dev.get(S.focusBoat), geometry = coachGeometry(now);
  if (!S.race || !boat || boat.kind !== 'boat' || !freshPosition(boat, now)) {
    coachState.message = '先选择本船，等待10秒以内的有效船位。';
  } else if (!el('coachConfirm').checked) {
    coachState.message = '请先根据现场航线确认迎风方向。';
  } else if (!geometry) {
    coachState.message = '需要有效的起航线两端和1标（10秒以内），且参考航段长100米至20公里。';
  } else {
    const scope = el('coachScope').value;
    coachState.session = {
      startedAt: now, scope: COACH_SCOPES[scope] ? scope : 'first_upwind_leg',
      courseLength: geometry.length, geometry, ownKey: boat.key, ownName: boat.name,
      raceCd: S.race.raceCd, gen: S.gen,
      label: [S.race.levelName, S.race.roundName].filter(Boolean).join(' · ').slice(0, 100),
      tracks: new Map(), seen: new Map(), wind: [], rejectedSamples: 0, geometryChanged: false,
    };
    coachState.message = '已开始记录；到本次选定范围结束时，点“结束并分析”。';
    captureCoachSample(now);
  }
  updateCoachUI();
}

function captureCoachSample(now) {
  const session = coachState.session;
  if (!session) return;
  if (session.gen !== S.gen) { finishCoachRecording('切换场次，已结束原样本。'); return; }
  if (now - session.startedAt >= COACH_LIMIT_MS) { finishCoachRecording('达到90分钟上限，已结束记录。'); return; }
  const geometry = coachGeometry(now), ref = session.geometry;
  if (geometry && (Math.hypot(geometry.origin.x - ref.origin.x, geometry.origin.y - ref.origin.y) > 25
      || Math.hypot(geometry.mark.x - ref.mark.x, geometry.mark.y - ref.mark.y) > 25)) {
    session.geometryChanged = true;
  }
  const boats = [...S.dev.values()].filter(d => d.kind === 'boat');
  boats.sort((a, b) => (b.key === session.ownKey) - (a.key === session.ownKey));
  for (const dv of boats) {
    if (!session.tracks.has(dv.key) && session.tracks.size >= 80) continue;
    if (session.seen.get(dv.key) === dv.ts) continue;
    session.seen.set(dv.key, dv.ts);
    if (!freshPosition(dv, now) || dv.ts < session.startedAt) {
      session.rejectedSamples = Math.min(100000, session.rejectedSamples + 1); continue;
    }
    const track = session.tracks.get(dv.key) || [];
    if (track.length && dv.ts - track[track.length - 1].t < 5000) continue;
    const p = project(dv.lat, dv.lng), dx = p.x - ref.origin.x, dy = p.y - ref.origin.y;
    track.push({ t: dv.ts, x: -ref.uy * dx + ref.ux * dy, y: ref.ux * dx + ref.uy * dy });
    session.tracks.set(dv.key, track);
  }
  const wind = S.wind, last = session.wind[session.wind.length - 1];
  if (wind && Number.isFinite(wind.ts) && wind.ts >= session.startedAt && now >= wind.ts
      && now - wind.ts <= 10000 && Number.isFinite(wind.from) && wind.from >= 0 && wind.from < 360
      && Number.isFinite(wind.spd) && wind.spd >= 0 && wind.spd <= 100
      && (!last || wind.ts - last.t >= 5000)) {
    session.wind.push({ t: wind.ts, from: wind.from, spd: wind.spd });
  }
}

function finishCoachRecording(reason) {
  const session = coachState.session;
  if (!session) return;
  session.endedAt = Math.max(session.startedAt, Math.min(nowMs(), session.startedAt + COACH_LIMIT_MS));
  const summary = analyzeCoachSession(session);
  const report = {
    id: String(session.startedAt) + '-' + Math.random().toString(36).slice(2, 8),
    createdAt: session.endedAt, raceCd: session.raceCd, label: session.label,
    bearing: Math.round(session.geometry.bearing), summary, analysis: null, model: '',
  };
  coachState.session = null;
  coachState.reports.unshift(report);
  coachState.reports = coachState.reports.slice(0, 8);
  coachState.activeId = report.id;
  coachState.message = reason || '已完成本地统计，可查看依据或请求AI解读。';
  saveCoachReports();
  refreshCoachHistory();
  updateCoachUI();
}

function resetCoachForRace() {
  finishCoachRecording('切换场次，已保存原场次样本；历史报告不能直接作为当前航线结论。');
  el('coachConfirm').checked = false;
  updateCoachUI();
}

function coachText(parent, tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.appendChild(node);
  return node;
}

function refreshCoachHistory() {
  const select = el('coachHistory');
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '选择已完成的报告'; select.appendChild(blank);
  for (const report of coachState.reports) {
    const option = document.createElement('option');
    option.value = report.id;
    option.textContent = `${new Date(report.createdAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${COACH_SCOPES[report.summary.scope]} · ${report.label || '本场'}`;
    select.appendChild(option);
  }
  select.value = coachState.activeId;
}

function renderCoachReport() {
  const report = coachReport(), box = el('coachLocal'), answer = el('coachAnswer');
  box.replaceChildren(); answer.replaceChildren();
  if (!report) { coachText(box, 'p', '还没有分析样本。请在范围开始时记录，结束时再分析。', 'coach-muted'); return; }
  const s = report.summary, cmp = s.comparison;
  coachText(box, 'h3', COACH_SCOPES[s.scope] + '样本');
  coachText(box, 'p', `${report.label || '本场'} · ${new Date(report.createdAt).toLocaleString('zh-CN', { hour12: false })}`, 'coach-muted');
  const titles = { left: '样本内：左侧推进较快', right: '样本内：右侧推进较快', even: '样本内：两侧无明显差异', insufficient: '证据不足，暂不选边' };
  coachText(box, 'strong', titles[cmp.favored] || titles.insufficient, 'coach-verdict');
  const value = n => Number.isFinite(n) ? n.toFixed(2) : '—';
  if (s.left && s.right) {
    coachText(box, 'p', `左侧 ${value(s.left.median_progress_kn)} kn · 右侧 ${value(s.right.median_progress_kn)} kn（沿参考航段的对地推进）`);
    coachText(box, 'p', `有效配对 ${s.paired_windows} 个30秒窗 · 左 ${s.left.boat_count} 艘 / 右 ${s.right.boat_count} 艘 · 本船覆盖 ${Math.round(s.quality.coverage_ratio * 100)}%`, 'coach-muted');
  }
  const confidence = { moderate: '中', low: '低', insufficient: '不足' };
  coachText(box, 'p', `证据强度：${confidence[cmp.confidence] || '不足'}。左右以起航线中点朝1标方向为准；已剔除中间区域和反向片段。`, 'coach-muted');
  if (s.quality.geometry_changed) coachText(box, 'p', '录制中参考航标移动超过25米，不能合并成同一赛道优势。', 'coach-warning');
  if (cmp.favored === 'insufficient') coachText(box, 'p', '至少需要3个独立可比时间窗，每侧2艘船；单侧样本或无法匹配时不生成选边建议。', 'coach-muted');
  if (s.wind && Number.isFinite(s.wind.shift_deg)) coachText(box, 'p', `样本首末风向变化 ${s.wind.shift_deg > 0 ? '+' : ''}${s.wind.shift_deg}°，这是历史测量，不代表下一航段风向。`, 'coach-muted');
  else coachText(box, 'p', '有效风数据不足，不能据此判断风摆或风压。', 'coach-muted');
  coachText(box, 'p', '后续参考：仅用于同方向迎风航段；先核对当前风况和赛道。推进差也可能来自船员操作、船型或交通，不能归因为水流或风压。', 'coach-muted');
  if (S.race && report.raceCd !== S.race.raceCd) coachText(box, 'p', '这是其他场次的历史报告，尚未确认适用于当前场次。', 'coach-warning');
  if (report.analysis) {
    coachText(answer, 'h3', 'AI解读 · ' + report.model);
    coachText(answer, 'p', report.analysis.summary);
    for (const [key, label] of [['evidence', '数据依据'], ['next_leg_plan', '下一同向航段可观察什么'], ['recheck_conditions', '何时重新判断']]) {
      coachText(answer, 'h4', label);
      const list = coachText(answer, 'ul', '');
      for (const item of report.analysis[key] || []) coachText(list, 'li', item);
    }
  }
}

let coachRenderKey = '';
function updateCoachUI() {
  const session = coachState.session, report = coachReport();
  if (session && nowMs() - session.startedAt >= COACH_LIMIT_MS) {
    finishCoachRecording('达到90分钟上限，已结束记录。'); return;
  }
  const seconds = session ? Math.max(0, Math.floor((nowMs() - session.startedAt) / 1000)) : 0;
  setText('coachStatus', session
    ? `记录中 ${Math.floor(seconds / 60)}分${seconds % 60}秒 · ${session.tracks.size}艘 · 本船 ${session.ownName}（录制时固定）`
    : coachState.message || '手动记录，最长90分钟；刷新页面会中止未完成记录。');
  el('coachScope').disabled = !!session;
  el('coachConfirm').disabled = !!session;
  el('coachStart').disabled = !!session;
  el('coachStop').disabled = !session;
  el('coachHistory').disabled = !!session;
  el('coachExport').disabled = !report;
  el('coachAsk').disabled = !!session || coachState.busy || !coachState.service?.configured
    || !report || report.summary.comparison.favored === 'insufficient';
  setText('coachAsk', coachState.busy ? 'AI分析中…' : report?.analysis ? '重新请求AI解读' : 'AI解读这份数据');
  setText('coachRequestStatus', report && coachState.aiStatus?.id === report.id ? coachState.aiStatus.text : '');
  const key = report ? JSON.stringify([report.id, report.analysis, report.model, S.race?.raceCd]) : 'none';
  if (key !== coachRenderKey) { coachRenderKey = key; renderCoachReport(); }
}

async function loadCoachService() {
  if (DIRECT || API_BASE) {
    setText('coachService', '单文件可记录和本地分析。AI解读需打开已配置AI的服务端页面，手机文件不保存密钥。');
    return;
  }
  try {
    const response = await fetch('/api/coach/status', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const status = await response.json();
    coachState.service = status;
    setText('coachService', status.configured
      ? `AI已配置：${status.model}。点击才会发送这份匿名统计，可能产生模型调用费用。`
      : 'AI尚未配置。可先记录并查看本地统计，服务端配置模型和凭证后刷新即可解读。');
  } catch (_) {
    coachState.service = null;
    setText('coachService', 'AI服务暂不可用，本地记录和统计仍可使用。');
  }
  updateCoachUI();
}

async function askCoachAI() {
  const report = coachReport();
  if (!report || coachState.busy || !coachState.service?.configured || report.summary.comparison.favored === 'insufficient') return;
  coachState.busy = true;
  coachState.aiStatus = { id: report.id, text: '正在解读这份已完成样本…' };
  updateCoachUI();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch('/api/coach/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coach-Token': coachState.service.token },
      body: JSON.stringify({ summary: report.summary }), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'AI分析失败');
    if (!result.analysis || typeof result.analysis.summary !== 'string'
        || !['evidence', 'next_leg_plan', 'recheck_conditions'].every(k => Array.isArray(result.analysis[k])
          && result.analysis[k].every(v => typeof v === 'string'))) throw new Error('AI返回格式无效');
    if (coachState.reports.includes(report)) {
      report.analysis = result.analysis; report.model = String(result.model || '已配置模型');
      if (saveCoachReports()) coachState.message = 'AI解读已保存到对应样本报告。';
    } else {
      coachState.message = '原样本已被最近8份报告替换，此次结果未写入其他报告。';
    }
  } catch (e) {
    coachState.message = e.name === 'AbortError' ? 'AI请求超时，请稍后重试；本地报告已保留。' : String(e.message).slice(0, 200);
  } finally {
    clearTimeout(timeout); coachState.busy = false;
    coachState.aiStatus = { id: report.id, text: coachState.message };
    updateCoachUI();
  }
}

function exportCoachReport() {
  const report = coachReport();
  if (!report) return;
  // 导出的文件同样不含船名、原始坐标、队伍ID或供应商凭证。
  const blob = new Blob([JSON.stringify({ summary: report.summary, analysis: report.analysis, model: report.model }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'sailfish-analysis.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el('coachStart').onclick = startCoachRecording;
el('coachStop').onclick = () => finishCoachRecording();
el('coachAsk').onclick = askCoachAI;
el('coachExport').onclick = exportCoachReport;
el('coachHistory').onchange = e => { coachState.activeId = e.target.value; updateCoachUI(); };
loadCoachReports();
refreshCoachHistory();
updateCoachUI();
loadCoachService();
setInterval(updateCoachUI, 1000);
