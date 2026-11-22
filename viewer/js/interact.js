'use strict';
// 单指拖动、双指缩放、轻点选船、双击回全场。
const pts = new Map();
let drag = null, pinch = null, mapTap = null, lastTap = null, pendingMapTap = null;

function mapFollowText() {
  const node = el('follow');
  if (node) node.textContent = '自动框住:' + (S.view.follow ? '开' : '关');
}
function viewOff() {
  S.view.follow = false; S.view.fitNow = false;
  mapFollowText();
}
function resetView() {
  S.view.mode = 'fleet'; S.view.follow = true; S.view.fitNow = true;
  mapFollowText();
}
function focusMyBoat() {
  const boat = S.dev.get(S.focusBoat);
  if (!boat || boat.kind !== 'boat' || !mapPositionValid(boat)) return false;
  S.view.mode = 'boat'; S.view.follow = true; S.view.fitNow = true;
  mapFollowText();
  return true;
}
function cancelMapTap() {
  if (pendingMapTap !== null) clearTimeout(pendingMapTap);
  pendingMapTap = null; lastTap = null;
}
function hitTestBoat(clientX, clientY, radius = 18) {
  if (!S.anchor || !S.W || !S.H) return null;
  const rect = cv.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  let nearest = null, distance = radius;
  for (const boat of S.dev.values()) {
    if (boat.kind !== 'boat' || !mapPositionValid(boat)) continue;
    const p = toScreen(project(boat.lat, boat.lng));
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= distance) { distance = d; nearest = boat; }
  }
  return nearest;
}
function selectMapBoat(key) {
  const boat = S.dev.get(key);
  if (!boat || boat.kind !== 'boat') return;
  const picker = el('boatSel');
  if (picker && typeof picker.onchange === 'function') {
    picker.value = key;
    if (typeof picker.dispatchEvent === 'function' && typeof Event !== 'undefined') {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    } else picker.onchange({ target: picker });
  } else {
    S.focusBoat = key;
    if (picker) picker.value = key;
  }
  if (S.focusBoat === key) focusMyBoat();
}

cv.addEventListener('pointerdown', e => {
  if (typeof closeSheet === 'function') closeSheet();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 1) {
    drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy, moved: false };
    mapTap = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, type: e.pointerType };
    cv.classList.add('drag');
  } else {
    mapTap = null; drag = null; cancelMapTap(); cv.classList.remove('drag');
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const rect = cv.getBoundingClientRect(), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: S.view.k,
        worldX: S.view.cx + (mx - rect.left - S.W / 2) / S.view.k,
        worldY: S.view.cy + (my - rect.top - S.H / 2) / S.view.k };
    }
  }
});

cv.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (mapTap && Math.hypot(e.clientX - mapTap.x, e.clientY - mapTap.y) >= 8) mapTap.moved = true;
  if (pts.size >= 2 && pinch) {
    const [a, b] = [...pts.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (distance < 6) return;
    viewOff();
    const rect = cv.getBoundingClientRect(), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.view.k = clamp(pinch.k * distance / pinch.distance, .02, 20);
    S.view.cx = pinch.worldX - (mx - rect.left - S.W / 2) / S.view.k;
    S.view.cy = pinch.worldY - (my - rect.top - S.H / 2) / S.view.k;
    return;
  }
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
  drag.moved = true; cancelMapTap(); viewOff();
  S.view.cx = drag.cx - (e.clientX - drag.x) / S.view.k;
  S.view.cy = drag.cy - (e.clientY - drag.y) / S.view.k;
});

function endPt(e) {
  const tap = mapTap;
  const validTap = e.type === 'pointerup' && pts.size === 1 && tap && tap.id === e.pointerId
    && !tap.moved && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8;
  pts.delete(e.pointerId);
  mapTap = null;
  if (pts.size < 2) pinch = null;
  if (!pts.size) { drag = null; cv.classList.remove('drag'); }
  else if (pts.size === 1) {
    const remaining = [...pts.values()][0];
    drag = { x: remaining.x, y: remaining.y, cx: S.view.cx, cy: S.view.cy, moved: true };
  }
  if (!validTap) { cancelMapTap(); return; }
  const now = Date.now();
  if (lastTap && now - lastTap.t < 320 && lastTap.type === e.pointerType
      && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
    cancelMapTap(); resetView(); return;
  }
  cancelMapTap();
  const boat = hitTestBoat(e.clientX, e.clientY);
  lastTap = { t: now, x: e.clientX, y: e.clientY, type: e.pointerType };
  pendingMapTap = setTimeout(() => {
    pendingMapTap = null; lastTap = null;
    if (boat) selectMapBoat(boat.key);
  }, 320);
}
cv.addEventListener('pointerup', endPt);
cv.addEventListener('pointercancel', endPt);
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && pts.has(e.pointerId)) endPt(e); });

cv.addEventListener('wheel', e => {
  e.preventDefault(); cancelMapTap(); viewOff();
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left - S.W / 2, y = e.clientY - rect.top - S.H / 2;
  const worldX = S.view.cx + x / S.view.k, worldY = S.view.cy + y / S.view.k;
  S.view.k = clamp(S.view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15), .02, 20);
  S.view.cx = worldX - x / S.view.k; S.view.cy = worldY - y / S.view.k;
}, { passive: false });
cv.addEventListener('dblclick', e => {
  e.preventDefault(); cancelMapTap(); resetView();
});

function updateMapHint() {
  const hint = el('hint');
  if (!hint) return;
  const touch = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) || window.innerWidth <= 760;
  hint.textContent = touch ? '轻点选船 · 双指缩放 · 拖动 · 双击看全场'
    : '点选船只 · 滚轮缩放 · 拖动 · 双击看全场';
}
window.addEventListener('resize', updateMapHint);
updateMapHint();
