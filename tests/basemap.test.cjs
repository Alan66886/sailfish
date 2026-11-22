const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scene({ width = 800, height = 500, ratio = 2 } = {}) {
  const radius = 6371000, degrees = Math.PI / 180;
  const S = { anchor: { lat: 22.78155, lng: 113.59755 }, W: width, H: height, theme: 'day',
    view: { k: 1, cx: 0, cy: 0 } };
  S.view.k = 256 * 2 ** 16 / (2 * Math.PI * radius * Math.cos(S.anchor.lat * degrees));
  let now = 1700000000000, nextTimer = 0, active = 0, maxActive = 0;
  const timers = new Map(), images = [], drawn = [], fills = [];
  const node = { textContent: '' };
  class FakeImage {
    constructor() { this.pending = false; this.naturalWidth = 0; this.naturalHeight = 0; images.push(this); }
    set src(value) {
      this.url = value;
      if (!value) { if (this.pending) active--; this.pending = false; return; }
      this.pending = true; active++; maxActive = Math.max(maxActive, active);
    }
    get src() { return this.url; }
    finish(success = true) {
      if (!this.pending) return;
      active--; this.pending = false;
      if (success) { this.naturalWidth = ratio > 1 ? 512 : 256; this.naturalHeight = this.naturalWidth; }
      const callback = success ? this.onload : this.onerror;
      if (callback) callback();
    }
  }
  const ctx = { fillStyle: '', fillRect(...args) { fills.push({ color: this.fillStyle, args }); },
    drawImage(...args) { drawn.push(args); } };
  const project = (lat, lng) => ({ x: (lng - S.anchor.lng) * degrees * radius * Math.cos(S.anchor.lat * degrees),
    y: -(lat - S.anchor.lat) * degrees * radius });
  const context = vm.createContext({ S, ctx, project,
    toScreen: p => ({ x: S.W / 2 + (p.x - S.view.cx) * S.view.k,
      y: S.H / 2 + (p.y - S.view.cy) * S.view.k }),
    el: () => node, window: { devicePixelRatio: ratio }, Image: FakeImage, Date: { now: () => now },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/js/basemap.js'), 'utf8'), context);
  return { context, S, images, node, drawn, fills, timers,
    maxActive: () => maxActive,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    completeAll() {
      let loops = 0;
      while (images.some(i => i.pending)) {
        if (++loops > 100) throw new Error('Unbounded image request loop');
        images.filter(i => i.pending).forEach(i => i.finish());
      }
    } };
}

test('官网已核实坐标直接映射XYZ，不加GCJ偏移，retina仍使用同一zoom', () => {
  const s = scene();
  const tile = s.context.officialMapTileXY(22.78155, 113.59755, 16);
  assert.equal(Math.floor(tile.x), 53447);
  assert.equal(Math.floor(tile.y), 28506);
  assert.equal(s.context.officialMapZoom(), 16);
  const visible = s.context.officialMapVisibleTiles();
  assert.ok(visible.some(t => t.x === 53447 && t.y === 28505));
  for (const item of visible) {
    assert.match(item.url, /^https:\/\/[abc]\.sfcdn\.cn\/tiles\/vector\/16\/\d+\/\d+\.png\?scale=@2x$/);
  }
  assert.ok(visible.length <= 64);
});

test('瓦片角点与原局部project和视图完全对齐，不修改任何船位/缩放状态', () => {
  const s = scene(), before = JSON.stringify(s.S);
  const tile = s.context.officialMapVisibleTiles().find(t => t.x === 53447 && t.y === 28506);
  const rect = s.context.officialMapTileRect(tile);
  assert.ok(Math.abs(rect.width - 256) < 1e-6);
  assert.ok(rect.x <= s.S.W / 2 && rect.x + rect.width >= s.S.W / 2);
  assert.ok(rect.y <= s.S.H / 2 && rect.y + rect.height >= s.S.H / 2);
  const center = s.context.officialMapScreenLatLng(s.S.W / 2, s.S.H / 2);
  assert.equal(center.lat, s.S.anchor.lat);
  assert.equal(center.lng, s.S.anchor.lng);
  s.context.drawOfficialBasemap();
  assert.equal(JSON.stringify(s.S), before);
});

test('并发最多4个，未加载块留官网灰底，完整加载才显示成功状态', () => {
  const s = scene();
  let stats = s.context.drawOfficialBasemap();
  assert.equal(stats.loading, 4);
  assert.equal(stats.loaded, 0);
  assert.equal(s.drawn.length, 0);
  assert.match(s.node.textContent, /加载中/);
  assert.equal(s.fills[0].color, '#d4dadc');
  s.completeAll();
  stats = s.context.drawOfficialBasemap();
  assert.equal(stats.loaded, stats.visible);
  assert.equal(stats.drawn, stats.visible);
  assert.equal(s.node.textContent, '官网底图');
  assert.equal(s.maxActive(), 4);
  assert.equal(s.drawn[0][3], 512);
  s.S.theme = 'night'; s.context.drawOfficialBasemap();
  assert.equal(s.fills[s.fills.length - 1].color, '#d4dadc');
});

test('错误有2秒、4秒退避；超时也释放请求槽，不假装底图完整', () => {
  const s = scene({ width: 80, height: 80 });
  s.context.drawOfficialBasemap();
  const failed = s.images[0], url = failed.url;
  failed.finish(false);
  s.context.drawOfficialBasemap();
  assert.match(s.node.textContent, /暂不可用/);
  const count = () => s.images.filter(i => i.url === url).length;
  assert.equal(count(), 0); // 失败图片src被清空，实际重试将在下一次泵送发生。
  const firstCount = s.images.length;
  s.advance(1999); s.context.drawOfficialBasemap();
  assert.equal(s.images.length, firstCount);
  s.advance(1); s.context.drawOfficialBasemap();
  assert.equal(s.images.length, firstCount + 1);
  const retry = s.images[s.images.length - 1];
  assert.equal(retry.url, url); retry.finish(false);
  const secondCount = s.images.length;
  s.advance(3999); s.context.drawOfficialBasemap();
  assert.equal(s.images.length, secondCount);
  s.advance(1); s.context.drawOfficialBasemap();
  assert.equal(s.images.length, secondCount + 1);
  s.advance(15000);
  assert.ok(s.maxActive() <= 4);
});

test('换视野后只请求当前可见块，LRU缓存不超过96个', () => {
  const s = scene();
  for (let i = 0; i < 20; i++) {
    s.S.view.cx = i * 5000;
    const stats = s.context.drawOfficialBasemap();
    assert.ok(stats.visible <= 64);
    assert.ok(stats.cacheSize <= 96);
    s.completeAll();
  }
  assert.ok(vm.runInContext('officialMapCache.size', s.context) <= 96);
  assert.ok(s.maxActive() <= 4);
});

test('缩放加载中不会使用旧层级图片冒充当前图块', () => {
  const s = scene();
  s.context.drawOfficialBasemap(); s.completeAll(); s.context.drawOfficialBasemap();
  s.drawn.length = 0;
  s.S.view.k *= 2;
  const stats = s.context.drawOfficialBasemap();
  assert.equal(stats.zoom, 17);
  assert.equal(stats.drawn, 0);
  assert.equal(s.drawn.length, 0);
  assert.match(s.node.textContent, /加载中/);
});

test('大画布仍限制可见请求，跨日期变更线URL取模而屏幕坐标连续', () => {
  const large = scene({ width: 8000, height: 8000 });
  assert.ok(large.context.officialMapVisibleTiles().length <= 64);
  const s = scene();
  s.S.anchor.lng = 179.999;
  const visible = s.context.officialMapVisibleTiles();
  assert.ok(visible.some(t => t.rawX >= 2 ** t.zoom));
  assert.ok(visible.every(t => t.x >= 0 && t.x < 2 ** t.zoom));
  const wrapped = visible.find(t => t.rawX >= 2 ** t.zoom);
  const rect = s.context.officialMapTileRect(wrapped);
  assert.ok(Number.isFinite(rect.x) && rect.x < s.S.W + 300);
});

test('地图隐藏或位置无效时不发请求，状态节点不存在也可绘制', () => {
  const s = scene();
  s.S.W = 0;
  assert.equal(s.context.drawOfficialBasemap(), null);
  assert.equal(s.images.length, 0);
  s.S.W = 800; s.S.anchor.lat = 90;
  assert.equal(s.context.drawOfficialBasemap(), null);
  assert.equal(s.images.length, 0);
  s.S.anchor.lat = 22.78155; s.context.el = () => null;
  assert.doesNotThrow(() => s.context.drawOfficialBasemap());
});
