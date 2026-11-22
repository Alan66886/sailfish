const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scene() {
  const now = 1700000000000, listeners = {}, timers = new Map(), calls = [], nodes = {};
  let timerId = 0, clock = now, rectCalls = 0;
  const classes = { add() {}, remove() {} };
  const canvas = { width: 390, height: 500, classList: classes, setPointerCapture() {},
    getBoundingClientRect() { rectCalls++; return { left: 10, top: 20, width: S.W, height: S.H }; },
    addEventListener(name, fn) { listeners[name] = fn; } };
  const ctx = new Proxy({ font: '14px sans-serif',
    measureText(text) { return { width: String(text).length * Number(this.font.match(/(\d+)px/)[1]) * .58 }; } }, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => calls.push({ name, args, fill: target.fillStyle, stroke: target.strokeStyle, font: target.font });
    },
  });
  const S = { W: 390, H: 500, anchor: { lat: 0, lng: 0 }, dev: new Map(), hist: new Map(),
    view: { mode: 'fleet', follow: false, fitNow: false, k: 1, cx: 0, cy: 0 },
    theme: 'day', layers: { trails: true, labels: false, otherPredictions: false, grid: true },
    focusBoat: 'own', showPred: true, showLay: false, cur: { dir: null, spd: 0 }, wind: null };
  const boat = (key, x = 0, y = 0) => ({ key, name: key + '-name', kind: 'boat',
    lat: y / 100000, lng: x / 100000, ts: now, hdg: 0, spd: 2, color: '#1e6384' });
  S.dev.set('own', boat('own'));
  S.dev.set('other', boat('other', 65, 0));
  const el = id => nodes[id] || (nodes[id] = { textContent: '', innerHTML: '', value: '',
    dispatchEvent(e) { if (this.onchange && e.type === 'change') this.onchange({ target: this }); } });
  el('boatSel').onchange = e => { S.focusBoat = e.target.value; };
  const sandbox = { S, cv: canvas, ctx, el, nowMs: () => now, D2R: Math.PI / 180, KNOT: 1.94384,
    project: (lat, lng) => ({ x: lng * 100000, y: lat * 100000 }),
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    brg360: (x, y) => (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360,
    norm180: a => ((a + 540) % 360) - 180,
    window: { devicePixelRatio: 1, innerWidth: 390, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    Date: { now: () => clock }, Event: class { constructor(type) { this.type = type; } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() {}, updatePredictionInfo() {}, closeSheet() {} };
  const context = vm.createContext(sandbox);
  for (const file of ['calc.js', 'draw.js', 'interact.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js', file), 'utf8'), context);
  }
  const event = (type, x, y, id = 1, extras = {}) => listeners[type]({ type, clientX: x, clientY: y,
    pointerId: id, pointerType: 'touch', preventDefault() {}, ...extras });
  return { context, S, calls, nodes, now, boat, event, timers, canvas,
    advance(ms) { clock += ms; }, rectReads: () => rectCalls,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

function prediction(points = [{ x: 0, y: -60, t: 30, distance: 60 }, { x: 0, y: -120, t: 60, distance: 120 }]) {
  return { start: { x: 0, y: 0 }, pts: points, hasCur: false };
}

test('本船跟随排除远方船，reset回全场，两种视图立即适配', () => {
  const s = scene();
  s.S.dev.set('far', s.boat('far', 8000, -8000));
  assert.equal(s.context.focusMyBoat(), true);
  assert.equal(s.S.view.mode, 'boat');
  assert.equal(s.S.view.fitNow, true);
  s.context.fit(prediction());
  const nearScale = s.S.view.k;
  assert.equal(s.S.view.fitNow, false);
  assert.ok(nearScale > .5);
  s.context.resetView(); s.context.fit(prediction());
  assert.equal(s.S.view.mode, 'fleet');
  assert.ok(s.S.view.k < nearScale / 10);
  s.S.focusBoat = '';
  assert.equal(s.context.focusMyBoat(), false);
});

test('船视图包含附近起航端点，但本船预测路径仍保持在可用区中心', () => {
  const s = scene();
  const a = { ...s.boat('a', -100, 40), kind: 'mark', name: '起航线A' };
  const b = { ...s.boat('b', 100, 40), kind: 'mark', name: '起航线B' };
  s.S.dev.set('a', a); s.S.dev.set('b', b);
  s.context.focusMyBoat(); s.context.fit(prediction());
  const own = vm.runInContext('toScreen(project(S.dev.get("own").lat, S.dev.get("own").lng))', s.context);
  assert.ok(own.x > 100 && own.x < 170);
  const points = s.context.mapFitPoints(prediction());
  assert.equal(points.length, 5);
  const last = vm.runInContext('toScreen({x:0,y:-120})', s.context);
  assert.ok(last.y >= s.context.mapViewport().top);
});

test('小画布适配保持正缩放，隐藏地图不会反复重置fitNow', () => {
  const s = scene();
  for (const height of [70, 100, 180, 500]) {
    s.S.H = height; s.context.focusMyBoat(); s.context.fit(prediction());
    assert.ok(Number.isFinite(s.S.view.k) && s.S.view.k >= .02);
  }
  s.S.W = 0; s.S.H = 0; s.S.view.fitNow = false;
  const reads = s.rectReads();
  s.context.draw(); s.context.draw();
  assert.equal(s.rectReads(), reads);
  assert.equal(s.S.view.fitNow, false);
});

test('主题即时切换，普通标签随屏宽变化，30秒和1分钟始终16px', () => {
  const s = scene(), day = s.context.drawPalette();
  s.S.theme = 'night';
  assert.notEqual(s.context.drawPalette().sea, day.sea);
  assert.equal(s.context.mapLabelSize(), 14);
  s.S.W = 1200;
  assert.equal(s.context.mapLabelSize(), 13);
  assert.equal(s.context.mapLabelSize('milestone'), 16);
});

test('30秒和1分钟标签不重叠、不截断且避让真实风卡和按钮矩形', () => {
  const s = scene();
  s.nodes.windTxt = { parentElement: { getBoundingClientRect: () => ({ left: 24, top: 34, width: 132, height: 87 }) } };
  s.nodes.mapLayers = { getBoundingClientRect: () => ({ left: 338, top: 34, width: 48, height: 48 }) };
  s.nodes.mapLocate = { getBoundingClientRect: () => ({ left: 338, top: 92, width: 48, height: 48 }) };
  s.context.cacheMapOverlays();
  for (const [x, y, difference] of [[195, 250, 33], [60, 150, 5], [355, 170, 4]]) {
    const pr = prediction([{ x: x - 195, y: y - 250, t: 30, distance: 30 },
      { x: x - 195, y: y - difference - 250, t: 60, distance: 60 }]);
    const labels = s.context.mapMilestoneLabels(pr);
    assert.equal(labels.length, 2);
    assert.equal(s.context.mapLabelOverlap(labels[0].box, labels[1].box), false);
    for (const { box } of labels) {
      assert.ok(box.x >= 0 && box.x + box.width <= s.S.W);
      assert.ok(box.y >= 0 && box.y + box.height <= s.S.H);
      assert.equal(s.context.mapLabelOverlap(box, { x: 14, y: 14, width: 132, height: 87 }), false);
      assert.equal(s.context.mapLabelOverlap(box, { x: 328, y: 14, width: 48, height: 106 }), false);
    }
  }
});

test('默认只计算本船预测和显示本船提示，其他名称与预测由图层打开', () => {
  const s = scene(), original = s.context.predict, predicted = [];
  s.context.predict = (dv, seconds) => { predicted.push(dv.key); return original(dv, seconds); };
  s.context.draw();
  assert.deepEqual(predicted, ['own']);
  assert.equal(s.calls.some(c => c.name === 'fillText' && String(c.args[0]).includes('other-name')), false);
  s.S.layers.labels = true; s.S.layers.otherPredictions = true;
  predicted.length = 0; s.calls.length = 0;
  s.context.draw();
  assert.deepEqual(predicted, ['own', 'other']);
  assert.equal(s.calls.some(c => c.name === 'fillText' && c.args[0] === 'other-name'), true);
});

test('过期、未来和无时间数据灰化并停止预测', () => {
  const s = scene(), own = s.S.dev.get('own');
  assert.equal(s.context.mapDeviceStale(own, s.now), false);
  for (const ts of [null, s.now + 1, s.now - 30001]) {
    own.ts = ts;
    assert.equal(s.context.mapDeviceStale(own, s.now), true);
    s.calls.length = 0; s.context.draw();
    assert.equal(s.calls.some(c => c.name === 'fillText' && /^30秒/.test(c.args[0])), false);
    assert.equal(s.calls.some(c => c.name === 'fill' && c.fill === s.context.drawPalette().stale), true);
  }
});

test('18px点击命中，7px轻微移动可选船，拖出8px再返回不算点击', () => {
  const s = scene(); s.S.focusBoat = '';
  assert.equal(s.context.hitTestBoat(205 + 18, 270).key, 'own');
  assert.equal(s.context.hitTestBoat(205 + 19, 270), null);
  s.event('pointerdown', 205, 270); s.event('pointermove', 212, 270); s.event('pointerup', 212, 270);
  s.flush();
  assert.equal(s.S.focusBoat, 'own'); assert.equal(s.S.view.mode, 'boat');
  s.S.focusBoat = '';
  s.event('pointerdown', 205, 270); s.event('pointermove', 220, 270);
  s.event('pointermove', 205, 270); s.event('pointerup', 205, 270); s.flush();
  assert.equal(s.S.focusBoat, ''); assert.equal(s.S.view.follow, false);
});

test('双击只回全场，不执行延迟选船；取消和双指手势也不误选', () => {
  const s = scene(); s.S.focusBoat = ''; s.S.view.mode = 'boat';
  s.event('pointerdown', 205, 270); s.event('pointerup', 205, 270); s.advance(100);
  s.event('pointerdown', 205, 270); s.event('pointerup', 205, 270); s.flush();
  assert.equal(s.S.focusBoat, ''); assert.equal(s.S.view.mode, 'fleet');
  s.event('pointerdown', 205, 270); s.event('pointercancel', 205, 270); s.flush();
  assert.equal(s.S.focusBoat, '');
  s.event('pointerdown', 205, 270, 1); s.event('pointerdown', 250, 270, 2);
  s.event('pointerup', 205, 270, 1); s.event('pointerup', 250, 270, 2); s.flush();
  assert.equal(s.S.focusBoat, '');
});

test('双指缩放和滚轮缩放保留手势中心的世界坐标', () => {
  const s = scene();
  s.event('pointerdown', 100, 200, 1); s.event('pointerdown', 200, 200, 2);
  s.event('pointermove', 300, 300, 2);
  const worldX = s.S.view.cx + (200 - 10 - 195) / s.S.view.k;
  const worldY = s.S.view.cy + (250 - 20 - 250) / s.S.view.k;
  assert.ok(Math.abs(worldX - (-55)) < 1e-9);
  assert.ok(Math.abs(worldY - (-70)) < 1e-9);
  s.event('pointerup', 100, 200, 1); s.event('pointerup', 300, 300, 2);
  const before = s.S.view.cx + (330 - 10 - 195) / s.S.view.k;
  s.event('wheel', 330, 200, 1, { deltaY: -10 });
  const after = s.S.view.cx + (330 - 10 - 195) / s.S.view.k;
  assert.ok(Math.abs(before - after) < 1e-9);
});
