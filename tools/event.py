#!/usr/bin/env python3
"""赛事 → 组别 → 场次 一览(走的不是 app-api,是给网页/小程序用的 sf-front-api)。

用法:
  python3 tools/event.py <eventCd>          # 列出组别和各组当前场次
  python3 tools/event.py <eventCd> --races  # 再把每组的全部场次列出来(R1..Rn + 状态)

拿到 raceCd 就能喂给 replay.py(已比完)或 live.py(还没比 / 正在比)。

三个接口(都是 POST,body 随便给个 {}):

  POST /sf-front-api/api/event/info/<eventCd>    赛事本身
  POST /sf-front-api/api/event/level/<eventCd>   组别 + 每组「当前」那一场(含 traceUrl)
  POST /sf-front-api/api/level/race/<levelCd>    该组所有场次
  POST /sf-front-api/api/level/score/<levelCd>   该组成绩(尚未验证字段)

页面上「状态」有两套编号,别弄混:
  front-api 的 race.status : 1 = 还没比, 4 = 比完了
  app-api  的 race.status : 10 = 还没比(待发), 99 = 比完
"""
import json
import sys
import urllib.request

FRONT = "https://www.saill.cn/sf-front-api/api"
HDR = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}


def post(path, payload=None):
    req = urllib.request.Request(FRONT + path, data=json.dumps(payload or {}).encode(),
                                 headers=HDR, method="POST")
    with urllib.request.urlopen(req, timeout=25) as f:
        return json.loads(f.read()).get("result")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    ev = sys.argv[1]
    info = post(f"/event/info/{ev}") or {}
    print(f"{info.get('name')}  {info.get('address')}  "
          f"{info.get('beginDate')}→{info.get('endDate')}")
    levels = post(f"/event/level/{ev}") or []
    for lv in levels:
        r = lv.get("race") or {}
        print(f"\n[{lv.get('levelName')}]  levelCd={lv.get('levelCd')}  "
              f"{lv.get('teamTotal')} 队 / {lv.get('roundTotal')} 轮")
        if r:
            print(f"   当前: {r.get('roundName')}  status={r.get('status')}  "
                  f"raceCd={r.get('raceCd')}  航线 {r.get('raceMark')}")
            if r.get("traceUrl"):
                print(f"   {r['traceUrl']}")
        if "--races" in sys.argv:
            for x in post(f"/level/race/{lv.get('levelCd')}") or []:
                print(f"     {x.get('roundName')}  status={x.get('status')}  "
                      f"teams={x.get('teamTotal')}  rc={x.get('raceCd')}")


if __name__ == "__main__":
    main()
