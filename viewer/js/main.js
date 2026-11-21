'use strict';
// 启动
/* ---------- 起 ---------- */
resize();
draw();
loadRaces();
setInterval(() => {
  el('clock').textContent = '更新 ' + fmtTime(S.lastMeta) + ' · ' + S.polls + ' 次';
}, 1000);
