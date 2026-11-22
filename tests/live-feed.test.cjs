const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 固定响应仅用于隔离回归测试；生产页面不加载此文件，也不向官网发测试请求。
function liveScene({ deviceAge = 5000, requestDuration = 80 } = {}) {
  const clock = { now: 1700000000000 };
  const deviceTime = clock.now - deviceAge;
  const runtime = (speed, heading) => {
    const row = Array(24).fill(null);
    row[3] = 'test-device'; row[10] = speed; row[16] = heading;
    row[17] = 22; row[18] = 113; row[19] = 9876;
    row[22] = deviceTime; row[23] = deviceTime + 1000;
    return row;
  };
  const snapshot = {
    status: '10', centerLat: 22, centerLng: 113,
    teamList: [{ teamCd: 'test-boat', teamName: '回归样本', runtime: runtime(2.5, 270) }],
    navigationMark: [], windInstrumentList: [{ runtime: runtime(3.5, 355) }],
  };
  const requests = [], timers = [], nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', innerHTML: '', style: {}, className: '', getContext: () => ({}),
    });
    return nodes.get(id);
  };
  let perfCalls = 0;
  class ClockDate extends Date { static now() { return clock.now; } }
  const window = { __DIRECT__: true, addEventListener() {} };
  const context = vm.createContext({
    window, document: { getElementById: node }, location: { search: '' },
    URLSearchParams, Date: ClockDate,
    performance: { now: () => perfCalls++ % 2 === 0 ? 0 : requestDuration },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ result: snapshot }) };
    },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    captureCoachSample() {}, updateBoatPicker() {}, updateMapWeather() {},
  });
  for (const file of ['state.js', 'api.js', 'feed.js', 'calc.js', 'tactics.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js', file), 'utf8'), context);
  }
  window.S.race = { raceCd: 'test-race', levelName: '测试组', roundName: 'R1' };
  window.S.gen = 1;
  return { context, S: window.S, clock, snapshot, deviceTime, requests, timers, nodes };
}

test('直连快照仍请求官方live2，保留raceCd、毫秒time和禁用缓存', async () => {
  const s = liveScene();
  const raceCd = 'race /+?';
  const result = await s.context.directJSON('/api/snap?raceCd=' + encodeURIComponent(raceCd));
  assert.equal(s.requests.length, 1);
  const request = s.requests[0], url = new URL(request.url);
  assert.equal(url.origin, 'https://www.saill.cn');
  assert.equal(url.pathname, '/sf-admin/api/app-api/match/race/live2/getRaceDatas');
  assert.equal(url.searchParams.get('raceCd'), raceCd);
  assert.equal(url.searchParams.get('time'), String(s.clock.now));
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.method || 'GET', 'GET');
  assert.equal(result.t, s.clock.now);
  assert.equal(result.data, s.snapshot);
});

test('轮询默认仍为1000ms，按原规则扣请求耗时并保留200ms下限', async () => {
  for (const [requestDuration, nextDelay] of [[80, 920], [1400, 200]]) {
    const s = liveScene({ requestDuration });
    assert.equal(s.S.pollMs, 1000);
    await s.context.poll();
    assert.equal(s.requests.length, 1);
    assert.equal(s.timers.length, 1);
    assert.equal(s.timers[0].delay, nextDelay);
    assert.equal(s.S.polls, 1);
    assert.equal(s.S.errors, 0);
  }
});

test('摄入沿用runtime速度10、设备时间22和接收时间23，不误读旧注释的19', () => {
  const s = liveScene();
  s.context.ingest(s.snapshot, s.clock.now);
  const boat = s.S.dev.get('test-boat');
  assert.equal(boat.spd, 2.5);
  assert.notEqual(boat.spd, s.snapshot.teamList[0].runtime[19]);
  assert.equal(boat.hdg, 270);
  assert.equal(boat.lat, 22);
  assert.equal(boat.lng, 113);
  assert.equal(boat.ts, s.deviceTime);
  assert.equal(boat.rx, s.deviceTime + 1000);
  assert.equal(s.S.wind.spd, 3.5);
  assert.equal(s.S.wind.from, 355);
  assert.equal(s.S.wind.ts, s.deviceTime);
  const point = s.S.hist.get('test-boat')[0];
  assert.equal(point.t, s.deviceTime);
  assert.equal(point.timed, true);
});

test('重新拉到旧快照只更新接口拉取时间，不把设备旧位置伪造成新鲜样本', async () => {
  const s = liveScene({ deviceAge: 5 * 60 * 1000 });
  await s.context.poll();
  s.clock.now += 1000;
  await s.context.poll();
  const boat = s.S.dev.get('test-boat');
  assert.equal(s.S.lastMeta, s.clock.now);
  assert.equal(boat.ts, s.deviceTime);
  assert.notEqual(boat.ts, s.S.lastMeta);
  assert.equal(s.S.wind.ts, s.deviceTime);
  assert.equal(s.context.predictionFresh(boat, s.clock.now), false);
  assert.equal(s.context.freshPosition(boat, s.clock.now), false);
  const history = s.S.hist.get('test-boat');
  assert.equal(history.length, 1);
  assert.equal(history[0].t, s.deviceTime);
  assert.match(s.nodes.get('boats').innerHTML, /row stale/);
});
