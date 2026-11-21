'use strict';
// 画布尺寸、视图、网格、全部绘制、标签
/* ---------- 画 ---------- */
function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.W = r.width; S.H = r.height;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

function fit() {
  const pts = [...S.dev.values()].map(d => project(d.lat, d.lng));
  if (!pts.length) return;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of pts) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const pad = 40;
  const bw = Math.max(60, maxx - minx), bh = Math.max(60, maxy - miny);
  const k = Math.min((S.W - pad) / bw, (S.H - pad) / bh);
  const t = { k, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
  const v = S.view;
  v.k += (t.k - v.k) * 0.15;
  v.cx += (t.cx - v.cx) * 0.2;
  v.cy += (t.cy - v.cy) * 0.2;
}

const toScreen = p => ({
  x: S.W / 2 + (p.x - S.view.cx) * S.view.k,
  y: S.H / 2 + (p.y - S.view.cy) * S.view.k,
});

function gridStep() {
  // 每格尽量落在 10/20/50/100/200/500 米
  const target = 90 / S.view.k;   // 屏幕上约 90px 代表多少米
  const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const s of steps) if (s >= target) return s;
  return 10000;
}

function draw() {
  requestAnimationFrame(draw);
  if (!S.W) { resize(); return; }
  const { W, H } = S;
  ctx.fillStyle = '#0e2b33';
  ctx.fillRect(0, 0, W, H);
  if (!S.anchor || !S.dev.size) return;
  if (S.view.follow) fit();

  // 网格
  const step = gridStep();
  const origin = toScreen({ x: 0, y: 0 });
  ctx.strokeStyle = '#173a44';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = origin.x % (step * S.view.k); gx < W; gx += step * S.view.k) {
    ctx.moveTo(Math.round(gx) + .5, 0); ctx.lineTo(Math.round(gx) + .5, H);
  }
  for (let gy = origin.y % (step * S.view.k); gy < H; gy += step * S.view.k) {
    ctx.moveTo(0, Math.round(gy) + .5); ctx.lineTo(W, Math.round(gy) + .5);
  }
  ctx.stroke();
  el('scaleTxt').textContent = `网格 ${step} 米`;

  // 轨迹
  ctx.lineWidth = 1.4;
  for (const [key, h] of S.hist) {
    const dv = S.dev.get(key);
    if (!dv || dv.kind !== 'boat' || h.length < 2) continue;
    ctx.strokeStyle = hexA(dv.color, 0.55);
    ctx.beginPath();
    h.forEach((p, i) => {
      const s = toScreen(p);
      i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
    });
    ctx.stroke();
  }

  // 标
  for (const dv of S.dev.values()) {
    if (dv.kind !== 'mark') continue;
    const s = toScreen(project(dv.lat, dv.lng));
    ctx.fillStyle = dv.color; ctx.strokeStyle = '#0b1116'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    label(dv.name, s.x + 8, s.y + 4, '#8fd9bb');
  }

  // 起航线 / 风轴 / 有利端
  S.bias = startInfo();
  drawStart();
  updateBias();
  drawLaylines();

  // 预判线
  if (S.showPred) {
    ctx.lineWidth = 1.3;
    for (const dv of S.dev.values()) {
      if (dv.kind !== 'boat') continue;
      const pr = predict(dv, PRED_SEC);
      if (!pr || !pr.pts.length) continue;
      const a = toScreen(pr.start);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,123,107,.34)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      let last = a;
      for (const q of pr.pts) { const s = toScreen(q); ctx.lineTo(s.x, s.y); last = s; }
      ctx.stroke();
      ctx.setLineDash([]);
      // 30/60/90/120 秒落在哪
      ctx.fillStyle = 'rgba(255,123,107,.4)';
      for (const sec of [30, 60, 90, 120]) {
        if (sec > PRED_SEC) break;
        const q = pr.pts[Math.round(sec / PRED_STEP) - 1];
        if (!q) continue;
        const s = toScreen(q);
        ctx.beginPath(); ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2); ctx.fill();
      }
      if (pr.hasCur) {          // 有流的话,终点画个小方框,好跟无流的位置对比
        ctx.strokeStyle = 'rgba(255,123,107,.32)';
        ctx.lineWidth = 1;
        ctx.strokeRect(last.x - 2.5, last.y - 2.5, 5, 5);
        ctx.lineWidth = 1.3;
      }
    }
    ctx.setLineDash([]);
  }

  // 船
  const now = nowMs();
  for (const dv of S.dev.values()) {
    if (dv.kind !== 'boat') continue;
    const p = project(dv.lat, dv.lng);
    const s = toScreen(p);
    const stale = dv.ts && (now - dv.ts) > 30000;
    // 船头也直接吃上报航向,跟预判线对得上;没有航向才拿轨迹兜底
    let ang = 0;
    if (dv.hdg !== null && dv.hdg !== undefined) ang = dv.hdg * D2R;
    else {
      const h = (S.hist.get(dv.key) || []).slice(-6);
      if (h.length >= 2) {
        const dx = h[h.length - 1].x - h[0].x, dy = h[h.length - 1].y - h[0].y;
        if (Math.hypot(dx, dy) > 1.5) ang = Math.atan2(dx, -dy);
      }
    }
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ang);
    ctx.fillStyle = stale ? '#5a6b70' : dv.color;
    ctx.strokeStyle = '#06121a'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    label(dv.name, s.x + 9, s.y - 8, stale ? '#7f99a1' : '#dfeef2');
    if (!stale && dv.spd > 0.3) {
      label((dv.spd * KNOT).toFixed(1), s.x + 9, s.y + 6, '#9fb6bd');
    }
  }

  // 风的箭头(画在左上)
  if (S.wind && S.wind.from !== null) {
    const cx = 78, cy = 78, len = 40;
    const to = (S.wind.from + 180) * D2R;   // 气象风向是「从哪来」,箭头指去
    ctx.strokeStyle = '#6fb3ff'; ctx.fillStyle = '#6fb3ff'; ctx.lineWidth = 2;
    const ex = cx + Math.sin(to) * len, ey = cy - Math.cos(to) * len;
    ctx.beginPath(); ctx.moveTo(cx - Math.sin(to) * len * .7, cy + Math.cos(to) * len * .7);
    ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.sin(to - .4) * 10, ey + Math.cos(to - .4) * 10);
    ctx.lineTo(ex - Math.sin(to + .4) * 10, ey + Math.cos(to + .4) * 10);
    ctx.closePath(); ctx.fill();
    label('风 ' + S.wind.from.toFixed(0) + '° ' + (S.wind.spd * KNOT).toFixed(1) + 'kn', cx - 44, cy + 58, '#9fc8ff');
  }
}

// 手机屏上 11px 的标签看不清,按屏幕/指针类型放大
const COARSE = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
const LABEL_PX = (COARSE || document.documentElement.clientWidth < 620) ? 13 : 11;

function label(txt, x, y, color) {
  if (!txt) return;
  ctx.font = LABEL_PX + 'px -apple-system,"PingFang SC",Arial,sans-serif';
  ctx.fillStyle = 'rgba(8,16,20,.72)';
  const w = ctx.measureText(txt).width;
  ctx.fillRect(x - 2, y - LABEL_PX + 1, w + 4, LABEL_PX + 2);
  ctx.fillStyle = color || '#dfeef2';
  ctx.fillText(txt, x, y);
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,209,102,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
