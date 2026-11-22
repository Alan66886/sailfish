const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function recordingScene() {
  let now = 1700000000000;
  const saved = new Map(), nodes = {};
  const node = () => ({ textContent: '', value: '', checked: false, disabled: false, children: [],
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const el = id => nodes[id] || (nodes[id] = node());
  const S = { gen: 1, anchor: {}, race: { raceCd: 'test-race', levelName: '测试组', roundName: 'R1' },
    focusBoat: 'own', dev: new Map(), wind: null };
  const ends = [-0.0005, 0.0005].map(lng => ({ lat: 0, lng, ts: now }));
  const mark = { lat: 0.02, lng: 0, ts: now };
  function sample(seconds) {
    now = 1700000000000 + seconds * 1000;
    for (const item of [...ends, mark]) item.ts = now;
    for (let i = 0; i < 6; i++) {
      const left = i < 3, key = i === 0 ? 'own' : 'boat-' + i;
      S.dev.set(key, { key, kind: 'boat', name: '测试船' + i, ts: now,
        lat: (150 + seconds * (left ? 2 : 1.7)) / 100000,
        lng: (left ? -60 - i * 10 : 60 + i * 10) / 100000 });
    }
    S.wind = { ts: now, from: seconds < 45 ? 359 : 1, spd: 5 };
  }
  sample(0);
  el('coachScope').value = 'first_upwind_leg';
  const context = vm.createContext({
    S, el, nowMs: () => now, startEnds: () => ends, mark1: () => mark,
    project: (lat, lng) => ({ x: lng * 100000, y: -lat * 100000 }),
    brg360: () => 0, setText: (id, text) => { el(id).textContent = text; },
    freshPosition: (d, t) => !!d && Number.isFinite(d.ts) && d.ts <= t && t - d.ts <= 10000,
    document: { createElement: node }, localStorage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) },
    DIRECT: true, API_BASE: '', setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {},
  });
  for (const file of ['coach-analysis.js', 'coach.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js', file), 'utf8'), context);
  }
  return { context, S, nodes, saved, sample, state: () => vm.runInContext('coachState', context) };
}

test('录制必须选本船并显式确认迎风轴，单文件不假装接通AI', () => {
  const s = recordingScene();
  s.context.startCoachRecording();
  assert.equal(s.state().session, null);
  assert.match(s.nodes.coachStatus.textContent, /确认迎风/);
  assert.match(s.nodes.coachService.textContent, /单文件/);
  assert.equal(s.nodes.coachAsk.disabled, true);
  s.nodes.coachConfirm.checked = true;
  s.S.focusBoat = '';
  s.context.startCoachRecording();
  assert.equal(s.state().session, null);
  assert.match(s.nodes.coachStatus.textContent, /选择本船/);
});

test('真实5秒录制流生成可配对摘要，原始坐标与船名不落盘', () => {
  const s = recordingScene();
  s.nodes.coachConfirm.checked = true;
  s.nodes.coachScope.value = 'first_lap';
  s.context.startCoachRecording();
  for (let seconds = 5; seconds <= 95; seconds += 5) {
    s.sample(seconds); s.context.captureCoachSample(1700000000000 + seconds * 1000);
  }
  s.context.finishCoachRecording();
  const report = s.state().reports[0];
  assert.equal(report.summary.scope, 'first_lap');
  assert.equal(report.summary.paired_windows, 3);
  assert.equal(report.summary.comparison.favored, 'left');
  const serialized = [...s.saved.values()][0];
  for (const text of ['"lat"', '"lng"', '"tracks"', '测试船']) assert.ok(!serialized.includes(text));
  assert.equal(s.nodes.coachStop.disabled, true);
});

test('重复设备时间不重记，数据过期剔除，换船不改变已记录的本船', () => {
  const s = recordingScene();
  s.nodes.coachConfirm.checked = true;
  s.context.startCoachRecording();
  s.context.captureCoachSample(1700000000000);
  assert.equal(s.state().session.tracks.get('own').length, 1);
  s.sample(5);
  s.S.dev.get('boat-1').ts = 1699999980000;
  s.context.captureCoachSample(1700000005000);
  assert.equal(s.state().session.tracks.get('boat-1').length, 1);
  assert.equal(s.state().session.rejectedSamples, 1);
  s.S.focusBoat = 'boat-5';
  assert.equal(s.state().session.ownKey, 'own');
});

test('切场结束录制并保留历史摘要，清空方向确认', () => {
  const s = recordingScene();
  s.nodes.coachConfirm.checked = true;
  s.context.startCoachRecording();
  s.sample(20); s.context.captureCoachSample(1700000020000);
  s.context.resetCoachForRace();
  assert.equal(s.state().session, null);
  assert.equal(s.state().reports.length, 1);
  assert.equal(s.state().reports[0].raceCd, 'test-race');
  assert.equal(s.nodes.coachConfirm.checked, false);
  assert.equal(s.state().reports[0].summary.comparison.favored, 'insufficient');
});

test('未结束样本刷新不保存，达到90分钟自动封存', () => {
  const s = recordingScene();
  s.nodes.coachConfirm.checked = true;
  s.nodes.coachScope.value = 'first_race';
  s.context.startCoachRecording();
  assert.equal(s.saved.size, 0);
  s.sample(5500); s.context.updateCoachUI();
  assert.equal(s.state().session, null);
  assert.equal(s.state().reports[0].summary.duration_s, 5400);
  assert.equal(s.state().reports[0].summary.scope, 'first_race');
});

test('AI返回后存储失败仍提示导出，不能误报已持久保存', async () => {
  const s = recordingScene();
  s.nodes.coachConfirm.checked = true;
  s.context.startCoachRecording();
  for (let seconds = 5; seconds <= 95; seconds += 5) {
    s.sample(seconds); s.context.captureCoachSample(1700000000000 + seconds * 1000);
  }
  s.context.finishCoachRecording();
  s.state().service = { configured: true, token: 'mock-nonce' };
  s.context.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  s.context.fetch = async () => ({ ok: true, json: async () => ({ model: 'mock', analysis: {
    summary: '模拟统计解读', evidence: ['模拟依据'], next_leg_plan: ['继续观察'], recheck_conditions: ['风况变化后复核'],
  } }) });
  s.context.localStorage.setItem = () => { throw new Error('quota'); };
  await s.context.askCoachAI();
  assert.match(s.state().message, /无法保存/);
  assert.match(s.nodes.coachRequestStatus.textContent, /导出/);
  assert.equal(s.state().reports[0].analysis.summary, '模拟统计解读');
});
