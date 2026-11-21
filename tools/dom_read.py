#!/usr/bin/env python3
"""不开网页看,直接读追踪页的 DOM 元素,把船队/标/风的位置还原成经纬度。

用法:
  python3 tools/dom_read.py <raceCd>           # 表格
  python3 tools/dom_read.py <raceCd> --json    # 原始结构(含像素坐标)

原理:页面用 Leaflet 画图,地图上每一件东西都是一个带
`transform: translate3d(Xpx, Ypx)` 的 DOM 节点,船头/风向是内层元素的
`rotate(Ndeg)`。拿这些像素坐标 + URL hash 里的缩放级别和中心点
(`#19/22.78155/113.59755`),用 Web Mercator 反算就是经纬度,实测误差 < 1 米。

需要:python 包 websocket-client,Google Chrome。会自动起一个无头 Chrome
(独立 profile /tmp/chrome-dom,不动他开着的窗口)。
"""
import json
import math
import re
import subprocess
import sys
import time
import urllib.request

import websocket

CD = sys.argv[1] if len(sys.argv) > 1 else "9baa93b239ac4419aa0958e7a8cb7d91"
AS_JSON = "--json" in sys.argv
URL = "https://www.saill.cn/sf-admin/html/race/live/open_trac.html?raceCd=" + CD
PORT = 9222
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

JS_READY = "document.body && /队/.test(document.body.innerText) && document.querySelectorAll('.leaflet-racer-pane > z').length > 0"

JS_READ = r"""(() => {
  const T = e => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const xy = s => { const m = /translate3d\(([-\d.]+)px, ?([-\d.]+)px/.exec(s || ''); return m ? [+m[1], +m[2]] : null; };
  const rot = s => { const m = /rotate\(([-\d.]+)deg\)/.exec(s || ''); return m === null ? null : +m[1]; };
  const rgb = s => { const m = /rgb\(([^)]+)\)/.exec(s || ''); return m ? '#' + m[1].split(',').map(v => (+v).toString(16).padStart(2, '0')).join('') : null; };

  const racers = [];
  let cur = null;
  document.querySelectorAll('.leaflet-racer-pane > *').forEach(e => {
    if (e.tagName === 'N') {
      cur = {name: T(e), flag: (e.querySelector('i') || {}).className || '', px: xy(e.getAttribute('style'))};
      racers.push(cur);
    } else if (e.tagName === 'Z' && cur) {
      const r = e.querySelector('r');
      cur.px = xy(e.getAttribute('style')) || cur.px;
      cur.heading = r ? rot(r.getAttribute('style')) : null;
      cur.color = r ? rgb(r.getAttribute('style')) : null;
    }
  });

  const wind = Array.from(document.querySelectorAll('.leaflet-wind-pane > z')).map(e => {
    const r = e.querySelector('r');
    return {px: xy(e.getAttribute('style')), dir: r ? rot(r.getAttribute('style')) : null,
            color: r ? rgb(r.getAttribute('style')) : null};
  });

  const marks = Array.from(document.querySelectorAll('.leaflet-mark-pane > z')).map((e, i) => {
    const r = e.querySelector('r');
    const t = e.previousElementSibling;
    return {i, icon: r ? r.className.split(' ').pop() : '',
            label: t && t.tagName === 'N' ? T(t) : '',
            px: xy(e.getAttribute('style')), color: r ? rgb(r.getAttribute('style')) : null};
  });

  const c = document.querySelector('.leaflet-container');
  return {title: document.title, now: Date.now(), hash: location.hash,
          size: c ? [c.clientWidth, c.clientHeight] : null, racers, wind, marks,
          screen: document.body.innerText.slice(0, 300)};
})()"""


def chrome_targets():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=3) as f:
            return json.load(f)
    except Exception:
        return None


def ensure_chrome():
    ts = chrome_targets()
    if ts is not None:
        return ts
    subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
                      "--user-data-dir=/tmp/chrome-dom", "--no-first-run",
                      "--disable-gpu", "about:blank"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        time.sleep(0.25)
        ts = chrome_targets()
        if ts is not None:
            return ts
    raise SystemExit("Chrome 没起来")


class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, max_size=None)
        self.ws.settimeout(30)
        self.mid = 0

    def call(self, method, **params):
        self.mid += 1
        fid = self.mid
        self.ws.send(json.dumps({"id": fid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == fid:
                if "error" in msg:
                    raise SystemExit(f"{method} 失败:{msg['error']}")
                return msg.get("result", {})

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True)
        if r.get("exceptionDetails"):
            raise SystemExit("JS 报错:" + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:400])
        return r.get("result", {}).get("value")


# ---- 像素 → 经纬度(Web Mercator) ----

def _world(zoom):
    return 256 * 2 ** zoom


def project(lng, lat, zoom):
    s = _world(zoom)
    x = (lng + 180) / 360 * s
    sy = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + sy) / (1 - sy)) / (4 * math.pi)) * s
    return x, y


def unproject(x, y, zoom):
    s = _world(zoom)
    lng = x / s * 360 - 180
    n = math.pi - 2 * math.pi * y / s
    lat = math.degrees(math.atan(0.5 * (math.exp(n) - math.exp(-n))))
    return lat, lng


def view_from_hash(h, size):
    """从 #19/22.78155/113.59755 拿到 zoom 和中心点。"""
    m = re.search(r"#(\d+(?:\.\d+)?)/([-\d.]+)/([-\d.]+)", h or "")
    if not m:
        raise SystemExit("URL 里没有 #zoom/lat/lng,先让页面加载完")
    zoom, lat, lng = float(m.group(1)), float(m.group(2)), float(m.group(3))
    cx, cy = project(lng, lat, zoom)
    w, hh = size
    ox, oy = cx - w / 2, cy - hh / 2
    return zoom, ox, oy


def to_latlng(px, zoom, ox, oy):
    if not px:
        return None, None
    lat, lng = unproject(ox + px[0], oy + px[1], zoom)
    return round(lat, 7), round(lng, 7)


def main():
    ts = ensure_chrome()
    pages = [t for t in ts if t.get("type") == "page"]
    p = Page(pages[0]["webSocketDebuggerUrl"])
    p.call("Page.enable")
    p.call("Runtime.enable")
    p.call("Page.navigate", url=URL)
    for _ in range(60):
        time.sleep(0.5)
        try:
            if p.js(JS_READY):
                break
        except SystemExit:
            pass
    time.sleep(2.5)

    d = p.js(JS_READ)
    zoom, ox, oy = view_from_hash(d.get("hash"), d.get("size") or [756, 409])
    d["zoom"] = zoom
    for r in d["racers"]:
        r["lat"], r["lng"] = to_latlng(r.get("px"), zoom, ox, oy)
    for w in d["wind"]:
        w["lat"], w["lng"] = to_latlng(w.get("px"), zoom, ox, oy)
    for m in d["marks"]:
        m["lat"], m["lng"] = to_latlng(m.get("px"), zoom, ox, oy)

    if AS_JSON:
        print(json.dumps(d, ensure_ascii=False, indent=1))
        return
    show(d)


def show(d):
    print(d.get("title"), " zoom", d.get("zoom"))
    print("抓的时间", time.strftime("%m-%d %H:%M:%S", time.localtime(d["now"] / 1000)))
    print()
    print(f"{'船队':<14}{'纬度':>12}{'经度':>13}{'航向':>7}  {'颜色'}")
    for r in d["racers"]:
        lat = f"{r['lat']:.7f}" if r.get("lat") else "?"
        lng = f"{r['lng']:.7f}" if r.get("lng") else "?"
        print(f"{r['name']:<14}{lat:>12}{lng:>13}{str(r.get('heading')):>7}  {r.get('color')}")
    print()
    for w in d["wind"]:
        print(f"风向仪 风向角 {w.get('dir')}°  位置 {w.get('lat')},{w.get('lng')}  颜色 {w.get('color')}")
    if d.get("marks"):
        print(f"\n标 {len(d['marks'])} 个(同位置常有红绿两份,是起终点两套图钉)")
        for m in d["marks"]:
            print(f"  {m['icon']:<10}{str(m.get('label')):<8}{m.get('lat')},{m.get('lng')}  {m.get('color')}")


if __name__ == "__main__":
    main()
