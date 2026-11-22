'use strict';
// 起航辅助：手动信号时刻 + 近期对地轨迹与有限起航线的交会。
const START_HORIZON_SEC = 120;
const START_NEAR_METRES = 5;

function intersectStartLine(p, velocity, a, b) {
  const u = { x: b.x - a.x, y: b.y - a.y };
  const cross = (v, w) => v.x * w.y - v.y * w.x;
  const denom = cross(velocity, u);
  if (Math.abs(denom) < 1e-8) return null;
  const offset = { x: a.x - p.x, y: a.y - p.y };
  const seconds = cross(offset, u) / denom;
  const fraction = cross(offset, velocity) / denom;
  return { seconds, fraction,
    point: { x: p.x + seconds * velocity.x, y: p.y + seconds * velocity.y } };
}

function startApproach(dv, now) {
  const unavailable = note => ({ eta: null, note });
  if (!dv) return unavailable('先选择自己的船，再查看预计到线时间。');
  if (!['toward', 'away'].includes(S.startDirection)) {
    return unavailable('先核对起航方向；未确认时不计算到线时间。');
  }
  if (!S.anchor || !freshPosition(dv, now)) return unavailable('本船位置超过10秒或无效，暂停到线估算。');
  const ends = startEnds();
  if (!ends) return unavailable('缺少起航线两端的位置。');
  if (!ends.every(m => freshPosition(m, now))) return unavailable('起航线端点超过10秒或无效，暂停到线估算。');
  const target = mark1();
  if (!freshPosition(target, now)) return unavailable('1标位置缺失或过期，无法核对所选起航方向。');
  const a = project(ends[0].lat, ends[0].lng), b = project(ends[1].lat, ends[1].lng);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < START_NEAR_METRES) return unavailable('起航线端点过近，无法可靠估算。');
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const m = project(target.lat, target.lng);
  let nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
  const toMark = (m.x - mid.x) * nx + (m.y - mid.y) * ny;
  if (Math.abs(toMark) < START_NEAR_METRES) return unavailable('1标接近起航线方向，无法区分两侧。');
  const flip = (toMark < 0 ? -1 : 1) * (S.startDirection === 'away' ? -1 : 1);
  nx *= flip; ny *= flip;
  const p = project(dv.lat, dv.lng);
  const side = (p.x - mid.x) * nx + (p.y - mid.y) * ny;
  if (side > START_NEAR_METRES) return unavailable('最新位置在所选赛道侧；返航不作为起航接近。');
  if (distanceToSegment(p, a, b) <= START_NEAR_METRES) return unavailable('最新位置距线约5米以内，暂停精确倒秒，请核对现场。');
  const velocity = recentGroundVelocity(dv);
  if (!velocity) return unavailable('需至少5秒有效运动轨迹；停船、低位移或定位跳变时暂停。');
  const approachSpeed = velocity.x * nx + velocity.y * ny;
  if (approachSpeed <= 0.2) return unavailable('近期运动未朝所选起航方向接近，或接近速度过低。');
  const hit = intersectStartLine(p, velocity, a, b);
  if (!hit || hit.fraction < 0 || hit.fraction > 1) return unavailable('当前航迹不会穿过两端之间的起航线段。');
  if (Math.min(hit.fraction, 1 - hit.fraction) * length < START_NEAR_METRES) {
    return unavailable('预计交点接近线端，暂不估算精确到线秒数。');
  }
  // 交会从设备采样时刻起算；扣掉数据年龄，统一为距离现在的时间。
  const age = (now - dv.ts) / 1000;
  const eta = hit.seconds - age;
  if (eta <= 0) return unavailable('预测交会时刻已过，等待新位置并核对现场。');
  const projectedNow = { x: p.x + velocity.x * age, y: p.y + velocity.y * age };
  if (distanceToSegment(projectedNow, a, b) <= START_NEAR_METRES) {
    return unavailable('按轨迹外推已接近起航线，请核对现场位置。');
  }
  if (eta > START_HORIZON_SEC) return unavailable('按近期轨迹，到线超过2分钟，暂不显示精确秒数。');
  return { eta, point: hit.point, note: '早晚相对手动起航时刻。假设保持近期运动、起航线不变；不作抢航判定。' };
}

function formatStartClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function calibrateStartClock(seconds, now) {
  if (!S.race || !Number.isFinite(seconds) || seconds <= 0) return;
  S.startAt = now + seconds * 1000;
}

function shiftStartClock(seconds) {
  if (Number.isFinite(S.startAt)) S.startAt += seconds * 1000;
}

function startTimeDifference(eta, remaining) {
  const delta = eta - remaining;
  const seconds = Math.round(Math.abs(delta));
  if (seconds === 0) return { text: '约同刻', state: 'near' };
  return { text: `${delta < 0 ? '早' : '晚'} ${seconds}秒`, state: delta < 0 ? 'early' : 'late' };
}

function updateStartAssist(dv, now) {
  const calibrated = Number.isFinite(S.startAt);
  const remaining = calibrated ? (S.startAt - now) / 1000 : null;
  const after = calibrated && remaining < 0;
  const time = calibrated ? formatStartClock(after ? Math.floor(-remaining) : remaining) : '—:—';
  setText('startCountdownLabel', after ? '手动起航后' : '距手动起航');
  setText('startCountdown', time);
  const approach = startApproach(dv, now);
  setText('startEta', approach.eta === null ? '—' : `约${Math.round(approach.eta)}秒`);
  const delta = calibrated && approach.eta !== null ? startTimeDifference(approach.eta, remaining) : null;
  setText('startDelta', delta ? delta.text : '—');
  el('startDelta').dataset.state = delta ? delta.state : '';
  setText('startSummary', calibrated
    ? `${after ? '已过' : '剩余'} ${time}` + (delta ? ' · ' + delta.text : '') : '未校准');
  setText('startHint', (!calibrated ? '按起航信号点5 / 4 / 1分钟校准。' : '') + approach.note);
  for (const id of ['startEarlier', 'startLater', 'startClear']) el(id).disabled = !calibrated;
  for (const id of ['startFive', 'startFour', 'startOne']) el(id).disabled = !S.race;
}

/* ---------- 起航操作 ---------- */
el('startToggle').onclick = () => {
  S.startOpen = !S.startOpen;
  el('startAssist').classList.toggle('open', S.startOpen);
  el('startToggle').setAttribute('aria-expanded', String(S.startOpen));
};
el('startDirection').onchange = e => { S.startDirection = e.target.value; };
for (const [id, seconds] of [['startFive', 300], ['startFour', 240], ['startOne', 60]]) {
  el(id).onclick = () => calibrateStartClock(seconds, nowMs());
}
el('startEarlier').onclick = () => shiftStartClock(-1);
el('startLater').onclick = () => shiftStartClock(1);
el('startClear').onclick = () => { S.startAt = null; };
