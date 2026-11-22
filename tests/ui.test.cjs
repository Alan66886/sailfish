const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 只实现 ui.js 使用的 DOM 能力，节点和从属关系来自真实页面。
function documentStub() {
  const nodes = new Map(), listeners = new Map();
  const document = { activeElement: null,
    getElementById: id => nodes.get(id) || null,
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  function createElement(tag) {
    const attributes = new Map(), classes = new Set();
    const element = { tagName: tag.toUpperCase(), children: [], parentElement: null,
      textContent: '', value: '', checked: false, disabled: false, hidden: false,
      inert: false, dataset: {}, style: {},
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, force) {
          const on = force === undefined ? !classes.has(value) : force;
          if (on) classes.add(value); else classes.delete(value);
          return on;
        },
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
        if (name === 'id') { this.id = value; nodes.set(value, this); }
        if (name === 'class') for (const name of value.split(/\s+/)) classes.add(name);
        if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
        if (['hidden', 'checked', 'disabled'].includes(name)) this[name] = true;
        if (name === 'value') this.value = value;
      },
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name),
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      contains(child) { return this === child || this.children.some(node => node.contains(child)); },
      focus() { document.activeElement = this; },
      querySelectorAll(selector) {
        const choices = selector.split(',').map(part => part.trim()), found = [];
        const visit = parent => {
          for (const child of parent.children) {
            if (choices.some(choice => choice.startsWith('.')
              ? child.classList.contains(choice.slice(1)) : child.tagName === choice.toUpperCase())) found.push(child);
            visit(child);
          }
        };
        visit(this); return found;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      get offsetParent() {
        for (let node = this; node; node = node.parentElement) if (node.hidden) return null;
        return document.body || this.parentElement;
      },
      set innerHTML(value) { this.children = []; this.textContent = value; },
    };
    return element;
  }
  document.createElement = createElement;
  const source = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [], voidTags = new Set(['meta', 'input', 'link', 'br', 'hr', 'img']);
  for (const token of source.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi)) {
    if (token[3]) { if (stack.length) stack.at(-1).textContent += token[3]; continue; }
    if (token[0].startsWith('</')) { stack.pop(); continue; }
    const tag = token[1].toLowerCase(), element = createElement(tag);
    for (const attribute of token[2].matchAll(/([^\s=\/]+)(?:\s*=\s*"([^"]*)")?/g)) {
      element.setAttribute(attribute[1], attribute[2] || '');
    }
    if (stack.length) stack.at(-1).appendChild(element);
    if (tag === 'html') document.documentElement = element;
    if (tag === 'body') document.body = element;
    if (!voidTags.has(tag) && !token[0].endsWith('/>')) stack.push(element);
  }
  return { document, nodes, listeners };
}

function uiScene({ saved = new Map(), storageFails = false } = {}) {
  const dom = documentStub(), el = id => dom.document.getElementById(id);
  let now = 1700000000000;
  const boat = { key: 'own', kind: 'boat', name: '测试船', ts: now, spd: 3 };
  const S = { screen: 'race', theme: 'day', anchor: {}, focusBoat: boat.key,
    dev: new Map([[boat.key, boat]]), view: { follow: true, mode: 'fleet' },
    layers: { trails: true, labels: false, otherPredictions: false, grid: true },
    showPred: true, showLay: false, cur: { dir: null, spd: 0 },
    wind: { ts: now, from: 45, spd: 5 },
  };
  const calls = { resize: 0, start: [], dashboard: [] };
  const context = vm.createContext({
    S, el, document: dom.document, URLSearchParams, location: { search: '' },
    localStorage: {
      getItem(key) { if (storageFails) throw new Error('unavailable'); return saved.get(key); },
      setItem(key, value) { if (storageFails) throw new Error('unavailable'); saved.set(key, value); },
    },
    nowMs: () => now, KNOT: 1.94384, TACTIC_MAX_AGE_MS: 10000, PRED_MAX_AGE_MS: 30000, PRED_SEC: 60,
    num: value => Number.isFinite(parseFloat(value)) ? parseFloat(value) : null,
    predictionFresh: (boat, time) => !!boat && boat.ts <= time && time - boat.ts <= 30000,
    predict: boat => ({ pts: [30, 60].map(t => ({ t, distance: boat.spd * t })), hasCur: false }),
    boatTactics: () => ({ startDistance: 42, markDistance: 220, markProgress: 2.4, note: '测试位置参考。' }),
    updateStartAssist: (boat, time) => calls.start.push({ boat, time }),
    refreshDashboard: time => calls.dashboard.push({ time, speed: el('speedValue').textContent,
      distance: el('distance60').textContent }),
    requestAnimationFrame: callback => { callback(); return 1; },
    resize: () => { calls.resize++; },
    resetView: () => { S.view.mode = 'fleet'; S.view.follow = true; },
    focusMyBoat: () => { S.view.mode = 'boat'; S.view.follow = true; return true; },
    loadRounds() {}, selectRace() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js/ui.js'), 'utf8'), context);
  const click = id => el(id).onclick({ currentTarget: el(id), target: el(id) });
  return { ...dom, el, context, S, boat, saved, calls, click, advance: ms => { now += ms; } };
}

test('四导航与总览互斥显示，返回地图重新调整画布', () => {
  const s = uiScene();
  const views = ['mapStage', 'raceDeck', 'startAssist', 'coachPanel', 'morePage', 'dashboardPage'];
  const cases = [
    ['navStart', 'start', ['mapStage', 'startAssist'], 'navStart'],
    ['navTactics', 'tactics', ['coachPanel'], 'navTactics'],
    ['navMore', 'more', ['morePage'], 'navMore'],
    ['dashboardMore', 'dashboard', ['dashboardPage'], 'navMore'],
    ['dashGoRace', 'race', ['mapStage', 'raceDeck'], 'navRace'],
  ];
  for (const [button, screen, visible, selected] of cases) {
    s.click(button);
    assert.equal(s.S.screen, screen);
    assert.equal(s.document.body.dataset.screen, screen);
    assert.deepEqual(views.filter(id => !s.el(id).hidden), visible);
    for (const id of ['navRace', 'navStart', 'navTactics', 'navMore']) {
      assert.equal(s.el(id).getAttribute('aria-current'), id === selected ? 'page' : 'false');
    }
  }
  assert.equal(s.calls.resize, 2);
  assert.equal(s.el('dashboardOpen').getAttribute('aria-pressed'), 'false');
  s.context.showScreen('unknown');
  assert.equal(s.S.screen, 'race');
});

test('弹层限制背景与键盘焦点，关闭后恢复原有 inert 和打开按钮焦点', () => {
  const s = uiScene();
  s.click('navMore');
  s.el('startAssist').inert = true;
  s.el('navList').focus();
  s.click('navList');
  assert.equal(s.el('list').hidden, false);
  assert.equal(s.el('list').getAttribute('aria-modal'), 'true');
  assert.equal(s.el('sheetBackdrop').classList.contains('open'), true);
  assert.equal(s.el('morePage').inert, true);
  assert.equal(s.el('top').inert, true);
  assert.equal(s.document.activeElement, s.el('listClose'));
  let prevented = false;
  s.el('navMore').focus();
  s.listeners.get('keydown')({ key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(s.document.activeElement, s.el('listClose'));
  s.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(s.el('list').hidden, true);
  assert.equal(s.el('list').getAttribute('aria-modal'), null);
  assert.equal(s.el('sheetBackdrop').classList.contains('open'), false);
  assert.equal(s.el('morePage').inert, false);
  assert.equal(s.el('top').inert, false);
  assert.equal(s.el('startAssist').inert, true);
  assert.equal(s.el('navList').getAttribute('aria-expanded'), 'false');
  assert.equal(s.document.activeElement, s.el('navList'));
  s.context.showScreen('race');
  s.click('mapLayers');
  s.click('sheetBackdrop');
  assert.equal(s.el('layerPanel').hidden, true);
  assert.equal(s.document.activeElement, s.el('mapLayers'));
});

test('日间夜间选择在重新载入后保留，存储不可用仍可切换', () => {
  const s = uiScene();
  assert.equal(s.document.documentElement.dataset.theme, 'day');
  s.click('themeToggle');
  assert.equal(s.S.theme, 'night');
  assert.equal(s.saved.get('sailfish.theme'), 'night');
  assert.match(s.el('themeToggle').getAttribute('aria-label'), /切换强光日间/);
  const restored = uiScene({ saved: s.saved });
  assert.equal(restored.document.documentElement.dataset.theme, 'night');
  restored.click('themeToggle');
  assert.equal(restored.saved.get('sailfish.theme'), 'day');
  const invalid = uiScene({ saved: new Map([['sailfish.theme', 'invalid']]) });
  assert.equal(invalid.S.theme, 'day');
  const unavailable = uiScene({ storageFails: true });
  assert.doesNotThrow(() => unavailable.click('themeToggle'));
  assert.equal(unavailable.document.documentElement.dataset.theme, 'night');
});

test('地图隐藏时仍更新仪表、起航和总览，过期后清除旧预判', () => {
  const s = uiScene();
  s.click('dashboardOpen');
  assert.equal(s.el('mapStage').hidden, true);
  assert.equal(s.el('speedValue').textContent, '5.8');
  assert.equal(s.el('distance60').textContent, '180');
  s.advance(1000);
  s.boat.spd = 4;
  s.context.refreshAppReadouts();
  assert.equal(s.el('speedValue').textContent, '7.8');
  assert.equal(s.el('distance30').textContent, '120');
  assert.equal(s.el('distance60').textContent, '240');
  assert.equal(s.calls.dashboard.at(-1).distance, '240');
  assert.equal(s.calls.start.at(-1).time, 1700000001000);
  assert.equal(s.el('mapStage').hidden, true);
  assert.equal(s.calls.resize, 0);
  s.advance(30001);
  s.context.refreshAppReadouts();
  assert.equal(s.el('speedValue').textContent, '—');
  assert.equal(s.el('distance60').textContent, '—');
  assert.equal(s.calls.dashboard.at(-1).distance, '—');
  assert.match(s.el('deckNote').textContent, /过期/);
  assert.equal(s.el('windTxt').textContent, '风况 —');
  assert.equal(s.el('mapDataState').hidden, false);
  assert.match(s.el('mapDataState').textContent, /官方位置未更新.*最后上报/);
  s.boat.ts = 1700000031001;
  s.context.refreshAppReadouts();
  assert.equal(s.el('mapDataState').hidden, true);
});
