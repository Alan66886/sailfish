'use strict';
// 轮询、收一条快照进 S、刷新顶部和船表
/* ---------- 收一条快照 ---------- */
async function poll() {
  const cd = S.race && S.race.raceCd;
  if (!cd) return;
  const gen = S.gen;                 // 换了场次之后旧的那条轮询链自己停
  const t0 = performance.now();
  try {
    const res = await getJSON('/api/snap?raceCd=' + encodeURIComponent(cd));
    S.errors = 0;
    ingest(res.data || {}, res.t);
    setPill(el('err'), null);
  } catch (e) {
    S.errors++;
    setPill(el('err'), '拉数据失败 ×' + S.errors);
    el('err').style.display = '';
    showMsg('拉数据失败:' + e.message);
  }
  if (gen !== S.gen) return;
  S.polls++;
  const dt = performance.now() - t0;
  setTimeout(poll, Math.max(200, S.pollMs - dt));
}

function setPill(node, text, cls) {
  if (!text) { node.style.display = 'none'; return; }
  node.textContent = text;
  node.className = 'pill ' + (cls || 'bad');
  node.style.display = '';
}

function ingest(d, now) {

  const teamList = d.teamList || [];
  const marks = d.navigationMark || [];
  const winds = d.windInstrumentList || [];

  // 锚点:第一次用 centerLat/Lng,没有就用第一条船
  if (!S.anchor) {
    const clat = num(d.centerLat), clng = num(d.centerLng);
    if (clat && clng) S.anchor = { lat: clat, lng: clng };
    else {
      const t = teamList.map(t => t.runtime || []).find(r => num(r[I_LAT]));
      if (t) S.anchor = { lat: num(t[I_LAT]), lng: num(t[I_LNG]) };
    }
  }
  if (!S.anchor) {
    showMsg(S.race && String(S.race.frontStatus) === '4'
      ? '这一场已经比完了,实时数据不给了 — 换个没比完的场次'
      : '还没有位置数据');
    return;
  }

  const seen = new Set();
  const put = (key, name, rt, kind, color) => {
    if (!rt || rt.length <= I_TS) return;
    const lat = num(rt[I_LAT]), lng = num(rt[I_LNG]);
    if (lat === null || lng === null) return;
    seen.add(key);
    const prev = S.dev.get(key) || {};
    S.dev.set(key, {
      key, name: name || key, kind, color: color || prev.color || (kind === 'mark' ? '#5ad1a0' : '#ffd166'),
      lat, lng, hdg: num(rt[I_HDG]), spd: num(rt[I_SPD]), ts: num(rt[I_TS]), rx: num(rt[I_RX]),
    });
  };

  for (const t of teamList) {
    put(t.teamCd || t.sailNo, t.teamName || t.sailNo, t.runtime, 'boat', t.raceTeamColor);
  }
  for (const m of marks) {
    const rt = m.runtime || [];
    put('m:' + (rt[3] || m.navigationMarkCd), rt[3] || '', rt, 'mark', m.color || '#5ad1a0');
  }

  // 风
  let wind = null;
  if (winds.length) {
    const rt = winds[0].runtime || [];
    wind = { from: num(rt[I_HDG]), spd: num(rt[I_SPD]), ts: num(rt[I_TS]) };
  }
  S.wind = wind;

  // 轨迹:每条船/标最多留 20 分钟
  const cut = now - 20 * 60 * 1000;
  for (const [key, dv] of S.dev) {
    if (!seen.has(key)) continue;
    const p = project(dv.lat, dv.lng);
    let h = S.hist.get(key);
    if (!h) { h = []; S.hist.set(key, h); }
    const last = h[h.length - 1];
    if (!last || (dv.ts && last.t !== dv.ts)) {
      h.push({ t: dv.ts || now, x: p.x, y: p.y });
      while (h.length && h[0].t < cut) h.shift();
    }
  }

  S.data = d; S.lastMeta = now;
  showMsg(S.dev.size ? ''
    : (String(d.status) === '99' ? '这一场已经比完了,实时数据不给了 — 换个没比完的场次' : '这一场暂时没有位置数据'));
  updateHeader(d, wind);
  updateList();
}

function updateHeader(d, wind) {
  const r = S.race || {};
  el('race').textContent = [d.matchName || r.raceName, d.raceName || r.levelName, d.rounds || r.roundName]
    .filter(Boolean).join(' · ') || '比赛';
  const st = d.status === null || d.status === undefined ? null : Number(d.status);
  const pill = el('status');
  if (st === 10) { pill.textContent = '待发'; pill.className = 'pill wait'; }
  else if (st === 99) { pill.textContent = '已结束'; pill.className = 'pill over'; }
  else if (st === undefined || st === null) { pill.textContent = '?'; pill.className = 'pill'; }
  else { pill.textContent = '进行中'; pill.className = 'pill run'; }
  el('clock').textContent = '更新 ' + fmtTime(S.lastMeta) + ' · ' + S.polls + ' 次';
  el('windTxt').textContent = wind
    ? `风 ${wind.from === null ? '—' : wind.from.toFixed(0) + '°'}/` +
      `${wind.spd === null ? '—' : (wind.spd * KNOT).toFixed(1) + ' kn'}`
    : '风 —';
  // 顺带补一下比赛列表里的状态(第一次拉到实时数据就知道了)
  if (S.race && S.race.status !== st) {
    S.race.status = st;
    S.race.state = st === 10 ? 'waiting' : st === 99 ? 'over' : 'running';
  }
}

function updateList() {
  const now = nowMs();
  const boats = [], mks = [];
  for (const dv of S.dev.values()) {
    const age = dv.ts ? (now - dv.ts) / 1000 : null;
    const stale = age !== null && age > 30;
    const spd = dv.spd === null ? '—' : (dv.spd * KNOT).toFixed(1);
    const nm = dv.name.length > 16 ? dv.name.slice(0, 15) + '…' : dv.name;
    const html = `<div class="dot" style="background:${dv.color}"></div>
      <div class="nm" title="${dv.name}">${nm}</div>
      <div class="v">${spd} kn</div>
      <div class="v">${age === null ? '—' : (stale ? fmtTime(dv.ts).slice(0, 5) : Math.round(age) + 's')}</div>`;
    (dv.kind === 'boat' ? boats : mks).push(`<div class="row${stale ? ' stale' : ''}">${html}</div>`);
  }
  el('boats').innerHTML = boats.join('') || '<div class="row"><div></div><div class="nm">没有船</div></div>';
  el('marks').innerHTML = mks.join('') || '<div class="row"><div></div><div class="nm">没有标</div></div>';
}
