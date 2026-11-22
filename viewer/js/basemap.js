'use strict';
// 官网 SF-TrajX 的默认 vector 底图：标准 EPSG:3857 / XYZ，256 CSS px，retina 图片512px。
// 经纬度保持官网原值；只把瓦片角点投到现有局部米制视图，不改变船位或战术计算。
const OFFICIAL_MAP_MAX_LAT = 85.0511287798066;
const OFFICIAL_MAP_LOCAL_RADIUS = 6371000;
const OFFICIAL_MAP_CACHE_LIMIT = 96;
const OFFICIAL_MAP_VISIBLE_LIMIT = 64;
const officialMapCache = new Map();
let officialMapVisible = [], officialMapActive = 0, officialMapUse = 0;

function officialMapClamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function officialMapWrap(value, count) { return ((value % count) + count) % count; }
function officialMapTileXY(lat, lng, zoom) {
  const count = 2 ** zoom;
  const phi = officialMapClamp(lat, -OFFICIAL_MAP_MAX_LAT, OFFICIAL_MAP_MAX_LAT) * Math.PI / 180;
  return { x: (lng + 180) / 360 * count,
    y: (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * count };
}
function officialMapTileLat(y, zoom) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;
}
function officialMapScreenLatLng(x, y) {
  const degrees = Math.PI / 180, metres = OFFICIAL_MAP_LOCAL_RADIUS * degrees;
  const cos = Math.cos(S.anchor.lat * degrees);
  return { lat: S.anchor.lat - (S.view.cy + (y - S.H / 2) / S.view.k) / metres,
    lng: S.anchor.lng + (S.view.cx + (x - S.W / 2) / S.view.k) / (metres * cos) };
}
function officialMapValidView() {
  return S.anchor && Number.isFinite(S.anchor.lat) && Math.abs(S.anchor.lat) < OFFICIAL_MAP_MAX_LAT
    && Number.isFinite(S.anchor.lng) && Number.isFinite(S.view.k) && S.view.k > 0
    && Number.isFinite(S.view.cx) && Number.isFinite(S.view.cy)
    && Number.isFinite(S.W) && Number.isFinite(S.H) && S.W > 0 && S.H > 0;
}
function officialMapZoom() {
  // 使用现有 project 的地球半径与锚点纬度，匹配一张256 CSS像素瓦片的地面尺度。
  const circumference = 2 * Math.PI * OFFICIAL_MAP_LOCAL_RADIUS * Math.cos(S.anchor.lat * Math.PI / 180);
  return officialMapClamp(Math.round(Math.log2(circumference * S.view.k / 256)), 0, 22);
}
function officialMapRange(zoom, northWest, southEast) {
  const count = 2 ** zoom;
  const a = officialMapTileXY(northWest.lat, northWest.lng, zoom);
  const b = officialMapTileXY(southEast.lat, southEast.lng, zoom);
  return { minX: Math.floor(a.x), maxX: Math.floor(b.x),
    minY: officialMapClamp(Math.floor(a.y), 0, count - 1),
    maxY: officialMapClamp(Math.floor(b.y), 0, count - 1) };
}
function officialMapVisibleTiles() {
  if (!officialMapValidView()) return [];
  const northWest = officialMapScreenLatLng(0, 0), southEast = officialMapScreenLatLng(S.W, S.H);
  if (southEast.lat > OFFICIAL_MAP_MAX_LAT || northWest.lat < -OFFICIAL_MAP_MAX_LAT) return [];
  let zoom = officialMapZoom(), range = officialMapRange(zoom, northWest, southEast);
  const total = r => (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  while (zoom > 0 && total(range) > OFFICIAL_MAP_VISIBLE_LIMIT) {
    zoom--; range = officialMapRange(zoom, northWest, southEast);
  }
  if (!Number.isFinite(total(range)) || total(range) > OFFICIAL_MAP_VISIBLE_LIMIT) return [];
  const retina = typeof window !== 'undefined' && window.devicePixelRatio > 1;
  const centerX = (range.minX + range.maxX) / 2, centerY = (range.minY + range.maxY) / 2;
  const tiles = [], count = 2 ** zoom;
  for (let y = range.minY; y <= range.maxY; y++) {
    for (let rawX = range.minX; rawX <= range.maxX; rawX++) {
      const x = officialMapWrap(rawX, count);
      const host = ['a', 'b', 'c'][(x + y) % 3];
      tiles.push({ zoom, x, rawX, y, retina,
        key: `${zoom}/${x}/${y}/${retina ? 2 : 1}`,
        url: `https://${host}.sfcdn.cn/tiles/vector/${zoom}/${x}/${y}.png?scale=${retina ? '@2x' : ''}`,
        priority: (rawX - centerX) ** 2 + (y - centerY) ** 2 });
    }
  }
  return tiles.sort((a, b) => a.priority - b.priority);
}
function officialMapTileRect(tile) {
  const count = 2 ** tile.zoom;
  const north = officialMapTileLat(tile.y, tile.zoom), south = officialMapTileLat(tile.y + 1, tile.zoom);
  const west = tile.rawX / count * 360 - 180, east = (tile.rawX + 1) / count * 360 - 180;
  const a = toScreen(project(north, west)), b = toScreen(project(south, east));
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}
function officialMapStatus(text) {
  const node = typeof el === 'function' ? el('mapBaseState') : null;
  if (node && node.textContent !== text) node.textContent = text;
}
function officialMapMakeRoom(wanted) {
  while (officialMapCache.size >= OFFICIAL_MAP_CACHE_LIMIT) {
    let victim = null;
    for (const entry of officialMapCache.values()) {
      if (entry.state === 'loading' || wanted.has(entry.key)) continue;
      if (!victim || entry.used < victim.used) victim = entry;
    }
    if (!victim) return false;
    officialMapCache.delete(victim.key);
  }
  return true;
}
function officialMapLoad(entry) {
  entry.state = 'loading'; entry.attempts++; officialMapActive++;
  const image = new Image();
  entry.image = image;
  let done = false, timeout = null;
  const finish = success => {
    if (done) return;
    done = true;
    if (timeout !== null) clearTimeout(timeout);
    image.onload = null; image.onerror = null;
    officialMapActive--;
    entry.state = success ? 'ready' : 'error';
    if (!success) {
      entry.image = null;
      entry.retryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(entry.attempts - 1, 5));
      image.src = ''; // 中断超时请求，不让隐藏中的旧请求占住并发槽。
    }
    if (officialMapValidView()) officialMapPump();
  };
  image.decoding = 'async';
  // 与官网 Leaflet 默认一致：普通跨域图片，不读canvas像素，也不依赖瓦片CORS响应头。
  image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
  image.onerror = () => finish(false);
  timeout = setTimeout(() => finish(false), 15000);
  image.src = entry.url;
}
function officialMapPump() {
  if (typeof Image === 'undefined' || !officialMapValidView()) return;
  const now = Date.now();
  for (const tile of officialMapVisible) {
    if (officialMapActive >= 4) break;
    const entry = officialMapCache.get(tile.key);
    if (!entry || entry.state === 'ready' || entry.state === 'loading' || entry.retryAt > now) continue;
    officialMapLoad(entry);
  }
}
function officialMapDrawable(tile) {
  const current = officialMapCache.get(tile.key);
  if (current && current.state === 'ready') return { image: current.image, x: 0, y: 0,
    width: current.image.naturalWidth, height: current.image.naturalHeight };
  return null;
}

function drawOfficialBasemap() {
  if (!officialMapValidView()) { officialMapVisible = []; officialMapStatus('等待有效位置加载官网底图'); return null; }
  officialMapVisible = officialMapVisibleTiles();
  ctx.fillStyle = '#d4dadc'; // 官网 vector 图层的原始背景，不随日夜主题染色。
  ctx.fillRect(0, 0, S.W, S.H);
  if (!officialMapVisible.length || typeof Image === 'undefined') {
    officialMapStatus('官网底图暂不可用'); return null;
  }
  const wanted = new Set(officialMapVisible.map(t => t.key));
  for (const tile of officialMapVisible) {
    let entry = officialMapCache.get(tile.key);
    if (!entry && officialMapMakeRoom(wanted)) {
      entry = { ...tile, state: 'idle', image: null, attempts: 0, retryAt: 0, used: 0 };
      officialMapCache.set(tile.key, entry);
    }
    if (entry) entry.used = ++officialMapUse;
  }
  officialMapPump();
  let loaded = 0, failed = 0, drawn = 0;
  for (const tile of officialMapVisible) {
    const entry = officialMapCache.get(tile.key);
    if (entry && entry.state === 'ready') loaded++;
    if (entry && entry.state === 'error') failed++;
    const source = officialMapDrawable(tile);
    if (!source) continue;
    const rect = officialMapTileRect(tile);
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) continue;
    ctx.drawImage(source.image, source.x, source.y, source.width, source.height,
      rect.x, rect.y, rect.width + .5, rect.height + .5);
    drawn++;
  }
  const total = officialMapVisible.length;
  officialMapStatus(loaded === total ? '官网底图'
    : failed ? (drawn ? '官网底图部分暂不可用' : '官网底图暂不可用')
      : `官网底图加载中 ${loaded}/${total}`);
  return { visible: total, loaded, failed, drawn, loading: officialMapActive,
    zoom: officialMapVisible[0].zoom, cacheSize: officialMapCache.size };
}
