#!/usr/bin/env python3
"""SAILFISH(赛事零距离 / saill.cn)实时数据读取。

用法:
  python3 sailfish.py <raceCd>          # 打印船队位置、风况
  python3 sailfish.py <raceCd> --json   # 打原始解码后的 JSON

数据源(不用登录):
  https://www.saill.cn/sf-admin/api/app-api/match/race/live2/getRaceDatas?&raceCd=<cd>&time=<ms>
返回 {"result": "<lz-string>", "flag":1, ...},result 解压后是 JSON。
比赛结束后同一接口换 `replay2/` 路径。

runtime 数组是 protobuf 逐字段手解的(1 起编号),用到的那几个:
  [16] 航向/风向(度)   [17] 纬度   [18] 经度   [19] 速度   [22..23] 时间戳(ms)
"""
import json
import sys
import time
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lzstring import decompress_from_base64

BASE = "https://www.saill.cn/sf-admin/api/app-api/match/race"


def fetch(race_cd, live="live2"):
    url = f"{BASE}/{live}/getRaceDatas?&raceCd={race_cd}&time={int(time.time() * 1000)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json",
                                              "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as f:
        o = json.loads(f.read())
    if not o.get("result"):
        raise SystemExit(f"接口没给数据:{o}")
    return json.loads(decompress_from_base64(o["result"]))


def race_info(race_cd):
    url = f"{BASE}/getRace?pageName=open_trac&raceCd={race_cd}"
    with urllib.request.urlopen(url, timeout=20) as f:
        return json.loads(f.read())["data"]


def fmt_ts(ms):
    try:
        return time.strftime("%m-%d %H:%M:%S", time.localtime(int(ms) / 1000))
    except Exception:
        return str(ms)


def show(d):
    print(f"{d.get('matchName') or ''} {d.get('raceName')} {d.get('rounds')}  status={d.get('status')}")
    print(f"中心点 {d.get('centerLat')}, {d.get('centerLng')}")
    print()
    print(f"{'船队':<20}{'帆号':<9}{'纬度':>12}{'经度':>12}{'航向':>7}")
    for t in d.get("teamList") or []:
        r = t.get("runtime") or []
        g = lambda i: r[i] if len(r) > i else ""
        print(f"{t.get('teamName',''):<20}{t.get('sailNo',''):<9}"
              f"{str(g(17)):>12}{str(g(18)):>12}{str(g(16)):>7}")
    print()
    for w in d.get("windInstrumentList") or []:
        r = w.get("runtime") or []
        g = lambda i: r[i] if len(r) > i else ""
        print(f"风:{w.get('windInstrumentName')} 风向 {g(16)}° 风速 {g(10)} "
              f"位置 {g(17)},{g(18)} 更新 {fmt_ts(g(23))}")
    mp = d.get("markpositions") or []
    if mp:
        print(f"\n标 {len(mp)} 个")
        for m in mp[:20]:
            print(" ", json.dumps(m, ensure_ascii=False)[:160])


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cd = sys.argv[1]
    d = fetch(cd)
    if "--json" in sys.argv:
        print(json.dumps(d, ensure_ascii=False, indent=1))
    else:
        show(d)


if __name__ == "__main__":
    main()
