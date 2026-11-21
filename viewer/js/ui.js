'use strict';
// 按钮和下拉的接线、水流输入框
el('listBtn').onclick = () => {
  el('list').classList.toggle('open');
  el('ctrls').classList.remove('open');
};
el('cfgBtn').onclick = () => {
  el('ctrls').classList.toggle('open');
  el('list').classList.remove('open');
};
el('follow').onclick = () => {
  S.view.follow = !S.view.follow;
  el('follow').textContent = '自动框住:' + (S.view.follow ? '开' : '关');
};
el('pred').onclick = () => {
  S.showPred = !S.showPred;
  el('pred').textContent = '预判线:' + (S.showPred ? '开' : '关');
};
el('lay').onclick = () => {
  S.showLay = !S.showLay;
  el('lay').textContent = '1标layline:' + (S.showLay ? '开' : '关');
};
el('sel').onchange = e => loadRounds(e.target.value);
el('round').onchange = e => selectRace(e.target.value);
/* ---------- 水流输入 ---------- */
function readCur() {
  const d = num(el('curDir').value);
  const s = num(el('curSpd').value);
  S.cur.dir = d === null ? null : ((d % 360) + 360) % 360;
  S.cur.spd = s === null ? 0 : Math.max(0, s);
  const on = S.cur.dir !== null && S.cur.spd > 0.01;
  el('curTxt').textContent = on
    ? `流 ${S.cur.dir.toFixed(0)}° ${S.cur.spd.toFixed(1)} kn`
    : '流 —';
}
el('curDir').oninput = readCur;
el('curSpd').oninput = readCur;
readCur();
// 链接里也能带水流:?cur=90,1.2(去向度,节)
function curFromQP() {
  const q = new URLSearchParams(location.search).get('cur');
  if (!q) return;
  const [d, s] = q.split(',');
  if (d !== undefined) el('curDir').value = d.trim();
  if (s !== undefined) el('curSpd').value = s.trim();
  readCur();
}
curFromQP();
