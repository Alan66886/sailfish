#!/usr/bin/env python3
"""打一个「手机自己跑」的单文件实时页:不依赖电脑、不依赖那个本地小服务。

  python3 tools/build_standalone.py                       # → dist/sailfish-phone.html
  python3 tools/build_standalone.py --out ~/Desktop/sailfish.html
  python3 tools/build_standalone.py --event <赛事Cd>      # 换赛事(默认大湾区帆船赛)

原理:saill.cn 的接口 CORS 是放开的(live2 回 `*`,sf-front-api 回显 Origin,
连 `Origin: null` 也就是 file:// 都回 `null`),所以手机浏览器直接连它就行。
页面里的 app.js 看到 `window.__DIRECT__` 就不问本地服务,自己去拉、
自己解 lz-string。手机要能上网(Wi-Fi 或流量都行),电脑可以关掉。

注意:这些跨域放开是对方服务器现在的样子,哪天他们收紧了,这个包就会拉不到数据。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from inline import inline_local_scripts   # noqa: E402
DEFAULT_EVENT = "scf1fea990ea3649999c6686076b54286b"     # 2026 第八届粤港澳大湾区帆船赛


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", default=DEFAULT_EVENT)
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "sailfish-phone.html"))
    a = ap.parse_args()

    viewer = os.path.join(ROOT, "viewer")
    html = open(os.path.join(viewer, "index.html"), encoding="utf-8").read()
    head = ("<script>window.__DIRECT__=true;window.__EVENT__="
            + json.dumps(a.event) + ";</script>\n")
    html = inline_local_scripts(html, viewer, before_first=head)
    html = html.replace("<title>帆船赛实时图</title>", "<title>帆船赛 · 实时</title>")

    out = os.path.expanduser(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"→ {out}  {os.path.getsize(out) / 1024:.0f} KB  (直连 saill.cn,不需要服务器)")


if __name__ == "__main__":
    main()
