#!/usr/bin/env python3
"""把网页版打成一个单文件 HTML,离线也能看回放。

  python3 tools/build_static.py                # 3 秒抽样,输出 dist/sailfish-offline.html
  python3 tools/build_static.py --step 2       # 抽密一点(文件更大)

为什么是单文件:安卓上从本地打开是 file://,Chrome 不许 file:// 页面 fetch 别的文件,
所以数据和脚本都得塞进同一个 HTML 里(script 标签可以)。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "viewer"))
import server as srv                                   # noqa: E402  (只是借它的 replay())

DATA = os.path.join(ROOT, "data")
OUT_DIR = os.path.join(ROOT, "dist")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=float, default=3.0, help="抽样间隔(秒),默认 3")
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "sailfish-offline.html"))
    a = ap.parse_args()

    cds = sorted(fn[:-5] for fn in os.listdir(DATA)
                 if fn.endswith(".json") and not fn.startswith("_"))
    if not cds:
        raise SystemExit("data/ 里没有抓下来的比赛")

    replays, by_cd = [], {}
    for cd in cds:
        try:
            d = srv.replay(cd, a.step)
        except Exception as e:                          # noqa: BLE001
            print(f"  跳过 {cd[:8]}: {e}")
            continue
        if not d["devices"]:
            print(f"  跳过 {cd[:8]}: 没有轨迹")
            continue
        by_cd[cd] = d
        size_mb = round(len(json.dumps(d, separators=(",", ":"))) / 1e6, 2)
        replays.append({"raceCd": cd, "race": d["race"], "sizeMB": size_mb})
        mins = round((d["t1"] - d["t0"]) / 60000) if d["t0"] and d["t1"] else 0
        print(f"  {cd[:8]}  {d['race'].get('raceName', '?')} {d['race'].get('rounds', '')}"
              f"  {len(d['devices'])} 个设备  {mins} 分钟  {size_mb}MB")

    replays.sort(key=lambda r: int(r["race"].get("startTime") or 0))
    payload = json.dumps({"replays": replays, "byCd": by_cd},
                         ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("</", "<\\/")            # 别让字符串里的 </script> 提前收尾

    html = open(os.path.join(ROOT, "viewer", "index.html"), encoding="utf-8").read()
    app = open(os.path.join(ROOT, "viewer", "app.js"), encoding="utf-8").read()
    assert "</script" not in app, "app.js 里有 </script,得先处理"
    html = html.replace(
        '<script src="app.js"></script>',
        "<script>window.__STATIC__=" + payload + ";</script>\n<script>\n" + app + "\n</script>",
    )
    html = html.replace("<title>帆船赛实时图</title>", "<title>帆船赛 · 离线回放</title>")

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"→ {a.out}  {os.path.getsize(a.out) / 1e6:.1f} MB  ({len(replays)} 场)")


if __name__ == "__main__":
    main()
