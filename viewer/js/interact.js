'use strict';
// pointer/wheel 手势:拖动、双指缩放、双击复位
/* ---------- 交互:鼠标和手指都走 pointer 事件 ---------- */
const pts = new Map();
let drag = null;
let pinch = null;
let lastTap = null;

function viewOff() {                 // 手动动了就不再自动框住
  if (!S.view.follow) return;
  S.view.follow = false;
  el('follow').textContent = '自动框住:关';
}
function resetView() {               // 双击 / 双击屏幕:回到自动框住
  S.view.follow = true;
  el('follow').textContent = '自动框住:开';
}

cv.addEventListener('pointerdown', e => {
  el('ctrls').classList.remove('open');
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 1) {
    drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy };
    cv.classList.add('drag');
  } else if (pts.size === 2) {
    drag = null;
    cv.classList.remove('drag');
    const [a, b] = [...pts.values()];
    pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: S.view.k,
      cx: S.view.cx, cy: S.view.cy, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
});

cv.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pts.size >= 2 && pinch) {                      // 两指:捏合缩放 + 跟着中点平移
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < 6) return;
    viewOff();
    S.view.k = clamp(pinch.k * (d / pinch.d), 0.02, 20);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.view.cx = pinch.cx - (mx - pinch.mx) / S.view.k;
    S.view.cy = pinch.cy - (my - pinch.my) / S.view.k;
    return;
  }
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 2) return;
  viewOff();
  S.view.cx = drag.cx - (e.clientX - drag.x) / S.view.k;
  S.view.cy = drag.cy - (e.clientY - drag.y) / S.view.k;
});

function endPt(e) {
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (pts.size === 0) { drag = null; cv.classList.remove('drag'); }

  if (e.pointerType !== 'mouse' && e.type === 'pointerup') {   // 双击屏 = 复位
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320
        && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
      lastTap = null; resetView();
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
}
cv.addEventListener('pointerup', endPt);
cv.addEventListener('pointercancel', endPt);
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') endPt(e); });

cv.addEventListener('wheel', e => {
  e.preventDefault();
  viewOff();
  S.view.k = clamp(S.view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.02, 20);
}, { passive: false });

cv.addEventListener('dblclick', resetView);

// 手势提示按设备换说法;手机上船表和参数都收起来,点按钮再拉开
if (COARSE || window.innerWidth < 620) {
  el('hint').textContent = '双指缩放 · 单指拖动 · 双击复位';
}
