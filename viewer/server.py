#!/usr/bin/env python3
"""本地小服务:把「赛事零距离」的实时数据转出来给前端用,顺手绕开跨域。

  python3 viewer/server.py           # http://127.0.0.1:8899/
  python3 viewer/server.py 9000      # 换端口

赛事接口只读；AI分析仅在用户手动提交时调用外部模型:
  GET /                      前端页面
  GET /app.js
  GET /api/races[?eventCd=]  赛事各组当前那一场(标出哪个在跑 / 哪个待发)
  GET /api/rounds?levelCd=   这一组的全部场次 R1..Rn(页面上切轮次用)
  GET /api/snap?raceCd=      一次 live2 快照,已解压成普通 JSON
  GET /api/replays           本地 data/ 里已经抓下来的比赛(赛后回放用)
  GET /api/replay?raceCd=&step=  一整场抽样后的轨迹(默认 3 秒一帧),给前端拖动时间轴
  GET /api/health
  GET /api/coach/status       AI配置状态与同源会话令牌
  POST /api/coach/analyze     仅提交匿名聚合统计,需要同源会话令牌
"""
import json
import os
import re
import secrets
import socket
import sys
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
from lzstring import decompress_from_base64      # noqa: E402
from ai_coach import CoachError, CoachService, REQUEST_LIMIT, parse_request  # noqa: E402

RACE_API = "https://www.saill.cn/sf-admin/api/app-api/match/race"
FRONT_API = "https://www.saill.cn/sf-front-api/api"
HDR = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
DEFAULT_EVENT = "scf1fea990ea3649999c6686076b54286b"   # 2026 第八届粤港澳大湾区帆船赛
DATA = os.path.join(os.path.dirname(HERE), "data")
FL = {10: "spd", 16: "hdg", 17: "lat", 18: "lng", 22: "ts"}
COACH = CoachService()


def http_json(url, payload=None, timeout=15):
    data = None
    headers = dict(HDR)
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return json.loads(f.read())


def unpack(o):
    s = (o or {}).get("result")
    if isinstance(s, str) and s:
        return json.loads(decompress_from_base64(s))
    return s if isinstance(s, (dict, list)) else {}


def live_snap(cd):
    return unpack(http_json(f"{RACE_API}/live2/getRaceDatas?&raceCd={cd}"
                            f"&time={int(time.time() * 1000)}", timeout=20))


def races(event_cd):
    """赛事里每一组「当前那一场」,外加它的实时状态。"""
    out = []
    resp = http_json(f"{FRONT_API}/event/level/{event_cd}", {})
    levels = (resp or {}).get("result") if isinstance(resp, dict) else resp
    for lv in levels or []:
        r = lv.get("race") or {}
        if not r.get("raceCd"):
            continue
        item = {"levelName": lv.get("levelName"), "levelCd": lv.get("levelCd"),
                "roundName": r.get("roundName"), "raceCd": r.get("raceCd"),
                "frontStatus": r.get("status"), "raceMark": r.get("raceMark"),
                "traceUrl": r.get("traceUrl"), "status": None,
                "startTime": None, "endTime": None, "state": "unknown"}
        try:
            info = (http_json(f"{RACE_API}/getRace?pageName=open_trac"
                              f"&raceCd={r['raceCd']}") or {}).get("data") or {}
            item["status"] = int(info.get("status")) if str(info.get("status", "")).lstrip("-").isdigit() else None
            item["startTime"] = info.get("startTime")
            item["endTime"] = info.get("endTime")
            item["raceName"] = info.get("raceName")
            st = item["status"]
            item["state"] = ("waiting" if st == 10 else "over" if st == 99 else
                             "running" if st is not None else "unknown")
        except Exception as e:                     # noqa: BLE001
            item["error"] = str(e)
        out.append(item)
    order = {"running": 0, "waiting": 1, "unknown": 2, "over": 3}
    out.sort(key=lambda x: order.get(x["state"], 9))
    return out


def rounds(level_cd):
    """这一组的全部场次(R1..Rn),给页面上切轮次用。"""
    resp = http_json(f"{FRONT_API}/level/race/{level_cd}", {})
    arr = (resp or {}).get("result") if isinstance(resp, dict) else resp
    out = []
    for r in arr or []:
        cd = r.get("raceCd")
        if not cd:
            continue
        out.append({"roundName": r.get("roundName"), "raceCd": cd,
                    "frontStatus": r.get("status"), "raceMark": r.get("raceMark"),
                    "startTime": r.get("startTime"), "endTime": r.get("endTime"),
                    "traceUrl": r.get("traceUrl")})
    out.sort(key=lambda x: (1, 0) if not x["startTime"] else (0, int(x["startTime"])))
    return out


def replay_files():
    """data/ 下抓下来的每一场:只读文件头拿 race 元信息,不整份解析。"""
    out = []
    if not os.path.isdir(DATA):
        return out
    for fn in sorted(os.listdir(DATA)):
        if not fn.endswith(".json") or fn.startswith("_"):
            continue
        path = os.path.join(DATA, fn)
        try:
            with open(path, "rb") as f:
                head = f.read(65536).decode("utf-8", "replace")
            i = head.find('"race"')
            race = {}
            if i >= 0:
                j = head.find("{", i)
                race, _ = json.JSONDecoder().raw_decode(head[j:])
        except Exception:                          # noqa: BLE001
            race = {}
        out.append({"raceCd": fn[:-5], "race": race,
                    "sizeMB": round(os.path.getsize(path) / 1e6, 1)})
    out.sort(key=lambda x: int(x["race"].get("startTime") or 0))
    return out


def _f(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def replay(cd, step_s=3.0):
    """整场抽样成 [ts, lat, lng, hdg, spd](风是 [ts, dir, spd])。"""
    path = os.path.join(DATA, cd + ".json")
    if not os.path.exists(path):
        raise FileNotFoundError(cd)
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    step = max(0.5, float(step_s)) * 1000
    teams = d.get("teams") or {}
    race = d.get("race") or {}
    devs, t0, t1 = [], None, None
    for key, frames in (d.get("tracks") or {}).items():
        meta = teams.get(key) or {}
        name = meta.get("name") or key
        if "风力仪" in str(name):
            kind = "wind"
        elif key in teams and meta.get("sailNo"):
            kind = "boat"
        else:
            kind = "mark"
        out, last = [], None
        for fr in frames:
            ts = _f(fr[22]) if len(fr) > 22 else None
            if not ts:
                continue
            if last is not None and ts - last < step:
                continue
            if kind == "wind":
                row = [int(ts), _f(fr[16]), _f(fr[10])]
            else:
                lat, lng = _f(fr[17]), _f(fr[18])
                if lat is None or lng is None:
                    continue
                row = [int(ts), round(lat, 7), round(lng, 7),
                       _f(fr[16]), _f(fr[10])]
            last = ts
            out.append(row)
            t0 = ts if t0 is None else min(t0, ts)
            t1 = ts if t1 is None else max(t1, ts)
        if out:
            devs.append({"key": key, "name": str(name), "kind": kind,
                         "color": meta.get("color"),
                         "sailNo": meta.get("sailNo"), "frames": out})
    # 中心点:有赛会给的就用,没有就取第一艘船的第一帧
    center = None
    for dv in devs:
        if dv["kind"] == "boat" and dv["frames"]:
            f = dv["frames"][0]
            center = {"lat": f[1], "lng": f[2]}
            break
    return {"raceCd": cd, "race": race, "stepMs": step, "t0": t0, "t1": t1,
            "center": center, "devices": devs}


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, obj, code=200, cors=True):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")   # 手机上的单文件 html 要跨过来拿赛事数据
        else:
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _coach_access(self, require_origin=False):
        # 限定当前本机地址，避免第三方域名重绑定到本地后读取会话令牌。
        if len(self.headers.get_all("Host", [])) != 1 or len(self.headers.get_all("Origin", [])) > 1:
            raise CoachError("AI分析只接受当前页面的同源请求。", 403)
        try:
            host = urlparse("http://" + self.headers["Host"])
            local_address, local_port = self.connection.getsockname()[:2]
            local_hosts = {local_address.lower()}
            if local_address.startswith("127.") or local_address == "::1":
                local_hosts.add("localhost")
            if (host.hostname not in local_hosts or (host.port or 80) != local_port
                    or host.username or host.password or host.path or host.query or host.fragment):
                raise ValueError("invalid host")
            origin_value = self.headers.get("Origin")
            if require_origin and not origin_value:
                raise ValueError("missing origin")
            if origin_value:
                origin = urlparse(origin_value)
                if (origin.scheme != "http" or origin.hostname != host.hostname
                        or (origin.port or 80) != (host.port or 80)
                        or origin.username or origin.password or origin.path or origin.query or origin.fragment):
                    raise ValueError("different origin")
        except (ValueError, AttributeError):
            raise CoachError("AI分析只接受当前页面的同源请求。", 403) from None
        if self.headers.get("Sec-Fetch-Site", "").lower() not in ("", "same-origin", "none"):
            raise CoachError("AI分析不接受跨站请求。", 403)
        if self.headers.get("Sec-Fetch-Mode", "").lower() == "no-cors":
            raise CoachError("AI分析不接受跨站请求。", 403)

    def _coach_status(self):
        try:
            self._coach_access()
            return self._json(COACH.status(), cors=False)
        except CoachError as e:
            return self._json({"error": str(e)}, e.status, cors=False)

    def do_POST(self):
        if urlparse(self.path).path != "/api/coach/analyze":
            return self._json({"error": "不支持这个接口。"}, 404, cors=False)
        try:
            self._coach_access(require_origin=True)
            tokens = self.headers.get_all("X-Coach-Token", [])
            if len(tokens) != 1 or not secrets.compare_digest(tokens[0], COACH.token):
                raise CoachError("会话已失效，请刷新当前页面。", 403)
            if not COACH.status()["configured"]:
                raise CoachError("服务端尚未配置AI凭证和模型。", 503)
            if (self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    != "application/json"):
                raise CoachError("请提交JSON格式的匿名统计。", 415)
            sizes = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(sizes) != 1 or not sizes[0].isdigit():
                raise CoachError("请求需要有效的内容长度。", 411)
            length = int(sizes[0])
            if length > REQUEST_LIMIT:
                raise CoachError("摘要请求不能超过32KB。", 413)
            previous_timeout = self.connection.gettimeout()
            try:
                self.connection.settimeout(5)
                raw = self.rfile.read(length)
            except (TimeoutError, OSError):
                raise CoachError("读取摘要超时，请重试。", 408) from None
            finally:
                self.connection.settimeout(previous_timeout)
            if len(raw) != length:
                raise CoachError("摘要请求不完整。")
            result = COACH.analyze(parse_request(raw))
            return self._json(result, cors=False)
        except CoachError as e:
            return self._json({"error": str(e)}, e.status, cors=False)
        except Exception:
            # 不能把供应商响应、凭证或用户摘要拼进错误或日志。
            return self._json({"error": "分析暂时无法完成，请稍后重试。"}, 502, cors=False)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/coach/status":
            return self._coach_status()
        if u.path.startswith("/api/coach/"):
            return self._json({"error": "不支持这个接口或请求方式。"}, 405, cors=False)
        try:
            if u.path == "/api/health":
                return self._json({"ok": True, "t": int(time.time() * 1000)})
            if u.path == "/api/races":
                return self._json(races(q.get("eventCd", [DEFAULT_EVENT])[0]))
            if u.path == "/api/rounds":
                lv = q.get("levelCd", [""])[0]
                if not lv:
                    return self._json({"error": "需要 levelCd"}, 400)
                return self._json(rounds(lv))
            if u.path == "/api/snap":
                cd = q.get("raceCd", [""])[0]
                if not cd:
                    return self._json({"error": "需要 raceCd"}, 400)
                d = live_snap(cd)
                return self._json({"t": int(time.time() * 1000), "data": d})
            if u.path == "/api/replays":
                return self._json(replay_files())
            if u.path == "/api/replay":
                cd = q.get("raceCd", [""])[0]
                if not cd:
                    return self._json({"error": "需要 raceCd"}, 400)
                step = float(q.get("step", ["3"])[0] or 3)
                return self._json(replay(cd, step))
        except Exception as e:                     # noqa: BLE001
            return self._json({"error": str(e)}, 502)
        if u.path == "/":
            self.path = "/index.html"
        return super().do_GET()


def lan_ips():
    """这台机器在局域网里的地址,手机要用它访问。"""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # 不真发包,只为拿到出口网卡的地址
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:                       # noqa: BLE001
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:                       # noqa: BLE001
        pass
    return ips


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"   # 默认整台机器都能访问
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"→ 本机   http://127.0.0.1:{port}/", flush=True)
    if host in ("0.0.0.0", ""):
        for ip in lan_ips():
            print(f"→ 手机   http://{ip}:{port}/    (跟电脑连同一个 Wi-Fi)", flush=True)
    print("   (Ctrl-C 停)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n停了")


if __name__ == "__main__":
    main()
