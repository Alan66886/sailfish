const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../viewer/js/dashboard.js'), 'utf8');
const ageHelper = fs.readFileSync(path.join(__dirname, '../viewer/js/ui.js'), 'utf8')
  .match(/function dataAgeText\(seconds\) \{[\s\S]*?\n\}/)[0];

function reportFixture(overrides = {}) {
  return {
    id: 'report-one', createdAt: 1700000000000, raceCd: 'current-race', label: '测试组 · R1',
    summary: { version: 1, scope: 'first_upwind_leg', duration_s: 300,
      paired_windows: 8, left: { boat_count: 4 }, right: { boat_count: 4 },
      comparison: { favored: 'left', median_delta_kn: 0.4, confidence: 'low' },
      quality: { geometry_changed: false } },
    analysis: null, model: '', ...overrides,
  };
}

function scene() {
  const now = 1700000005000;
  const values = { speedValue: '4.7', distance30: '72', distance60: '144',
    deckNote: '航程从最新上报位置起算，保持当前航向 / 速度。',
    startCountdown: '00:15', startEta: '约22秒', startDelta: '晚7秒',
    startHint: '早晚相对手动起航时刻，不作抢航判定。',
    startDistance: '45', markDistance: '600', markProgress: '3.1' };
  const nodes = new Map(), writes = [];
  const el = id => {
    if (!nodes.has(id)) {
      let text = values[id] || '';
      const node = { value: id === 'coachScope' ? 'first_upwind_leg' : '' };
      Object.defineProperty(node, 'textContent', {
        get: () => text,
        set: value => { assert.equal(typeof value, 'string'); text = value; writes.push(id); },
      });
      Object.defineProperty(node, 'innerHTML', { set: () => { throw new Error('禁止HTML注入'); } });
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const boat = { key: 'own', kind: 'boat', name: '本船测试', ts: now - 2000, lat: 20, lng: 110, spd: 2.4 };
  const S = { dev: new Map([[boat.key, boat]]), focusBoat: boat.key, showPred: true,
    race: { raceCd: 'current-race', levelName: '测试组', roundName: 'R2' },
    startAt: now + 15000, wind: { from: 355, spd: 6, ts: now - 3000 },
    cur: { dir: null, spd: 0 }, lastMeta: now - 1000, errors: 0 };
  const coachState = { session: null, reports: [], activeId: '', service: null, busy: false };
  const context = vm.createContext({
    S, coachState, el, nowMs: () => now, KNOT: 1.94384, DIRECT: false, API_BASE: '',
    COACH_LIMIT_MS: 5400000,
    COACH_SCOPES: { first_upwind_leg: '首个迎风段', first_lap: '第一圈', first_race: '第一场' },
    coachReport: () => coachState.reports.find(report => report.id === coachState.activeId),
    predictionFresh: (dv, t) => Number.isFinite(dv.ts) && dv.ts > 0 && t >= dv.ts && t - dv.ts <= 30000,
    freshPosition: (dv, t) => Number.isFinite(dv.ts) && dv.ts > 0 && t >= dv.ts && t - dv.ts <= 10000
      && Number.isFinite(dv.lat) && Number.isFinite(dv.lng),
    boatTactics: (dv, t) => ({ note: t - dv.ts > 10000 ? '本船位置超过10秒，暂停位置参考。' : '推进按近期轨迹估算；距离为位置参考。' }),
    setInterval: () => { throw new Error('总览不得重复注册定时器'); },
    fetch: () => { throw new Error('总览不得发送请求'); },
  });
  vm.runInContext(ageHelper, context);
  vm.runInContext(script, context);
  const refresh = (t = now) => context.refreshDashboard(t);
  const text = id => el(id).textContent;
  return { now, S, boat, coachState, context, nodes, writes, el, refresh, text };
}

test('总览复用既有仪表，保留量纲、手动起航说明和原位置节点', () => {
  const s = scene();
  s.refresh();
  assert.equal(s.text('dashRace'), '测试组 · R2');
  assert.equal(s.text('dashBoat'), '本船测试');
  assert.equal(s.text('dashFresh'), '2秒前上报');
  assert.equal(s.text('dashSpeed'), '4.7');
  assert.equal(s.text('dash30'), '72');
  assert.equal(s.text('dash60'), '144');
  assert.equal(s.text('dashCountdown'), '00:15');
  assert.equal(s.text('dashCountdownLabel'), '距手动起航');
  assert.equal(s.text('dashEta'), '约22秒');
  assert.equal(s.text('dashDelta'), '晚7秒');
  assert.match(s.text('dashStartNote'), /距手动起航.*不作抢航判定/);
  assert.equal(s.text('dashDataNote'), s.text('deckNote'));
  assert.equal(s.text('startDistance'), '45');
  assert.ok(s.writes.every(id => id.startsWith('dash')));
});

test('未选船时不复制残留数字；关闭预判时隐藏旧航程', () => {
  const s = scene();
  s.S.focusBoat = '';
  s.refresh();
  for (const id of ['dashBoat', 'dashSpeed', 'dash30', 'dash60', 'dashEta', 'dashDelta']) assert.equal(s.text(id), '—');
  assert.match(s.text('dashFresh'), /未选择/);
  assert.match(s.text('dashPositionNote'), /先选择/);
  s.S.focusBoat = s.boat.key;
  s.S.showPred = false;
  s.refresh();
  assert.equal(s.text('dashSpeed'), '4.7');
  assert.equal(s.text('dash30'), '—');
  assert.equal(s.text('dash60'), '—');
});

test('船位、风和连接年龄复用秒分小时显示，不改变过期判断', () => {
  const s = scene();
  for (const [seconds, label] of [[2, '2秒'], [125, '2分'], [25125, '6小时58分']]) {
    s.boat.ts = s.S.wind.ts = s.S.lastMeta = s.now - seconds * 1000;
    s.refresh();
    assert.equal(s.text('dashFresh'), `${seconds > 30 ? '已过期 · ' : ''}${label}前上报`);
    assert.ok(s.text('dashWindAge').startsWith(`${label}前上报`));
    assert.ok(s.text('dashConnection').startsWith(seconds > 5 ? `快照已${label}未刷新` : `快照${label}前更新`));
    assert.equal(s.text('dashSpeed'), seconds > 30 ? '—' : '4.7');
    assert.equal(s.text('dashWindDirection'), seconds > 10 ? '—' : '355°');
  }
  s.S.wind.ts = s.now - 24750000;
  s.refresh();
  assert.match(s.text('dashWindAge'), /^6小时52分前上报，已过期/);
});

test('总览使用共享的完整说明，不把地图短句当作全部数据条件', () => {
  const s = scene();
  s.S.fullDeckNote = '完整说明：从最新设备位置起算，保持航向和速度，含手动水流假设。';
  s.S.tacticsNote = '共享位置说明：轨迹有效，按近期对地运动估算。';
  s.el('deckNote').textContent = '地图短句';
  s.context.boatTactics = () => { throw new Error('已有位置结果时无需重复计算'); };
  s.refresh();
  assert.equal(s.text('dashDataNote'), s.S.fullDeckNote);
  assert.equal(s.text('dashPositionNote'), s.S.tacticsNote);
});

test('10秒位置与30秒航程新鲜度不同；未知和未来时间均不沿用旧值', () => {
  const s = scene();
  s.boat.ts = s.now - 10001;
  s.refresh();
  assert.equal(s.text('dash30'), '72');
  assert.equal(s.text('dashEta'), '—');
  assert.equal(s.text('dashDelta'), '—');
  assert.match(s.text('dashPositionNote'), /超过10秒/);
  for (const timestamp of [s.now - 30001, null, s.now + 1]) {
    s.boat.ts = timestamp;
    s.refresh();
    for (const id of ['dashSpeed', 'dash30', 'dash60']) assert.equal(s.text(id), '—');
    assert.match(s.text('dashDataNote'), /过期或时间无效/);
  }
});

test('已过手动起航和未校准分别显示，不生成新的倒计时模型', () => {
  const s = scene();
  s.S.startAt = s.now - 2000;
  s.el('startCountdown').textContent = '00:02';
  s.refresh();
  assert.equal(s.text('dashCountdown'), '00:02');
  assert.equal(s.text('dashCountdownLabel'), '手动起航后');
  assert.match(s.text('dashStartNote'), /手动起航后/);
  s.S.startAt = null;
  s.refresh();
  assert.equal(s.text('dashCountdown'), '—');
  assert.equal(s.text('dashCountdownLabel'), '距手动起航');
  assert.equal(s.text('dashDelta'), '—');
});

test('当前风况仅显示10秒内有效仪器数据，过期保留年龄说明', () => {
  const s = scene();
  s.refresh();
  assert.equal(s.text('dashWindDirection'), '355°');
  assert.equal(s.text('dashWindSpeed'), '11.7 kn');
  assert.match(s.text('dashWindAge'), /3秒.*来向/);
  s.S.wind.ts = s.now - 10001;
  s.refresh();
  assert.equal(s.text('dashWindDirection'), '—');
  assert.equal(s.text('dashWindSpeed'), '—');
  assert.match(s.text('dashWindAge'), /10秒.*已过期/);
  s.S.wind.ts = s.now;
  s.S.wind.from = 360;
  s.refresh();
  assert.equal(s.text('dashWindDirection'), '—');
  assert.match(s.text('dashWindAge'), /读数无效/);
  s.S.wind = null;
  s.refresh();
  assert.match(s.text('dashWindAge'), /尚无/);
});

test('水流明确是手动假设，在线船数排除航标、过期和无效位置', () => {
  const s = scene();
  s.S.cur = { dir: 90, spd: 1.2 };
  for (const d of [
    { ...s.boat, key: 'recent', ts: s.now - 30000 },
    { ...s.boat, key: 'old', ts: s.now - 30001 },
    { ...s.boat, key: 'bad', lat: NaN },
    { ...s.boat, key: 'mark', kind: 'mark' },
  ]) s.S.dev.set(d.key, d);
  s.refresh();
  assert.equal(s.text('dashFleet'), '2 / 4');
  assert.match(s.text('dashCurrent'), /90°.*1\.2 kn.*手动假设/);
  assert.match(s.text('dashConnection'), /30秒内有效位置/);
  s.S.errors = 2;
  s.refresh();
  assert.match(s.text('dashConnection'), /拉取失败 ×2/);
});

test('录制范围和经过时间来自当前会话，没有自动圈数推断', () => {
  const s = scene();
  s.coachState.session = { scope: 'first_lap', startedAt: s.now - 65000 };
  s.refresh();
  assert.equal(s.text('dashRecording'), '记录中 · 1分05秒');
  assert.equal(s.text('dashScope'), '第一圈');
  s.refresh(s.now + 2000);
  assert.equal(s.text('dashRecording'), '记录中 · 1分07秒');
  assert.equal(s.text('dashReport'), '—');
  assert.match(s.text('dashEvidence'), /还没有已完成报告/);
});

test('历史报告保留自身范围、时刻、证据和跨场次提示', () => {
  const s = scene();
  const report = reportFixture({ raceCd: 'old-race', label: '其他组 · R1' });
  report.summary.scope = 'first_race';
  s.coachState.reports = [report];
  s.coachState.activeId = report.id;
  s.refresh();
  assert.match(s.text('dashReport'), /样本内.*左侧/);
  assert.match(s.text('dashEvidence'), /8.*30秒窗.*左 4.*右 4.*0\.40 kn/);
  assert.match(s.text('dashEvidence'), /证据强度：低/);
  assert.match(s.text('dashReportTime'), /第一场.*2023.*其他组 · R1/);
  assert.match(s.text('dashReportNote'), /其他场次.*不能直接.*同方向迎风/);
  s.S.race = null;
  s.refresh();
  assert.match(s.text('dashReportNote'), /当前未选择场次/);
});

test('录制中新范围不会覆盖已保存报告的范围，当前选中报告优先', () => {
  const s = scene();
  const first = reportFixture({ id: 'new' });
  const selected = reportFixture({ id: 'selected', label: '选中的旧报告' });
  selected.summary.scope = 'first_race';
  s.coachState.reports = [first, selected];
  s.coachState.activeId = selected.id;
  s.coachState.session = { scope: 'first_lap', startedAt: s.now - 10000 };
  s.refresh();
  assert.equal(s.text('dashScope'), '第一圈');
  assert.match(s.text('dashReportTime'), /第一场.*选中的旧报告/);
});

test('航线改变或证据不足时不把旧AI选边文字当有效结论', () => {
  const s = scene();
  const report = reportFixture({ analysis: { summary: '旧的左侧优势结论', evidence: ['旧的依据'] }, model: '测试模型' });
  report.summary.quality.geometry_changed = true;
  s.coachState.reports = [report];
  s.refresh();
  assert.equal(s.text('dashReport'), '证据不足，暂不选边');
  assert.doesNotMatch(s.text('dashEvidence'), /旧的依据/);
  assert.match(s.text('dashReportNote'), /航标明显移动/);
});

test('模型状态区分未配置、暂不可用和单文件，绝不输出会话令牌', () => {
  const s = scene();
  s.refresh();
  assert.match(s.text('dashAIService'), /未连接或暂不可用/);
  s.coachState.service = { configured: false, token: 'private-session' };
  s.refresh();
  assert.match(s.text('dashAIService'), /AI未配置/);
  s.coachState.service = { configured: true, model: '测试模型', token: 'private-session' };
  s.refresh();
  assert.match(s.text('dashAIService'), /AI已配置.*测试模型.*手动/);
  assert.doesNotMatch(s.text('dashAIService'), /private-session|已连接/);
  s.coachState.busy = true;
  s.refresh();
  assert.match(s.text('dashAIService'), /AI解读中/);
  s.context.DIRECT = true;
  s.refresh();
  assert.match(s.text('dashAIService'), /单文件模式/);
});

test('报告和船名中的标记只能作为文字显示，不注入HTML或绑定导航', () => {
  const s = scene();
  const hostile = '<img src=x onerror=alert(1)>';
  s.boat.name = hostile;
  s.coachState.reports = [reportFixture({ analysis: { summary: hostile, evidence: [hostile] }, model: hostile })];
  s.refresh();
  assert.equal(s.text('dashBoat'), hostile);
  assert.ok(s.text('dashReport').includes(hostile));
  assert.ok(s.text('dashEvidence').includes(hostile));
  assert.ok(s.writes.every(id => id.startsWith('dash')));
});

test('缺失可选节点和数据时仍能刷新，总览本身不启动额外timer或请求', () => {
  const s = scene();
  s.S.dev.clear(); s.S.focusBoat = ''; s.S.race = null; s.S.lastMeta = null;
  s.refresh();
  assert.equal(s.text('dashFleet'), '—');
  assert.match(s.text('dashConnection'), /等待实时快照/);
  s.context.el = () => null;
  assert.doesNotThrow(() => s.refresh());
});
