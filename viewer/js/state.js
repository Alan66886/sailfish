'use strict';
// 全局状态、常量、时间/数字、经纬度->米
'use strict';
// 帆船赛实时图 —— 只吃 live2 的快照,自己在浏览器里攒轨迹。
// 数据来源:viewer/server.py 的 /api/snap、/api/races。

// runtime 数组里用得上的下标(protobuf 字段 1 起,数组 0 起)
const I_SPD = 10, I_HDG = 16, I_LAT = 17, I_LNG = 18, I_TS = 22, I_RX = 23;
const D2R = Math.PI / 180, R_EARTH = 6371000;
const KNOT = 1.94384;

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const el = id => document.getElementById(id);

const S = window.S = {
  races: [], race: null, data: null, anchor: null,
  dev: new Map(),        // key -> {name,kind,color,lat,lng,hdg,spd,ts,rx}
  hist: new Map(),       // key -> [{t,x,y}]
  view: { k: 1, cx: 0, cy: 0, follow: true },
  showPred: true,
  showLay: true,
  pollMs: 1000, lastPoll: 0, polls: 0, errors: 0,
  lastMeta: null, log: [],
  wind: null,
  cur: { dir: null, spd: 0 },   // 水流:去向(0=北,90=东)、流速 kn
};
window.addEventListener('error', e => S.log.push(String(e.message)));

/* ---------- 时间/数字 ---------- */
const nowMs = () => Date.now();
const fmtTime = ms => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const norm180 = a => ((a + 540) % 360) - 180;
const brg360 = (dx, dy) => (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- 投影:经纬度 -> 以锚点为原点的米制坐标 ---------- */
function project(lat, lng) {
  const a = S.anchor;
  return {
    x: (lng - a.lng) * D2R * R_EARTH * Math.cos(a.lat * D2R),
    y: -(lat - a.lat) * D2R * R_EARTH,
  };
}
