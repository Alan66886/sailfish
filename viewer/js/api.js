'use strict';
// 拉数据:server.py 的 /api/* 或直连 saill.cn;lz-string 解压;组别/场次
/* ---------- 拉数据 ----------
   两种活法:
   1) 由 viewer/server.py 伺候(桌面浏览器、局域网地址):走本机 /api/*,它已经解好压、绕开跨域。
   2) 单文件 html 直接放手机上跑(window.__DIRECT__):没有服务端,自己去 saill.cn 拿。
      那个站 CORS 是放开的(allow-origin 回显 / *),live2 的快照是 lz-string 压的,下面自己解。
*/
const API_BASE = (typeof window !== 'undefined' && window.__API__) || '';
const DIRECT = (typeof window !== 'undefined' && window.__DIRECT__) || false;
const EVENT_CD = (typeof window !== 'undefined' && window.__EVENT__)
  || new URLSearchParams(location.search).get('eventCd')
  || 'scf1fea990ea3649999c6686076b54286b';
const SA = 'https://www.saill.cn/sf-admin/api/app-api/match/race';
const SF = 'https://www.saill.cn/sf-front-api/api';

/* lz-string 的 decompressFromBase64(getRaceDatas 的 result 就是它压的),照 tools/lzstring.py 搬的 */
const LZ_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
function lzDecode(input) {
  const s = String(input).replace(/ /g, '+');
  const at = i => LZ_B64.indexOf(s[i]);
  let dict = {}, enlargeIn = 4, dictSize = 4, numBits = 3, w = '', out = [];
  let val = at(0), pos = 32, idx = 1;
  function readBits(n) {
    let bits = 0, power = 1;
    const max = 1 << n;
    while (power !== max) {
      const b = val & pos;
      pos >>= 1;
      if (pos === 0) { pos = 32; val = at(idx); idx++; }
      if (b > 0) bits |= power;
      power <<= 1;
    }
    return bits;
  }
  const head = readBits(2);
  let c;
  if (head === 0) c = String.fromCharCode(readBits(8));
  else if (head === 1) c = String.fromCharCode(readBits(16));
  else if (head === 2) return '';
  else throw new Error('lz 头不对');
  dict[3] = c; w = c; out.push(c);
  for (;;) {
    if (idx > s.length) return '';
    let code = readBits(numBits);
    if (code === 0) { dict[dictSize++] = String.fromCharCode(readBits(8)); code = dictSize - 1; enlargeIn--; }
    else if (code === 1) { dict[dictSize++] = String.fromCharCode(readBits(16)); code = dictSize - 1; enlargeIn--; }
    else if (code === 2) return out.join('');
    if (enlargeIn === 0) { enlargeIn = 1 << numBits; numBits++; }
    let ent;
    if (dict[code] !== undefined) ent = dict[code];
    else if (code === dictSize) ent = w + w[0];
    else throw new Error('lz 码不对');
    out.push(ent);
    dict[dictSize++] = w + ent[0];
    w = ent;
    enlargeIn--;
    if (enlargeIn === 0) { enlargeIn = 1 << numBits; numBits++; }
  }
}

function lzUnpack(o) {
  const s = (o || {}).result;
  if (typeof s === 'string' && s) return JSON.parse(lzDecode(s));
  return (s && typeof s === 'object') ? s : {};
}

async function saFetch(url, payload) {
  const opt = payload === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* 直连时自己把这几个 /api/* 拼出来,返回的格式和服务端一模一样 */
async function directJSON(url) {
  const [path, qs] = url.split('?');
  const q = new URLSearchParams(qs || '');
  if (path === '/api/snap') {
    const cd = q.get('raceCd');
    const d = lzUnpack(await saFetch(`${SA}/live2/getRaceDatas?&raceCd=${encodeURIComponent(cd)}`
      + `&time=${Date.now()}`, undefined));
    return { t: Date.now(), data: d };
  }
  if (path === '/api/rounds') {
    const lv = q.get('levelCd');
    const resp = await saFetch(`${SF}/level/race/${encodeURIComponent(lv)}`, {});
    const arr = (resp && resp.result) || [];
    const out = arr.filter(r => r.raceCd).map(r => ({
      roundName: r.roundName, raceCd: r.raceCd, frontStatus: r.status,
      raceMark: r.raceMark, startTime: r.startTime, endTime: r.endTime, traceUrl: r.traceUrl,
    }));
    out.sort((a, b) => (!a.startTime - !b.startTime)
      || ((Number(a.startTime) || 0) - (Number(b.startTime) || 0)));
    return out;
  }
  if (path === '/api/races') {
    const resp = await saFetch(`${SF}/event/level/${q.get('eventCd') || EVENT_CD}`, {});
    const levels = (resp && resp.result) || [];
    const out = [];
    for (const lv of levels) {
      const r = lv.race || {};
      if (!r.raceCd) continue;
      const item = { levelName: lv.levelName, levelCd: lv.levelCd,
        roundName: r.roundName, raceCd: r.raceCd, frontStatus: r.status,
        raceMark: r.raceMark, traceUrl: r.traceUrl, status: null, state: 'unknown' };
      try {
        const info = (await saFetch(`${SA}/getRace?pageName=open_trac&raceCd=${encodeURIComponent(r.raceCd)}`)
        ).data || {};
        item.status = Number.isFinite(Number(info.status)) && info.status !== '' ? Number(info.status) : null;
        item.startTime = info.startTime; item.endTime = info.endTime;
        item.raceName = info.raceName;
        item.state = item.status === 10 ? 'waiting' : item.status === 99 ? 'over'
          : item.status !== null ? 'running' : 'unknown';
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
    const order = { running: 0, waiting: 1, unknown: 2, over: 3 };
    out.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
    return out;
  }
  throw new Error('不认识的接口 ' + path);
}

async function getJSON(url) {
  if (DIRECT) return directJSON(url);
  const r = await fetch(API_BASE + url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function loadRaces() {
  try {
    const list = await getJSON('/api/races');
    S.races = list;
    const sel = el('sel');
    sel.innerHTML = '';
    for (const r of list) {
      const o = document.createElement('option');
      o.value = r.levelCd;
      const tag = r.state === 'running' ? '● 进行中' : r.state === 'waiting' ? '待发'
        : r.state === 'over' ? '已结束' : '?';
      o.textContent = `${r.levelName} · ${tag}`;
      sel.appendChild(o);
    }
    // 优先:地址栏 ?raceCd= 落到哪一组就选哪一组,否则第一组(在跑的排最前)
    const want = new URLSearchParams(location.search).get('raceCd');
    const hit = want && list.find(r => r.raceCd === want);
    const lv = hit ? hit.levelCd : (list[0] && list[0].levelCd);
    if (!lv) { showMsg('这个赛事还没排比赛'); return; }
    sel.value = lv;
    await loadRounds(lv, want);
  } catch (e) {
    showMsg('拿不到比赛列表:' + e.message);
  }
}

/* 切组别:把这一组的 R1..Rn 拉下来填进第二个下拉 */
async function loadRounds(levelCd, wantCd) {
  const cur = S.races.find(r => r.levelCd === levelCd) || {};
  let list = [];
  try {
    list = await getJSON('/api/rounds?levelCd=' + encodeURIComponent(levelCd));
  } catch (e) {
    S.log.push('场次列表:' + e.message);
    showMsg('拿不到场次:' + e.message);
  }
  if (!list.length && cur.raceCd) {
    list = [{ roundName: cur.roundName, raceCd: cur.raceCd, frontStatus: cur.frontStatus }];
  }
  S.rounds = list;
  const sel = el('round');
  sel.innerHTML = '';
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r.raceCd;
    const done = String(r.frontStatus) === '4';
    o.textContent = (r.roundName || '?') + (done ? ' ✓' : '');
    sel.appendChild(o);
  }
  // 默认:地址栏指定 > 官方当前那一场(没比完才算) > 第一个没比完的 > 最后一场
  const notOver = list.filter(r => String(r.frontStatus) !== '4');
  const pick = (wantCd && list.find(r => r.raceCd === wantCd))
    || (String(cur.frontStatus) !== '4' && list.find(r => r.raceCd === cur.raceCd))
    || notOver[0] || list[list.length - 1];
  if (!pick) { showMsg('这组还没有场次'); return; }
  sel.value = pick.raceCd;
  selectRace(pick.raceCd);
}

function selectRace(cd) {
  S.gen = (S.gen || 0) + 1;
  const lvCd = el('sel').value;
  const lv = S.races.find(r => r.levelCd === lvCd) || {};
  const rd = (S.rounds || []).find(r => r.raceCd === cd) || {};
  S.race = {
    raceCd: cd, levelCd: lvCd, levelName: lv.levelName,
    levelStatus: lv.status, roundName: rd.roundName || lv.roundName,
    frontStatus: rd.frontStatus,
  };
  S.dev.clear(); S.hist.clear(); S.anchor = null; S.data = null; S.wind = null;
  S.view.follow = true;
  el('follow').textContent = '自动框住:开';
  el('race').textContent = [lv.levelName, S.race.roundName].filter(Boolean).join(' · ') || '比赛';
  setPill(el('status'), '读…', 'pill');
  S.polls = 0;
  showMsg('等着第一条数据…');
  poll();
}

function showMsg(t) {
  const m = el('msg');
  m.style.display = t ? 'block' : 'none';
  m.textContent = t || '';
}
