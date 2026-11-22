'use strict';
// 仅分析匿名局部坐标摘要；不读取页面、网络或全局比赛状态。
const COACH_WINDOW_MS = 30000;
const COACH_MAX_DURATION_MS = 5400000;
const COACH_MAX_GAP_MS = 12000;
const COACH_KNOT = 1.94384;

function coachMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
}

function coachRound(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? (rounded === 0 ? 0 : rounded) : value;
}

function coachWindow(points, courseLength) {
  if (points.length < 4) return null;
  const first = points[0], last = points[points.length - 1];
  const span = (last.t - first.t) / 1000;
  if (span < 20 || points.some(p => p.y < courseLength * 0.05 || p.y > courseLength * 0.95)) return null;
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], gap = b.t - a.t;
    if (gap <= 0 || gap > COACH_MAX_GAP_MS) return null;
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / (gap / 1000);
    if (!Number.isFinite(speed)) return null;
    steps.push(speed);
  }
  const netSpeed = Math.hypot(last.x - first.x, last.y - first.y) / span;
  const baseline = Math.min(coachMedian(steps), netSpeed);
  if (!Number.isFinite(baseline) || steps.some(s => s > Math.max(10, baseline * 4))) return null;
  const meanT = points.reduce((sum, p) => sum + (p.t - first.t) / 1000, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const p of points) {
    const dt = (p.t - first.t) / 1000 - meanT;
    numerator += dt * (p.y - meanY);
    denominator += dt * dt;
  }
  const speed = numerator / denominator * COACH_KNOT;
  if (last.y <= first.y || !Number.isFinite(speed) || speed <= 0) return null;
  const side = points.every(p => p.x < -25) ? 'left'
    : points.every(p => p.x > 25) ? 'right' : 'center';
  // 同一船窗只归入一个进度档，避免把跨档的一艘船重复计数。
  const progress = coachMedian(points.map(p => p.y)) / courseLength;
  return { side, bin: Math.min(4, Math.floor(progress * 5)), speed };
}

function coachCircularMean(points) {
  if (!points.length) return null;
  let x = 0, y = 0;
  for (const p of points) {
    x += Math.cos(p.from * Math.PI / 180);
    y += Math.sin(p.from * Math.PI / 180);
  }
  if (Math.hypot(x, y) / points.length < 1e-6) return null;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function coachWindSummary(raw, start, end) {
  const seen = new Set();
  const points = (Array.isArray(raw) ? raw : []).filter(p => {
    if (!p || !Number.isFinite(p.t) || p.t < start || p.t > end || seen.has(p.t)
        || !Number.isFinite(p.from) || p.from < 0 || p.from > 360) return false;
    seen.add(p.t);
    return true;
  }).sort((a, b) => a.t - b.t);
  const out = { sample_count: points.length, shift_deg: null, first_from_deg: null,
    last_from_deg: null, median_speed_kn: null };
  if (!points.length) return out;
  const first = points[0].t, last = points[points.length - 1].t;
  const firstMean = coachCircularMean(points.filter(p => p.t <= first + 30000));
  const lastMean = coachCircularMean(points.filter(p => p.t >= last - 30000));
  out.first_from_deg = firstMean === null ? null : coachRound(firstMean) % 360;
  out.last_from_deg = lastMean === null ? null : coachRound(lastMean) % 360;
  const speeds = points.map(p => p.spd * COACH_KNOT)
    .filter((speed, i) => Number.isFinite(points[i].spd) && points[i].spd >= 0 && Number.isFinite(speed));
  out.median_speed_kn = coachRound(coachMedian(speeds));
  if (points.length >= 3 && last - first >= 60000 && firstMean !== null && lastMean !== null) {
    out.shift_deg = coachRound(((lastMean - firstMean + 540) % 360) - 180);
  }
  return out;
}

function analyzeCoachSession(session) {
  const data = session && typeof session === 'object' ? session : {};
  const scopes = ['first_upwind_leg', 'first_lap', 'first_race'];
  const scope = scopes.includes(data.scope) ? data.scope : 'first_upwind_leg';
  const validTime = Number.isFinite(data.startedAt) && Number.isFinite(data.endedAt)
    && data.startedAt > 0 && data.endedAt >= data.startedAt;
  const start = validTime ? data.startedAt : 0;
  const duration = validTime ? Math.min(COACH_MAX_DURATION_MS, data.endedAt - start) : 0;
  const end = start + duration;
  const length = Number.isFinite(data.courseLength) && data.courseLength > 0 ? data.courseLength : 0;
  const result = {
    version: 1, scope, duration_s: coachRound(duration / 1000), course_length_m: coachRound(length),
    boat_count: 0, sample_count: 0, paired_windows: 0, paired_groups: 0,
    left: { boat_count: 0, window_count: 0, median_progress_kn: null },
    right: { boat_count: 0, window_count: 0, median_progress_kn: null },
    comparison: { favored: 'insufficient', median_delta_kn: null, left_win_share: null, confidence: 'insufficient' },
    wind: { sample_count: 0, shift_deg: null, first_from_deg: null, last_from_deg: null, median_speed_kn: null },
    own: { window_count: 0, median_progress_kn: null, left_share: null },
    quality: { coverage_ratio: 0, rejected_samples: Number.isFinite(data.rejectedSamples)
      ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(data.rejectedSamples))) : 0,
    gap_count: 0, geometry_changed: !!data.geometryChanged },
  };
  if (!validTime || duration <= 0) return result;
  result.wind = coachWindSummary(data.wind, start, end);
  const isMap = Object.prototype.toString.call(data.tracks) === '[object Map]';
  if (!isMap) return result;
  const entries = [...data.tracks.entries()];
  // 输入超过限制时优先保留本船；只输出数量，不输出这些内部标识。
  const ownIndex = entries.findIndex(([key]) => key === data.ownKey);
  if (ownIndex > 0) entries.unshift(entries.splice(ownIndex, 1)[0]);
  const windows = new Map(), ownWindows = [];
  let budget = 100000, coverage = 0;
  const reject = n => { result.quality.rejected_samples = Math.min(Number.MAX_SAFE_INTEGER,
    result.quality.rejected_samples + n); };
  for (let index = 0; index < entries.length; index++) {
    const [key, raw] = entries[index];
    if (!Array.isArray(raw)) continue;
    if (index >= 80) { reject(raw.length); continue; }
    const take = Math.min(raw.length, budget);
    budget -= take;
    reject(raw.length - take);
    const candidates = [];
    for (let i = 0; i < take; i++) {
      const p = raw[i];
      if (!p || !Number.isFinite(p.t) || p.t < start || p.t > end
          || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { reject(1); continue; }
      candidates.push({ t: p.t, x: p.x, y: p.y });
    }
    candidates.sort((a, b) => a.t - b.t);
    const points = candidates.filter((p, i) => {
      if (i && p.t === candidates[i - 1].t) { reject(1); return false; }
      return true;
    });
    if (!points.length) continue;
    result.boat_count++;
    result.sample_count += points.length;
    if (key === data.ownKey) {
      // 覆盖率量的是有效定位上报覆盖时长，不把整个30秒窗当作连续有数。
      for (let i = 1; i < points.length; i++) {
        const gap = points[i].t - points[i - 1].t;
        if (gap <= COACH_MAX_GAP_MS) coverage += gap;
        else result.quality.gap_count++;
      }
    }
    if (!length) continue;
    const buckets = new Map();
    for (const p of points) {
      const window = Math.floor((p.t - start) / COACH_WINDOW_MS);
      if (!buckets.has(window)) buckets.set(window, []);
      buckets.get(window).push(p);
    }
    for (const [window, samples] of buckets) {
      const item = coachWindow(samples, length);
      if (!item) continue;
      if (key === data.ownKey) ownWindows.push(item);
      if (item.side === 'center') continue;
      if (!windows.has(window)) windows.set(window, new Map());
      const bins = windows.get(window);
      if (!bins.has(item.bin)) bins.set(item.bin, { left: [], right: [] });
      bins.get(item.bin)[item.side].push({ key, speed: item.speed });
    }
  }
  result.quality.coverage_ratio = coachRound(Math.min(1, Math.max(0, coverage / duration)));
  result.own.window_count = ownWindows.length;
  result.own.median_progress_kn = coachRound(coachMedian(ownWindows.map(p => p.speed)));
  result.own.left_share = ownWindows.length
    ? coachRound(ownWindows.filter(p => p.side === 'left').length / ownWindows.length) : null;
  const boats = { left: new Set(), right: new Set() };
  const sideWindows = { left: [], right: [] }, deltas = [];
  for (const bins of windows.values()) {
    const groupDeltas = [], speeds = { left: [], right: [] };
    for (const group of bins.values()) {
      if (group.left.length < 2 || group.right.length < 2) continue;
      result.paired_groups++;
      for (const side of ['left', 'right']) {
        result[side].window_count += group[side].length;
        group[side].forEach(p => boats[side].add(p.key));
        speeds[side].push(coachMedian(group[side].map(p => p.speed)));
      }
      groupDeltas.push(speeds.left[speeds.left.length - 1] - speeds.right[speeds.right.length - 1]);
    }
    if (groupDeltas.length) {
      deltas.push(coachMedian(groupDeltas));
      for (const side of ['left', 'right']) sideWindows[side].push(coachMedian(speeds[side]));
    }
  }
  result.paired_windows = deltas.length;
  for (const side of ['left', 'right']) {
    result[side].boat_count = boats[side].size;
    result[side].median_progress_kn = coachRound(coachMedian(sideWindows[side]));
  }
  if (result.quality.geometry_changed || deltas.length < 3 || boats.left.size < 2 || boats.right.size < 2) return result;
  const delta = coachMedian(deltas);
  const leftWins = deltas.filter(d => d > 0).length / deltas.length;
  const rightWins = deltas.filter(d => d < 0).length / deltas.length;
  const favored = Math.abs(delta) < 0.3 ? 'even' : delta > 0 ? 'left' : 'right';
  const winShare = favored === 'left' ? leftWins : favored === 'right' ? rightWins : 0;
  result.comparison = { favored, median_delta_kn: coachRound(delta), left_win_share: coachRound(leftWins),
    confidence: deltas.length >= 6 && boats.left.size >= 3 && boats.right.size >= 3 && winShare >= 2 / 3
      ? 'moderate' : 'low' };
  return result;
}
