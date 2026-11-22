'use strict';
// 启动
/* ---------- 起 ---------- */
resize();
draw();
showScreen('race');
loadRaces();
setInterval(() => {
  el('clock').textContent = '接口拉取 ' + fmtTime(S.lastMeta) + ' · ' + S.polls + ' 次';
  refreshAppReadouts();
}, 1000);
