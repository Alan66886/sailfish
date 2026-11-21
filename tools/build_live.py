#!/usr/bin/env python3
"""把实时页打成单个 html,丢到手机上用浏览器打开,数据仍然从电脑上的 server.py 拿。

  python3 tools/build_live.py                 # 自动认本机局域网 IP
  python3 tools/build_live.py 192.168.x.x    # 指定
  python3 tools/build_live.py --out ~/Desktop/sailfish-live.html

为什么还要服务端:saill.cn 没有 CORS 头,手机浏览器直接连它拿不到数据;
电脑上的 server.py 已经把跨域解开了(返回 Access-Control-Allow-Origin: *),
所以手机上这个文件只跟电脑要 /api/*,电脑再去连赛事网站。
手机和电脑得在同一个 Wi-Fi,而且电脑上那个 server.py 得开着。
"""
import argparse
import json
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from inline import inline_local_scripts   # noqa: E402


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:                              # noqa: BLE001
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ip", nargs="?", default=None, help="电脑在这个 Wi-Fi 里的地址")
    ap.add_argument("--port", default="8899")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "sailfish-live.html"))
    a = ap.parse_args()

    base = f"http://{a.ip or lan_ip()}:{a.port}"
    viewer = os.path.join(ROOT, "viewer")
    html = open(os.path.join(viewer, "index.html"), encoding="utf-8").read()
    head = "<script>window.__API__=" + json.dumps(base) + ";</script>\n"
    html = inline_local_scripts(html, viewer, before_first=head)
    html = html.replace("<title>帆船赛实时图</title>", "<title>帆船赛 · 实时</title>")

    out = os.path.expanduser(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"数据从 {base} 拿")
    print(f"→ {out}  {os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
