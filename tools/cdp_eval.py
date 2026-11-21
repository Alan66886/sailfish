#!/usr/bin/env python3
"""把一个 .js 文件丢进(已开着的)无头 Chrome 里执行,打印结果。

用法: python3 cdp_eval.py <file.js> [端口]
需要: 先用 dom_read.py 或手动起一个带 --remote-debugging-port=9222 的 Chrome。
"""
import json
import sys
import urllib.request

import websocket

PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9222
src = open(sys.argv[1], encoding="utf-8").read()

with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as f:
    ts = [t for t in json.load(f) if t.get("type") == "page"]
if not ts:
    raise SystemExit("没有 page 目标")
ws = websocket.create_connection(ts[0]["webSocketDebuggerUrl"], timeout=30, max_size=None)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                    "params": {"expression": src, "returnByValue": True,
                               "awaitPromise": True}}))
while True:
    msg = json.loads(ws.recv())
    if msg.get("id") != 1:
        continue
    r = msg.get("result", {})
    if r.get("exceptionDetails"):
        print("JS 报错:", json.dumps(r["exceptionDetails"], ensure_ascii=False)[:800])
    print(json.dumps(r.get("result", {}).get("value"), ensure_ascii=False, indent=1))
    break
