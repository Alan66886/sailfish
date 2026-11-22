const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js/coach-analysis.js'), 'utf8'), context);
const analyze = session => JSON.parse(JSON.stringify(context.analyzeCoachSession(session)));
const START = 1700000000000;
const KNOT = 1.94384;

function session(duration = 180) {
  return { scope: 'first_upwind_leg', startedAt: START, endedAt: START + duration * 1000,
    courseLength: 2000, ownKey: 'left-0', tracks: new Map(), wind: [], rejectedSamples: 0, geometryChanged: false };
}

function addWindow(s, key, window, { x = -60, y = 300, speed = 1, times = [0, 5, 10, 15, 20, 25] } = {}) {
  const points = s.tracks.get(key) || [];
  points.push(...times.map(t => ({ t: START + (window * 30 + t) * 1000, x, y: y + speed * t })));
  s.tracks.set(key, points);
}

function fleet({ windows = 6, boats = 3, leftSpeed = 2, rightSpeed = 1 } = {}) {
  const s = session(windows * 30);
  for (let w = 0; w < windows; w++) {
    for (let b = 0; b < boats; b++) {
      addWindow(s, `left-${b}`, w, { speed: leftSpeed });
      addWindow(s, `right-${b}`, w, { x: 60, speed: rightSpeed });
    }
  }
  return s;
}

function assertFiniteTree(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) value.forEach(assertFiniteTree);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteTree);
}

test('同步同进度的双侧数据形成独立配对窗，最多给中等置信度', () => {
  const out = analyze(fleet());
  assert.equal(out.paired_windows, 6);
  assert.equal(out.paired_groups, 6);
  assert.equal(out.left.boat_count, 3);
  assert.equal(out.left.window_count, 18);
  assert.equal(out.left.median_progress_kn, 3.89);
  assert.equal(out.right.median_progress_kn, 1.94);
  assert.equal(out.comparison.favored, 'left');
  assert.equal(out.comparison.median_delta_kn, 1.94);
  assert.equal(out.comparison.left_win_share, 1);
  assert.equal(out.comparison.confidence, 'moderate');
  assert.equal(out.own.window_count, 6);
  assert.equal(out.own.left_share, 1);
  assertFiniteTree(out);
});

test('只有三窗或每侧两船时保守给low，小于0.3节为even', () => {
  assert.equal(analyze(fleet({ windows: 3, boats: 2 })).comparison.confidence, 'low');
  const even = analyze(fleet({ leftSpeed: 1.1, rightSpeed: 1 }));
  assert.equal(even.comparison.favored, 'even');
  assert.equal(even.comparison.confidence, 'low');
  const right = analyze(fleet({ leftSpeed: 1, rightSpeed: 2 }));
  assert.equal(right.comparison.favored, 'right');
  assert.equal(right.comparison.left_win_share, 0);
  assert.equal(right.comparison.confidence, 'moderate');
});

test('至少三船每侧还需独立窗口胜率达到三分之二', () => {
  for (const [windows, wins, confidence] of [[6, 4, 'moderate'], [7, 4, 'low']]) {
    const s = session(windows * 30);
    for (let w = 0; w < windows; w++) {
      for (let b = 0; b < 3; b++) {
        addWindow(s, `left-${b}`, w, { speed: w < wins ? 2 : 1 });
        addWindow(s, `right-${b}`, w, { x: 60, speed: w < wins ? 1 : 2 });
      }
    }
    const out = analyze(s);
    assert.equal(out.comparison.favored, 'left');
    assert.equal(out.comparison.confidence, confidence);
    assert.equal(out.comparison.left_win_share, Math.round(wins / windows * 100) / 100);
  }
});

test('不足三窗、每侧不足两船以及稀疏采样不能形成判断', () => {
  for (const s of [fleet({ windows: 2 }), fleet({ boats: 1 })]) {
    const out = analyze(s);
    assert.equal(out.comparison.favored, 'insufficient');
    assert.equal(out.comparison.median_delta_kn, null);
  }
  const sparse = fleet();
  for (const [key, points] of sparse.tracks) sparse.tracks.set(key, points.filter((_, i) => i % 6 < 3));
  assert.equal(analyze(sparse).paired_windows, 0);
});

test('不同时间窗和不同进度档不能配对', () => {
  const times = session(180), progress = session(90);
  for (let w = 0; w < 3; w++) {
    for (let b = 0; b < 2; b++) {
      addWindow(times, `left-${b}`, w);
      addWindow(times, `right-${b}`, w + 3, { x: 60 });
      addWindow(progress, `left-${b}`, w, { y: 300 });
      addWindow(progress, `right-${b}`, w, { x: 60, y: 900 });
    }
  }
  assert.equal(analyze(times).paired_windows, 0);
  assert.equal(analyze(progress).paired_windows, 0);
});

test('同一时间窗多个进度档仍然只算一个独立窗', () => {
  const s = session(30);
  for (let bin = 0; bin < 3; bin++) {
    for (let b = 0; b < 2; b++) {
      addWindow(s, `l-${bin}-${b}`, 0, { y: 200 + bin * 400, speed: 2 });
      addWindow(s, `r-${bin}-${b}`, 0, { x: 60, y: 200 + bin * 400 });
    }
  }
  const out = analyze(s);
  assert.equal(out.paired_groups, 3);
  assert.equal(out.paired_windows, 1);
  assert.equal(out.comparison.favored, 'insufficient');
});

test('每窗先汇总各进度档，档位多的时间段不能获得额外票数', () => {
  const s = session(90);
  for (let w = 0; w < 3; w++) {
    const bins = w === 0 ? 3 : 1;
    for (let bin = 0; bin < bins; bin++) {
      for (let b = 0; b < 2; b++) {
        addWindow(s, `l-${bin}-${b}`, w, { y: 200 + bin * 400, speed: w === 0 ? 2 : 1 });
        addWindow(s, `r-${bin}-${b}`, w, { x: 60, y: 200 + bin * 400, speed: w === 0 ? 1 : 2 });
      }
    }
  }
  const out = analyze(s);
  assert.equal(out.paired_groups, 5);
  assert.equal(out.paired_windows, 3);
  assert.equal(out.comparison.favored, 'right');
  assert.equal(out.comparison.median_delta_kn, -1.94);
});

test('任何超过12秒的窗口内缺口和孤立GPS跳点都拒绝该窗', () => {
  const gap = fleet({ windows: 3, boats: 2 });
  for (const [key] of gap.tracks) {
    gap.tracks.set(key, []);
    for (let w = 0; w < 3; w++) addWindow(gap, key, w, { x: key.startsWith('left') ? -60 : 60,
      times: [0, 5, 20, 25] });
  }
  assert.equal(analyze(gap).paired_windows, 0);
  assert.equal(analyze(gap).quality.gap_count, 3);
  const jumped = fleet({ windows: 3, boats: 2 });
  for (const points of jumped.tracks.values()) {
    for (let i = 1; i < points.length; i += 6) points[i].y += 500;
  }
  assert.equal(analyze(jumped).paired_windows, 0);
});

test('四点孤立异常不能抬高中位数基线，稳定高速仍可使用', () => {
  const s = session(30);
  s.ownKey = 'own';
  s.tracks.set('own', [300, 810, 320, 325].map((y, i) => ({
    t: START + [0, 10, 20, 25][i] * 1000, x: 0, y,
  })));
  assert.equal(analyze(s).own.window_count, 0);
  s.tracks.set('own', []);
  addWindow(s, 'own', 0, { x: 0, y: 300, speed: 12 });
  assert.equal(analyze(s).own.median_progress_kn, Math.round(12 * KNOT * 100) / 100);
});

test('反向、起航前和过标片段不比较，中心本船仍计入own', () => {
  for (const speed of [-1, 0]) assert.equal(analyze(fleet({ leftSpeed: speed })).paired_windows, 0);
  const s = fleet();
  s.ownKey = 'center';
  for (let w = 0; w < 6; w++) addWindow(s, 'center', w, { x: 0, speed: 1.5 });
  const out = analyze(s);
  assert.equal(out.own.window_count, 6);
  assert.equal(out.own.left_share, 0);
  assert.equal(out.own.median_progress_kn, 2.92);
  const outside = session(90);
  for (let w = 0; w < 3; w++) {
    addWindow(outside, 'left-0', w, { y: 20 });
    addWindow(outside, 'past', w, { y: 1950 });
  }
  assert.equal(analyze(outside).own.window_count, 0);
});

test('左右阈值严格，跨越中心的船窗不参与左右比较', () => {
  const s = fleet({ boats: 2 });
  for (const p of s.tracks.get('left-0')) p.x = -25;
  assert.equal(analyze(s).paired_windows, 0);
  for (const p of s.tracks.get('left-0')) p.x = -60;
  s.tracks.get('left-0').forEach((p, i) => { if (i % 6 === 2) p.x = 0; });
  assert.equal(analyze(s).paired_windows, 0);
});

test('风向用圆均值，359到1为正2度，稀疏和抵消方向不推断', () => {
  const s = session(120);
  s.wind = [0, 5, 10, 100, 105, 110].map((seconds, i) => ({
    t: START + seconds * 1000, from: i < 3 ? 359 : 1, spd: 5,
  }));
  let wind = analyze(s).wind;
  assert.equal(wind.shift_deg, 2);
  assert.equal(wind.first_from_deg, 359);
  assert.equal(wind.last_from_deg, 1);
  assert.equal(wind.median_speed_kn, 9.72);
  s.wind = s.wind.slice(0, 3);
  assert.equal(analyze(s).wind.shift_deg, null);
  s.wind = [{ t: START, from: 0, spd: 5 }, { t: START + 5000, from: 180, spd: 5 },
    { t: START + 100000, from: 90, spd: 5 }];
  wind = analyze(s).wind;
  assert.equal(wind.first_from_deg, null);
  assert.equal(wind.shift_deg, null);
});

test('几何变化强制不足，不以相关样本或风向推断原因', () => {
  const s = fleet();
  s.geometryChanged = true;
  const out = analyze(s);
  assert.equal(out.paired_windows, 6);
  assert.equal(out.quality.geometry_changed, true);
  assert.equal(out.comparison.favored, 'insufficient');
  assert.equal(out.comparison.median_delta_kn, null);
});

test('覆盖率只按本船相邻有效采样计算，其他船缺口不混入', () => {
  const s = session(60);
  s.ownKey = 'own';
  s.tracks.set('own', [0, 5, 10, 30, 35, 40].map(t => ({ t: START + t * 1000, x: 0, y: 300 + t })));
  s.tracks.set('other', [{ t: START, x: 50, y: 300 }, { t: START + 60000, x: 50, y: 350 }]);
  const out = analyze(s);
  assert.equal(out.quality.coverage_ratio, 0.33);
  assert.equal(out.quality.gap_count, 1);
});

test('输入清洗、摘要隐私和scope保留，函数不修改输入', () => {
  const s = fleet({ windows: 3 });
  s.scope = 'first_lap';
  s.rejectedSamples = 2;
  s.tracks.get('left-0').push({ t: START - 1, x: 0, y: 300 },
    { t: START + 1, x: NaN, y: 300 }, { ...s.tracks.get('left-0')[0] });
  const before = s.tracks.get('left-0').map(p => ({ ...p }));
  const out = analyze(s);
  assert.deepEqual(s.tracks.get('left-0'), before);
  assert.equal(out.scope, 'first_lap');
  assert.equal(out.quality.rejected_samples, 5);
  assertFiniteTree(out);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('left-0'));
  assert.ok(!serialized.includes(String(START)));
  assert.ok(!serialized.includes('startedAt'));
  assert.deepEqual(Object.keys(out), ['version', 'scope', 'duration_s', 'course_length_m', 'boat_count',
    'sample_count', 'paired_windows', 'paired_groups', 'left', 'right', 'comparison', 'wind', 'own', 'quality']);
  assertFiniteTree(analyze({ startedAt: Infinity, endedAt: NaN, courseLength: Infinity }));
});

test('90分钟、80船、十万样本的输入上限仍优先保留本船', () => {
  const s = session(6000);
  s.scope = 'first_race';
  s.ownKey = 'last-own';
  for (let i = 0; i < 81; i++) addWindow(s, `b-${i}`, 0, { x: 0 });
  addWindow(s, 'last-own', 0, { x: 0 });
  s.tracks.get('last-own').push({ t: START + 5500000, x: 0, y: 500 });
  const out = analyze(s);
  assert.equal(out.scope, 'first_race');
  assert.equal(out.duration_s, 5400);
  assert.equal(out.boat_count, 80);
  assert.equal(out.own.window_count, 1);
  assert.ok(out.sample_count <= 100000);
  assert.ok(out.paired_windows <= 181);
  assert.ok(out.paired_groups <= 1000);
  const large = session(6000);
  large.tracks.set('left-0', Array.from({ length: 100010 }, (_, i) => ({
    t: START + i, x: 0, y: 300,
  })));
  assert.equal(analyze(large).sample_count, 100000);
  assert.equal(analyze(large).quality.rejected_samples, 10);
});
