'use strict';
// 位置参考：只用设备位置和真实采样时间，不使用船头方向或手动水流。
const TACTIC_MAX_AGE_MS = 10000;

function freshPosition(dv, now) {
  return !!dv && Number.isFinite(dv.lat) && Math.abs(dv.lat) <= 90
    && Number.isFinite(dv.lng) && Math.abs(dv.lng) <= 180
    && Number.isFinite(dv.ts) && dv.ts > 0
    && now >= dv.ts && now - dv.ts <= TACTIC_MAX_AGE_MS;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1) return null;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function recentGroundVelocity(dv) {
  // 12秒窗口至少覆盖5秒、4个独立采样点；排除服务器补时和定位抖动。
  const seen = new Set();
  const h = (S.hist.get(dv.key) || []).filter(p => {
    if (!p.timed || !Number.isFinite(p.t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.t > dv.ts || p.t < dv.ts - 12000 || seen.has(p.t)) return false;
    seen.add(p.t);
    return true;
  }).sort((a, b) => a.t - b.t);
  if (h.length < 4) return null;
  const first = h[0], last = h[h.length - 1];
  if (last.t !== dv.ts || last.t - first.t < 5000
      || Math.hypot(last.x - first.x, last.y - first.y) < 3) return null;
  const stepSpeeds = h.slice(1).map((p, i) => Math.hypot(p.x - h[i].x, p.y - h[i].y)
    / ((p.t - h[i].t) / 1000));
  const sorted = [...stepSpeeds].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const netSpeed = Math.hypot(last.x - first.x, last.y - first.y) / ((last.t - first.t) / 1000);
  // 单次定位跳变不能变成醒目的推进读数；这是保守过滤，不是定位精度校准。
  // 少量采样时，一个孤立跳点会同时抬高两段速度，故也用净位移限制基线。
  if (stepSpeeds.some(speed => speed > Math.max(10, Math.min(median, netSpeed) * 4))) return null;
  const n = h.length;
  const meanT = h.reduce((s, p) => s + (p.t - first.t) / 1000, 0) / n;
  const meanX = h.reduce((s, p) => s + p.x, 0) / n;
  const meanY = h.reduce((s, p) => s + p.y, 0) / n;
  let denom = 0, vx = 0, vy = 0;
  for (const p of h) {
    const dt = (p.t - first.t) / 1000 - meanT;
    denom += dt * dt;
    vx += dt * (p.x - meanX); vy += dt * (p.y - meanY);
  }
  return denom > 0 ? { x: vx / denom, y: vy / denom } : null;
}

function boatTactics(dv, now) {
  const out = { startDistance: null, markDistance: null, markProgress: null, note: '' };
  if (!dv || !S.anchor) return out;
  if (!freshPosition(dv, now)) { out.note = '位置参考暂停：本船数据超过10秒或无效'; return out; }
  const p = project(dv.lat, dv.lng);
  const ends = startEnds();
  if (ends && ends.every(m => freshPosition(m, now))) {
    out.startDistance = distanceToSegment(p, project(ends[0].lat, ends[0].lng),
      project(ends[1].lat, ends[1].lng));
  }
  const m = mark1();
  if (!freshPosition(m, now)) {
    out.note = '1标位置缺失或过期，暂停对标计算';
    return out;
  }
  const target = project(m.lat, m.lng);
  const dx = target.x - p.x, dy = target.y - p.y;
  out.markDistance = Math.hypot(dx, dy);
  if (out.markDistance < 5) { out.note = '已接近1标位置，不再估算推进方向'; return out; }
  const velocity = recentGroundVelocity(dv);
  if (!velocity) {
    out.note = '推进需至少5秒有效轨迹；位移不足或跳变时暂停';
    return out;
  }
  out.markProgress = (velocity.x * dx + velocity.y * dy) / out.markDistance * KNOT;
  out.note = out.markProgress < 0
    ? '推进为负：正在远离当前1标方向'
    : '推进按近期轨迹估算；距离为位置参考';
  return out;
}
