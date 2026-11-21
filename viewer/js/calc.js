'use strict';
// 预判线、起航线方位、1 标 layline
/* ---------- 预判 ---------- */
// 船不主动改方位时的航迹。
//   没有流:就是船方位(航向)的直线延伸,拿最近一段轨迹算方位、用对地速度。
//   有流:  船自己的速度沿方位不变,再加一个水流矢量;
//          漂移是慢慢加上来的(水先推着船走,船身要一会儿才跟上),
//          所以船边上有段弯,越远越直 —— 这就是曲的那一小段。
const PRED_SEC = 120;          // 往前看两分钟
const PRED_STEP = 3;           // 每 3 秒算一次
const DRIFT_TAU = 25;          // 漂移追上来要多久(秒)

function predict(dv, seconds) {
  // 最近 8 帧只拿来兜底(没有上报航向/停船),不做平均
  const h = (S.hist.get(dv.key) || []).slice(-8);
  let series = null;
  if (h.length >= 3) {
    const a = h[0], b = h[h.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, (b.t - a.t) / 1000);
    if (dist > 2) series = { brg: Math.atan2(dx, -dy), spd: dist / dt };
  }
  // 方位直接吃上报的航向 —— 船会突然转向,预判线要跟着一下转过去
  const hasHdg = dv.hdg !== null && dv.hdg !== undefined;
  const bearing = hasHdg ? dv.hdg * D2R : (series ? series.brg : null);
  const speed = (dv.spd && dv.spd > 0.15) ? dv.spd : (series ? series.spd : 0);
  if (bearing === null || speed <= 0.15) return null;

  const p = project(dv.lat, dv.lng);
  const cur = S.cur || {};
  const hasCur = cur.spd > 0.01 && cur.dir !== null;
  const vx = Math.sin(bearing) * speed;      // 船自己的速度(m/s,世界坐标)
  const vy = -Math.cos(bearing) * speed;
  let cvx = 0, cvy = 0;
  if (hasCur) {                              // 水流速度(kn -> m/s)
    const mps = cur.spd / KNOT;
    cvx = Math.sin(cur.dir * D2R) * mps;
    cvy = -Math.cos(cur.dir * D2R) * mps;
  }

  const pts = [];
  let x = p.x, y = p.y;
  for (let t = PRED_STEP; t <= seconds + 1e-9; t += PRED_STEP) {
    const ramp = hasCur ? 1 - Math.exp(-t / DRIFT_TAU) : 0;
    x += (vx + cvx * ramp) * PRED_STEP;
    y += (vy + cvy * ramp) * PRED_STEP;
    pts.push({ x, y, t });
  }
  return { bearing, speed, start: p, pts, hasCur };
}

/* ---------- 起航线:方位、风轴、有利端 ---------- */
function markByName(re) {
  for (const dv of S.dev.values()) if (dv.kind === 'mark' && re.test(dv.name || '')) return dv;
  return null;
}

function startEnds() {
  let A = markByName(/起航线\s*A/i) || markByName(/start\s*A\b/i);
  let B = markByName(/起航线\s*B/i) || markByName(/start\s*B\b/i);
  if (!A || !B) {
    const st = [...S.dev.values()].filter(d => d.kind === 'mark' && /start|起航/i.test(d.name || ''));
    if (st.length >= 2) {
      if (!A) A = st[0];
      if (!B) B = st.find(d => d !== A);
    }
  }
  return A && B && A !== B ? [A, B] : null;
}

// 标点能说出来的「风往哪边」= 起航线法线里指向一标(上风标)的那一条;
// 再跟风力仪的实测风向对一下,差多少就是要看的偏差。
function startInfo() {
  const ends = startEnds();
  if (!ends) return null;
  const [A, B] = ends;
  const pa = project(A.lat, A.lng), pb = project(B.lat, B.lng);
  const dx = pb.x - pa.x, dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy);
  const lineBrg = brg360(dx, dy);
  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };

  // 法线:两条,取指向一标的那条
  let normal = { x: Math.sin((lineBrg + 90) * D2R), y: -Math.cos((lineBrg + 90) * D2R) };
  const m1 = markByName(/^1$/) || markByName(/^1[^a-z]/i);
  if (m1) {
    const p1 = project(m1.lat, m1.lng);
    const v = { x: p1.x - mid.x, y: p1.y - mid.y };
    if (normal.x * v.x + normal.y * v.y < 0) normal = { x: -normal.x, y: -normal.y };
  }
  const axisBrg = brg360(normal.x, normal.y);

  const out = { A, B, pa, pb, len, lineBrg, mid, normal, axisBrg,
    windFrom: S.wind && S.wind.from !== null ? S.wind.from : null,
    windAge: S.wind && S.wind.ts ? nowMs() - S.wind.ts : null,
    fav: null, adv: 0, biasAbs: 0, delta: null, windSide: null };
  if (out.windFrom === null) return out;

  const u = { x: Math.sin(out.windFrom * D2R), y: -Math.cos(out.windFrom * D2R) };  // 上风方向
  const proj = dx * u.x + dy * u.y;
  out.fav = proj > 0 ? 'B' : 'A';
  out.adv = Math.abs(proj);
  out.biasAbs = Math.abs(Math.asin(clamp(proj / (len || 1), -1, 1)) * 180 / Math.PI);
  out.delta = norm180(Math.atan2(u.x * normal.y - u.y * normal.x,
    u.x * normal.x + u.y * normal.y) * 180 / Math.PI);
  // 风落在起航线的哪一侧
  out.windSide = norm180(out.windFrom - lineBrg) > 0 ? '右' : '左';
  return out;
}

function updateBias() {
  const node = el('bias');
  const b = S.bias;
  let html;
  if (!b) {
    html = '起航线:没找到标点';
  } else {
    const w = b.windFrom;
    const seg = [];
    seg.push(`<b>起航线</b> ${b.len.toFixed(0)} m · ${b.lineBrg.toFixed(0)}°`);
    if (w === null) {
      seg.push('风:没有数据');
    } else {
      const kn = S.wind.spd === null ? '—' : (S.wind.spd * KNOT).toFixed(1);
      const old = b.windAge !== null && b.windAge > 60000;
      seg.push(`<b>风</b> ${w.toFixed(0)}° ${kn} kn${old ? ` <span class="dn">(${Math.round(b.windAge / 60000)} 分钟前的)</span>` : ''}`);
      seg.push(`标点轴 ${b.axisBrg.toFixed(0)}° · <b>偏差 ${Math.abs(b.delta).toFixed(1)}°</b>`);
      seg.push(`有利端 <span class="fav">${b.fav === 'A' ? '起航线A' : '起航线B'}</span> +${b.adv.toFixed(0)} m`);
    }
    html = seg.join('<span class="sep">|</span>');
  }
  if (html !== S.biasHtml) { node.innerHTML = html; S.biasHtml = html; }
}

function drawStart() {
  const b = S.bias;
  if (!b) return;
  const a = toScreen(b.pa), c = toScreen(b.pb);
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(111,179,255,.85)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  for (const [p, which] of [[a, 'A'], [c, 'B']]) {
    const fav = b.fav === which;
    ctx.fillStyle = fav ? '#5ad1a0' : '#6fb3ff';
    ctx.beginPath(); ctx.arc(p.x, p.y, fav ? 6 : 5, 0, Math.PI * 2); ctx.fill();
    if (fav) {
      ctx.strokeStyle = 'rgba(90,209,160,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.stroke();
    }
    label('起航线' + which + (fav ? ' ↑上风' : ''), p.x + 9, p.y - 7, fav ? '#5ad1a0' : '#9fc8ff');
  }
  if (b.windFrom !== null) {
    const m = toScreen(b.mid);
    const u = { x: Math.sin(b.windFrom * D2R), y: -Math.cos(b.windFrom * D2R) };
    const L = 110;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(111,179,255,.5)'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(m.x - u.x * L, m.y - u.y * L);
    ctx.lineTo(m.x + u.x * L, m.y + u.y * L);
    ctx.stroke();
    // 上风那端画个箭头(风从那边来)
    const ex = m.x + u.x * L, ey = m.y + u.y * L;
    const ang = Math.atan2(u.x, -u.y);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(111,179,255,.8)';
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.sin(ang - .4) * 9, ey + Math.cos(ang - .4) * 9);
    ctx.lineTo(ex - Math.sin(ang + .4) * 9, ey + Math.cos(ang + .4) * 9);
    ctx.closePath(); ctx.fill();
  }
}

/* ---------- 1 标 layline ---------- */
// layline:从标往回收的两条线,沿着它跑刚好能贴着标到,不用再换舷。
// 角度不用风力仪(这台仪器的数一直在飘,跟航线差 30 多度),改用**标位关系**:
// 起点线中点 → 1 标 的方位 = 这一段的上风轴,左右各让开一个迎风角。
// 另一条颜色 = 这个水流下实际要对上的路径(对地航迹),差多少标成跑高/跑低。
const LAY_TWA = 45;
const C_LAY = '#c79bff';             // 紫色:layline
const C_ACT = '#ff9f43';             // 橙色:有流时实际要对的路径

function layAxis() {
  const m = mark1();
  if (!m) return null;
  const pm = project(m.lat, m.lng);
  let from = null;
  const ends = startEnds();
  if (ends) {
    const a = project(ends[0].lat, ends[0].lng), b = project(ends[1].lat, ends[1].lng);
    from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (!from) {                        // 退一步:两个下风门标的中点
    const ps = markByName(/^4s$/i), pp = markByName(/^4p$/i);
    if (ps && pp) {
      const a = project(ps.lat, ps.lng), b = project(pp.lat, pp.lng);
      from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  if (!from) return null;
  return { pm, from, brg: brg360(pm.x - from.x, pm.y - from.y) };
}

function laylines() {
  const ax = layAxis();
  if (!ax) return null;
  const pm = ax.pm;

  let sum = 0, n = 0;                 // 参考船速:全队在跑的船的平均
  for (const dv of S.dev.values()) {
    if (dv.kind === 'boat' && dv.spd > 0.5) { sum += dv.spd; n++; }
  }
  const s = n ? sum / n : 5 / KNOT;

  const cur = S.cur || {};
  const hasCur = cur.spd > 0.01 && cur.dir !== null;
  const mps = hasCur ? cur.spd / KNOT : 0;
  const cx = hasCur ? Math.sin(cur.dir * D2R) * mps : 0;
  const cy = hasCur ? -Math.cos(cur.dir * D2R) * mps : 0;

  const out = { pm, axis: ax.brg, s, hasCur, lines: [] };
  for (const side of [-1, 1]) {
    const hdgDeg = (ax.brg + side * LAY_TWA + 360) % 360;
    const h = hdgDeg * D2R;
    const ux = Math.sin(h), uy = -Math.cos(h);          // 船头朝标走的方向
    let gx = ux, gy = uy;
    if (hasCur) {
      const L = Math.hypot(ux * s + cx, uy * s + cy) || 1;
      gx = (ux * s + cx) / L; gy = (uy * s + cy) / L;   // 对地航迹
    }
    const a0 = Math.abs(norm180(hdgDeg - ax.brg));
    const a1 = Math.abs(norm180(brg360(gx, gy) - ax.brg));
    const d = a0 - a1;                                  // 正 = 线往上风挪
    out.lines.push({ side: side < 0 ? '右舷' : '左舷', hdg: hdgDeg, ux, uy, gx, gy, d,
      hi: d >= 0 ? '高' : '低' });
  }
  return out;
}

function drawLaylines() {
  if (!S.showLay) return;
  const L = laylines();
  if (!L) { el('layTxt').textContent = 'layline —'; return; }
  const m = toScreen(L.pm);
  el('layTxt').textContent = `layline ${LAY_TWA}° · 轴 ${L.axis.toFixed(0)}°(标位)`
    + (L.hasCur ? ` · 按 ${(L.s * KNOT).toFixed(1)} kn` : '');

  // 从标往画布边上走,标注放在边上往回一点
  const edge = (dx, dy, back) => {
    const W = S.W, H = S.H, pad = 10;
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - pad - m.x) / dx);
    if (dx < -1e-6) t = Math.min(t, (pad - m.x) / dx);
    if (dy > 1e-6) t = Math.min(t, (H - pad - m.y) / dy);
    if (dy < -1e-6) t = Math.min(t, (pad - m.y) / dy);
    if (!Number.isFinite(t) || t < 0) t = 0;
    const ex = m.x + dx * t, ey = m.y + dy * t;
    return { end: { x: ex, y: ey }, at: { x: ex - dx * back, y: ey - dy * back } };
  };

  for (const ln of L.lines) {
    const ua = edge(-ln.ux, -ln.uy, 96);           // 紫色:layline
    ctx.setLineDash([5, 5]); ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(199,155,255,.55)';
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(ua.end.x, ua.end.y); ctx.stroke();
    ctx.setLineDash([]);
    label(`1标 ${ln.side} ${LAY_TWA}°`, ua.at.x - 30, ua.at.y + 4, C_LAY);

    if (!L.hasCur) continue;
    const uc = edge(-ln.gx, -ln.gy, 190);          // 橙色:有流时实际要对的路径
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,159,67,.85)';
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(uc.end.x, uc.end.y); ctx.stroke();
    const txt = Math.abs(ln.d) < 0.5 ? '实际路径 没变'
      : `实际路径 跑${ln.hi} ${Math.abs(ln.d).toFixed(0)}°`;
    label(txt, uc.at.x - 52, uc.at.y + 4, C_ACT);
  }
}



function mark1() {
  return markByName(/^1$/) || markByName(/^1[^0-9a-z]/i) || markByName(/^1\b/);
}
