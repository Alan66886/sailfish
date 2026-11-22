'use strict';
// 官网底图上叠加原设备坐标、轨迹与预判；不更换数据源。
const MAP_PALETTES = {
  day: { sea: '#e7f3f5', grid: '#bfd6dc', text: '#123841', muted: '#49616a',
    labelBg: 'rgba(255,255,255,.94)', labelBorder: '#8faeb8', own: '#e94b25', ownEdge: '#672710',
    halo: 'rgba(233,75,37,.15)', outline: '#ffffff', other: '#3d8193', otherEdge: '#173d49',
    start: '#076747', favored: '#075c34', mark: '#a45b00', wind: '#14698f',
    lay: '#7842a2', actual: '#a34516', stale: '#7e8d92', staleText: '#566b73',
    prediction: '#c73c19', otherPrediction: 'rgba(53,99,115,.36)', trail: 'rgba(176,55,25,.64)' },
  night: { sea: '#092630', grid: '#26454e', text: '#f2f8fa', muted: '#b4cbd3',
    labelBg: 'rgba(6,26,34,.94)', labelBorder: '#62818d', own: '#ff7952', ownEdge: '#fff2df',
    halo: 'rgba(255,121,82,.18)', outline: '#06151c', other: '#7bb5c8', otherEdge: '#e4f3f8',
    start: '#71e5b4', favored: '#a4f2be', mark: '#ffcf79', wind: '#91d1ed',
    lay: '#d1b3ff', actual: '#ffbd8d', stale: '#788c94', staleText: '#a5b9c1',
    prediction: '#ff9472', otherPrediction: 'rgba(144,190,207,.38)', trail: 'rgba(255,148,114,.72)' },
};
const MAP_DEFAULT_LAYERS = { trails: true, labels: false, otherPredictions: false, grid: false };
let mapOverlayBoxes = [];

function drawPalette() { return S.theme === 'night' ? MAP_PALETTES.night : MAP_PALETTES.day; }
function mapLayers() { return S.layers || MAP_DEFAULT_LAYERS; }
function mapLabelSize(kind) {
  if (kind === 'milestone' || kind === 'own') return 16;
  return S.W <= 760 ? 14 : 13;
}
function mapDeviceStale(dv, now) { return !dv || !predictionFresh(dv, now); }
function mapPositionValid(dv) {
  return dv && Number.isFinite(dv.lat) && Number.isFinite(dv.lng)
    && Math.abs(dv.lat) <= 90 && Math.abs(dv.lng) <= 180;
}

function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.W !== r.width || S.H !== r.height) S.view.fitNow = true;
  S.W = r.width; S.H = r.height;
  cacheMapOverlays();
}
function cacheMapOverlays() {
  const canvas = cv.getBoundingClientRect();
  const wind = el('windTxt');
  const nodes = [wind && wind.parentElement, el('mapLayers'), el('mapLocate')];
  const boxes = [];
  for (const node of nodes) {
    if (!node || typeof node.getBoundingClientRect !== 'function') continue;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height || !canvas.width || !canvas.height) continue;
    boxes.push({ x: r.left - canvas.left, y: r.top - canvas.top, width: r.width, height: r.height });
  }
  if (JSON.stringify(boxes) !== JSON.stringify(mapOverlayBoxes)) {
    mapOverlayBoxes = boxes; S.view.fitNow = true;
  }
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(cv);
if (typeof ResizeObserver !== 'undefined') {
  const overlays = new ResizeObserver(cacheMapOverlays), wind = el('windTxt');
  for (const node of [wind && wind.parentElement, el('mapLayers'), el('mapLocate')]) if (node) overlays.observe(node);
}

function mapViewport() {
  const overlayBottom = Math.max(0, ...mapOverlayBoxes.map(b => b.y + b.height));
  const top = S.H >= 300 ? Math.max(115, Math.min(140, overlayBottom + 14))
    : Math.min(Math.max(24, overlayBottom + 10), S.H * .28);
  const bottom = S.H >= 300 ? 62 : S.H >= 180 ? 40 : Math.min(24, S.H * .2);
  return { left: 10, right: Math.max(10, S.W - 10), top, bottom: Math.max(top, S.H - bottom) };
}

function mapFitPoints(focusPrediction) {
  const own = S.dev.get(S.focusBoat);
  const boatView = S.view.mode === 'boat' && mapPositionValid(own);
  const points = boatView ? [project(own.lat, own.lng)]
    : [...S.dev.values()].filter(mapPositionValid).map(d => project(d.lat, d.lng));
  if (focusPrediction) points.push(...focusPrediction.pts.filter(p => p.t <= 60));
  if (boatView) {
    const p = points[0];
    const reach = Math.max(150, ...points.map(q => Math.hypot(q.x - p.x, q.y - p.y)));
    // 只纳入附近的起航端点；远方赛场和船队不会把本船缩成一个点。
    for (const mark of startEnds() || []) {
      if (!mapPositionValid(mark)) continue;
      const q = project(mark.lat, mark.lng);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= Math.max(250, reach * 1.5)) points.push(q);
    }
  }
  return points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function fit(focusPrediction) {
  const points = mapFitPoints(focusPrediction);
  if (!points.length) return;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of points) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const own = S.dev.get(S.focusBoat);
  if (S.view.mode === 'boat' && mapPositionValid(own)) {
    const primary = [project(own.lat, own.lng), ...(focusPrediction ? focusPrediction.pts.filter(p => p.t <= 60) : [])];
    const centerX = (Math.min(...primary.map(p => p.x)) + Math.max(...primary.map(p => p.x))) / 2;
    const rx = Math.max(centerX - minx, maxx - centerX);
    // 横向优先居中本船；纵向使用实际范围，避免附近起航线制造大片空白。
    minx = centerX - rx; maxx = centerX + rx;
  }
  const bounds = mapViewport();
  const left = focusPrediction ? 45 : 28;
  const right = S.view.mode === 'boat' && focusPrediction ? Math.min(160, S.W * .42) : left;
  const minSpan = S.view.mode === 'boat' ? 100 : 60;
  const bw = Math.max(minSpan, maxx - minx), bh = Math.max(minSpan, maxy - miny);
  const k = clamp(Math.min(Math.max(1, S.W - left - right) / bw,
    Math.max(1, bounds.bottom - bounds.top - 24) / bh), 0.02, 20);
  const target = { k, cx: (minx + maxx) / 2 + (right - left) / (2 * k),
    cy: (miny + maxy) / 2 + (S.H - bounds.bottom - bounds.top) / (2 * k) };
  const v = S.view;
  if (v.fitNow) { Object.assign(v, target); v.fitNow = false; return; }
  v.k += (target.k - v.k) * .15;
  v.cx += (target.cx - v.cx) * .2;
  v.cy += (target.cy - v.cy) * .2;
}

const toScreen = p => ({
  x: S.W / 2 + (p.x - S.view.cx) * S.view.k,
  y: S.H / 2 + (p.y - S.view.cy) * S.view.k,
});

function gridStep() {
  const target = 90 / Math.max(.02, S.view.k);
  for (const step of [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) if (step >= target) return step;
  return 10000;
}

function mapVisible(p, margin = 30) {
  return p.x >= -margin && p.y >= -margin && p.x <= S.W + margin && p.y <= S.H + margin;
}

function draw() {
  requestAnimationFrame(draw);
  if (!Number.isFinite(S.W) || !Number.isFinite(S.H)) resize();
  if (S.W <= 0 || S.H <= 0) return;
  const palette = drawPalette(), layers = mapLayers(), now = nowMs();
  ctx.fillStyle = palette.sea;
  ctx.fillRect(0, 0, S.W, S.H);
  const predictions = new Map();
  if (S.showPred && S.anchor) {
    for (const dv of S.dev.values()) {
      if (dv.kind !== 'boat' || (!layers.otherPredictions && dv.key !== S.focusBoat)) continue;
      if (mapPositionValid(dv) && predictionFresh(dv, now)) {
        const pr = predict(dv, PRED_SEC);
        if (pr) predictions.set(dv.key, pr);
      }
    }
  }
  const focused = S.dev.get(S.focusBoat), focusPrediction = predictions.get(S.focusBoat);
  updatePredictionInfo(focused, focusPrediction, now);
  if (!S.anchor || !S.dev.size) {
    if (typeof drawOfficialBasemap === 'function') drawOfficialBasemap();
    return;
  }
  if (S.view.follow) fit(focusPrediction);
  if (typeof drawOfficialBasemap === 'function') drawOfficialBasemap();

  const step = gridStep(), spacing = step * S.view.k;
  if (layers.grid && Number.isFinite(spacing) && spacing > 0) {
    const origin = toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = palette.grid; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath();
    for (let x = ((origin.x % spacing) + spacing) % spacing; x < S.W; x += spacing) {
      ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, S.H);
    }
    for (let y = ((origin.y % spacing) + spacing) % spacing; y < S.H; y += spacing) {
      ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(S.W, Math.round(y) + .5);
    }
    ctx.stroke();
  }
  el('scaleTxt').textContent = layers.grid ? `网格 ${step} 米` : '北向上';

  if (layers.trails) {
    for (const [key, history] of S.hist) {
      const dv = S.dev.get(key), own = key === S.focusBoat;
      if (!dv || dv.kind !== 'boat' || history.length < 2 || (S.focusBoat && !own)) continue;
      ctx.lineWidth = own ? 2.8 : 1.2;
      ctx.strokeStyle = mapDeviceStale(dv, now) ? hexA(palette.stale, .55)
        : own ? palette.trail : hexA(dv.color || palette.other, .28);
      ctx.setLineDash([]); ctx.beginPath();
      history.forEach((p, i) => {
        const s = toScreen(p);
        if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
  }

  const startMarks = new Set(startEnds() || []);
  for (const dv of S.dev.values()) {
    if (dv.kind !== 'mark' || !mapPositionValid(dv) || startMarks.has(dv)) continue;
    const p = toScreen(project(dv.lat, dv.lng));
    if (!mapVisible(p, 12)) continue;
    const stale = mapDeviceStale(dv, now), firstMark = dv === mark1();
    ctx.fillStyle = stale ? palette.stale : palette.mark;
    ctx.strokeStyle = palette.outline; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, firstMark ? 9 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    label((firstMark ? '1标' : dv.name) + (stale ? ' · 旧' : ''), p.x + 12, p.y - 9,
      stale ? palette.staleText : palette.text, { size: firstMark ? 16 : mapLabelSize() });
  }

  S.bias = startInfo();
  drawStart(); updateBias(); drawLaylines();
  for (const [key, pr] of predictions) {
    const own = key === S.focusBoat;
    const points = own ? pr.pts.filter(p => p.t <= 60) : pr.pts;
    if (!points.length) continue;
    ctx.setLineDash(own ? [] : [5, 6]);
    ctx.strokeStyle = own ? palette.prediction : palette.otherPrediction;
    ctx.lineWidth = own ? 4 : 1.3;
    const start = toScreen(pr.start);
    ctx.beginPath(); ctx.moveTo(start.x, start.y);
    for (const p of points) { const s = toScreen(p); ctx.lineTo(s.x, s.y); }
    ctx.stroke(); ctx.setLineDash([]);
    if (!own) {
      ctx.fillStyle = palette.otherPrediction;
      for (const p of points.filter(q => q.t % 30 === 0)) {
        const s = toScreen(p);
        ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // 本船最后画，优先于邻船；没有名字图层时只保留“本船”提示。
  const boats = [...S.dev.values()].filter(d => d.kind === 'boat' && mapPositionValid(d));
  boats.sort((a, b) => Number(a.key === S.focusBoat) - Number(b.key === S.focusBoat));
  for (const dv of boats) drawBoat(dv, now, palette, layers);
  if (focusPrediction) drawPredictionMilestones(focusPrediction);
}

function drawBoat(dv, now, palette, layers) {
  const p = toScreen(project(dv.lat, dv.lng));
  if (!mapVisible(p, 30)) return;
  const own = dv.key === S.focusBoat, stale = mapDeviceStale(dv, now);
  let angle = 0;
  if (Number.isFinite(dv.hdg)) angle = dv.hdg * D2R;
  else {
    const history = (S.hist.get(dv.key) || []).slice(-6);
    if (history.length >= 2) {
      const dx = history[history.length - 1].x - history[0].x;
      const dy = history[history.length - 1].y - history[0].y;
      if (Math.hypot(dx, dy) > 1.5) angle = Math.atan2(dx, -dy);
    }
  }
  if (own) {
    ctx.fillStyle = stale ? hexA(palette.stale, .16) : palette.halo;
    ctx.beginPath(); ctx.arc(p.x, p.y, 27, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(angle);
  const scale = own ? 1 : .62;
  ctx.scale(scale, scale);
  ctx.fillStyle = stale ? palette.stale : dv.color || palette.other;
  ctx.strokeStyle = stale ? palette.staleText : own ? palette.ownEdge : palette.otherEdge;
  ctx.lineWidth = own ? 3 : 2.6;
  // 保留原版朝航向的三角船形与接口赛队颜色。
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(11, 13); ctx.lineTo(0, 7);
  ctx.lineTo(-11, 13); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  if (own || layers.labels) {
    const name = own && !layers.labels ? '本船' : dv.name;
    label(name + (stale ? ' · 旧' : ''), p.x + (own ? 19 : 13), p.y + (own ? 28 : -12),
      stale ? palette.staleText : palette.text, { size: own ? 16 : mapLabelSize(), maxWidth: 160 });
  }
}

function mapLabelOverlap(a, b) {
  return a.x < b.x + b.width + 6 && a.x + a.width + 6 > b.x
    && a.y < b.y + b.height + 6 && a.y + a.height + 6 > b.y;
}

function mapMilestoneLabels(pr) {
  const labels = [], bounds = mapViewport(), size = mapLabelSize('milestone');
  ctx.font = `700 ${size}px -apple-system,"PingFang SC",Arial,sans-serif`;
  for (const sec of [30, 60]) {
    const q = pr.pts.find(p => p.t === sec);
    if (!q) continue;
    const point = toScreen(q);
    if (!mapVisible(point, 0)) continue;
    const text = `${sec === 60 ? '1分钟' : '30秒'} · ${Math.round(q.distance)}米`;
    const width = ctx.measureText(text).width + 12, height = size + 10;
    const candidates = [
      { x: point.x + 14, y: point.y - height - 10 },
      { x: point.x + 14, y: point.y + 12 },
      { x: point.x - width - 14, y: point.y - height - 10 },
      { x: point.x - width - 14, y: point.y + 12 },
    ];
    for (const previous of labels) {
      candidates.push({ x: previous.box.x, y: previous.box.y - height - 8 },
        { x: previous.box.x, y: previous.box.y + previous.box.height + 8 },
        { x: previous.box.x - width - 8, y: previous.box.y },
        { x: previous.box.x + previous.box.width + 8, y: previous.box.y });
    }
    for (const candidate of candidates) {
      const box = { x: clamp(candidate.x, bounds.left, Math.max(bounds.left, bounds.right - width)),
        y: clamp(candidate.y, bounds.top, Math.max(bounds.top, bounds.bottom - height)), width, height };
      if (box.x + width > bounds.right || box.y + height > bounds.bottom) continue;
      if (mapOverlayBoxes.some(overlay => mapLabelOverlap(box, overlay))) continue;
      if (labels.some(p => mapLabelOverlap(box, p.box))) continue;
      labels.push({ point, text, sec, box });
      break;
    }
  }
  return labels;
}

function drawPredictionMilestones(pr) {
  const palette = drawPalette();
  for (const sec of [30, 60]) {
    const p = pr.pts.find(q => q.t === sec);
    if (!p) continue;
    const s = toScreen(p);
    if (!mapVisible(s, 0)) continue;
    ctx.fillStyle = palette.outline; ctx.strokeStyle = palette.prediction; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(s.x, s.y, sec === 60 ? 8 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  for (const item of mapMilestoneLabels(pr)) {
    const { point, box } = item;
    ctx.strokeStyle = palette.prediction; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(point.x, point.y);
    ctx.lineTo(clamp(point.x, box.x, box.x + box.width), clamp(point.y, box.y, box.y + box.height)); ctx.stroke();
    label(item.text, box.x + 6, box.y + 21, palette.text,
      { size: 16, weight: 700, background: palette.labelBg, border: palette.prediction, clamp: false });
  }
}

function label(text, x, y, color, options = {}) {
  if (!text) return;
  const palette = drawPalette(), size = options.size || mapLabelSize();
  ctx.font = `${options.weight || 600} ${size}px -apple-system,"PingFang SC",Arial,sans-serif`;
  let content = String(text);
  if (options.maxWidth) {
    while (content.length > 1 && ctx.measureText(content).width > options.maxWidth) content = content.slice(0, -2) + '…';
  }
  const width = ctx.measureText(content).width;
  if (options.clamp !== false) {
    x = clamp(x, 7, Math.max(7, S.W - width - 7));
    y = clamp(y, size + 8, Math.max(size + 8, S.H - 10));
  }
  ctx.fillStyle = options.background || palette.labelBg;
  ctx.fillRect(x - 6, y - size - 5, width + 12, size + 10);
  ctx.strokeStyle = options.border || palette.labelBorder; ctx.lineWidth = 1;
  ctx.strokeRect(x - 6, y - size - 5, width + 12, size + 10);
  ctx.fillStyle = color || palette.text; ctx.fillText(content, x, y - 1);
}

function hexA(hex, alpha) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!match) return `rgba(70,125,145,${alpha})`;
  const n = parseInt(match[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
}
