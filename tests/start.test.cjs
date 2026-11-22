const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scene({ x = 0, y = 50, vx = 0, vy = -2, age = 3000 } = {}) {
  const timestamp = 1700000000000;
  const boat = { key: 'boat', lat: y / 100000, lng: x / 100000, ts: timestamp, hdg: 90, spd: 4 };
  const ends = [-50, 50].map(x => ({ lat: 0, lng: x / 100000, ts: timestamp }));
  const target = { lat: -0.001, lng: 0, ts: timestamp };
  const nodes = {};
  const el = id => nodes[id] || (nodes[id] = { textContent: '', dataset: {} });
  const S = { anchor: {}, race: {}, startAt: null, startDirection: 'toward', hist: new Map() };
  S.hist.set('boat', Array.from({ length: 7 }, (_, i) => ({
    t: timestamp + (i - 6) * 1000, x: x + vx * (i - 6), y: y + vy * (i - 6), timed: true,
  })));
  const context = vm.createContext({
    S, el, setText: (id, text) => { el(id).textContent = text; },
    project: (lat, lng) => ({ x: lng * 100000, y: lat * 100000 }),
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)), KNOT: 1.94384,
    startEnds: () => ends, mark1: () => target,
  });
  for (const file of ['tactics.js', 'start.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js', file), 'utf8'), context);
  }
  return { context, S, boat, ends, target, nodes, timestamp, now: timestamp + age };
}

test('到线使用对地轨迹并扣除数据年龄，不使用上报船头方向或总船速', () => {
  const s = scene();
  const result = s.context.startApproach(s.boat, s.now);
  assert.equal(result.eta, 22);
  assert.equal(result.point.x, 0);
  assert.equal(result.point.y, 0);
});

test('延长线相交、平行和线端附近不输出到线秒数', () => {
  for (const options of [{ x: 80 }, { vx: 2, vy: 0 }, { x: 49 }]) {
    const s = scene(options);
    assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
  }
  const far = scene({ x: 1000, y: 4, age: 0 });
  assert.match(far.context.startApproach(far.boat, far.now).note, /不会穿过/);
});

test('未确认方向和赛道侧返航不能作为起航接近', () => {
  const s = scene();
  s.S.startDirection = '';
  assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
  const returning = scene({ y: -50, vy: 2 });
  assert.match(returning.context.startApproach(returning.boat, returning.now).note, /赛道侧/);
  returning.S.startDirection = 'away';
  assert.equal(returning.context.startApproach(returning.boat, returning.now).eta, 22);
});

test('近线和预测交会时刻已过时不显示负数或精确倒秒', () => {
  const near = scene({ y: 4, age: 0 });
  assert.equal(near.context.startApproach(near.boat, near.now).eta, null);
  const passed = scene({ y: 6, vy: -3, age: 3000 });
  assert.match(passed.context.startApproach(passed.boat, passed.now).note, /交会时刻已过/);
});

test('120秒范围以当前时刻为准', () => {
  const boundary = scene({ y: 250, age: 5000 });
  assert.equal(boundary.context.startApproach(boundary.boat, boundary.now).eta, 120);
  const beyond = scene({ y: 252, age: 5000 });
  assert.equal(beyond.context.startApproach(beyond.boat, beyond.now).eta, null);
});

test('船位、任一端点或方向参考标过期都会暂停', () => {
  for (const field of ['boat', 'endpoint', 'target']) {
    const s = scene({ age: 0 });
    const item = field === 'endpoint' ? s.ends[0] : s[field];
    item.ts -= 10001;
    assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
  }
});

test('无设备时间的历史和定位跳变不参与到线推算', () => {
  const s = scene();
  const h = s.S.hist.get('boat');
  s.S.hist.set('boat', h.map(p => ({ ...p, timed: false })));
  assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
  s.S.hist.set('boat', h.map((p, i) => ({ ...p, x: i < 3 ? p.x + 160 : p.x })));
  assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
});

test('4点轨迹中的孤立跳点不能抬高速度过滤基线', () => {
  const s = scene({ age: 0 });
  s.S.hist.set('boat', [62, 218, 54, 50].map((y, i) => ({
    t: s.timestamp + (i - 3) * 2000, x: 0, y, timed: true,
  })));
  assert.equal(s.context.startApproach(s.boat, s.now).eta, null);
  s.S.hist.set('boat', [62, 58, 54, -110].map((y, i) => ({
    t: s.timestamp + (i - 3) * 2000, x: 0, y, timed: true,
  })));
  assert.equal(s.context.recentGroundVelocity(s.boat), null);
  const steady = scene({ y: 300, vy: -12, age: 0 });
  assert.equal(steady.context.startApproach(steady.boat, steady.now).eta, 25);
});

test('倒计时从固定时刻计算，跳过刷新也不丢秒', () => {
  const s = scene();
  s.context.calibrateStartClock(60, s.timestamp);
  s.context.updateStartAssist(s.boat, s.timestamp + 17000);
  assert.equal(s.nodes.startCountdown.textContent, '00:43');
  s.context.shiftStartClock(-1);
  assert.equal(s.S.startAt, s.timestamp + 59000);
  s.context.shiftStartClock(1);
  assert.equal(s.S.startAt, s.timestamp + 60000);
  s.context.updateStartAssist(s.boat, s.timestamp + 65000);
  assert.equal(s.nodes.startCountdown.textContent, '00:05');
  assert.equal(s.nodes.startCountdownLabel.textContent, '手动起航后');
});

test('5/4/1分钟校准、清除和早晚方向一致', () => {
  const s = scene();
  for (const seconds of [300, 240, 60]) {
    s.context.calibrateStartClock(seconds, s.timestamp);
    assert.equal(s.S.startAt, s.timestamp + seconds * 1000);
  }
  assert.equal(s.context.startTimeDifference(22, 30).text, '早 8秒');
  assert.equal(s.context.startTimeDifference(30, 22).text, '晚 8秒');
  s.nodes.startClear.onclick();
  s.context.updateStartAssist(s.boat, s.now);
  assert.equal(s.nodes.startCountdown.textContent, '—:—');
  assert.equal(s.nodes.startDelta.textContent, '—');
  assert.equal(s.nodes.startEarlier.disabled, true);
});
