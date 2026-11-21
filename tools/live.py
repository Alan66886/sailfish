#!/usr/bin/env python3
"""边跑边抓「实时」数据(live2/getRaceDatas),每次轮询记一条快照。

跟 replay.py 的区别:
  - replay2:事后拿整场历史,一片 60 秒,一次请求一片。
  - live2  :只给“这一刻”,没有历史。想要时间序列只能自己轮询、自己攒。

用法:
  python3 tools/live.py <raceCd>                    # 1 秒一次,抓到比赛结束(99)后 2 分钟收工
  python3 tools/live.py <raceCd> --interval 2       # 2 秒一次
  python3 tools/live.py <raceCd> --minutes 40       # 最多抓 40 分钟
  python3 tools/live.py <raceCd> --once             # 只拍一张,打完就退

产出:
  data/live/<raceCd>-<yyyymmdd-HHMM>.jsonl   每秒一条,原样留着
  data/live/<raceCd>-<...>.json              收敛成跟 replay.py 同一套结构,可直接 --at 查
"""
import argparse
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lzstring import decompress_from_base64

BASE = "https://www.saill.cn/sf-admin/api/app-api/match/race"
HDR = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "data", "live")

# runtime 数组里用得上的下标(1 起编号的 protobuf 字段,数组是 0 起)
I_CD, I_NAME, I_SPD, I_HDG, I_LAT, I_LNG, I_TS, I_RX = 3, 3, 10, 16, 17, 18, 22, 23


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=25) as f:
                return json.loads(f.read())
        except Exception as e:            # noqa: BLE001
            last = e
            time.sleep(1.0 * (i + 1))
    raise RuntimeError(f"请求失败 {url[:100]} … {last}")


def unpack(o):
    s = o.get("result")
    return json.loads(decompress_from_base64(s)) if isinstance(s, str) and s else s


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def snap(cd):
    """拍一张:返回 {'t','status','diff','wind','devices'};devices 里含船/标/风。"""
    d = unpack(get(f"{BASE}/live2/getRaceDatas?&raceCd={cd}&time={int(time.time() * 1000)}")) or {}
    out = {"t": int(time.time() * 1000), "status": d.get("status"), "diff": d.get("diff"),
           "readyTime": d.get("readyTime"), "devices": {}}

    def put(key, name, rt, kind):
        if not rt or len(rt) <= I_TS:
            return
        out["devices"][key] = {
            "name": name, "kind": kind,
            "lat": num(rt[I_LAT]), "lng": num(rt[I_LNG]),
            "hdg": num(rt[I_HDG]), "spd": num(rt[I_SPD]),
            "ts": num(rt[I_TS]), "rx": num(rt[I_RX]) if len(rt) > I_RX else None,
            "rt": rt,
        }

    for t in d.get("teamList") or []:
        put(t.get("teamCd"), t.get("teamName"), t.get("runtime"), "boat")
    for m in d.get("navigationMark") or []:
        rt = m.get("runtime") or []
        name = rt[I_NAME] if len(rt) > I_NAME else (m.get("navigationMarkName") or "")
        put(name or m.get("navigationMarkCd"), name, rt, "mark")
    for w in d.get("windInstrumentList") or []:
        rt = w.get("runtime") or []
        put("wind", w.get("windInstrumentCd"), rt, "wind")
        out["wind"] = {"hdg": num(rt[I_HDG]) if len(rt) > I_HDG else None,
                       "spd": num(rt[I_SPD]) if len(rt) > I_SPD else None,
                       "ts": num(rt[I_TS]) if len(rt) > I_TS else None}
    out["meta"] = {k: d.get(k) for k in ("raceName", "matchName", "rounds", "matchCd", "levelCd",
                                         "status", "markpositions", "marktimes", "stomp", "nio")}
    return out


def to_doc(records, cd, meta):
    """把一堆快照收敛成 replay.py 的结构:tracks = {key: [frame,...]},frame 直接用 runtime 数组。"""
    tracks, teams = {}, {}
    for r in records:
        for key, dv in r["devices"].items():
            ts = dv["ts"]
            if not ts:
                continue
            bucket = tracks.setdefault(key, [])
            if bucket and bucket[-1][I_TS] and float(bucket[-1][I_TS]) >= ts:
                bucket[-1] = dv["rt"]          # 同一个时间戳只留最新一次
            else:
                bucket.append(dv["rt"])
            teams[key] = {"name": dv["name"], "sailNo": "", "kind": dv["kind"]}
    return {"raceCd": cd, "meta": meta, "teams": teams, "tracks": tracks,
            "marks": {"positions": (meta.get("markpositions") or []),
                      "times": (meta.get("marktimes") or [])},
            "searoute": meta.get("searoute")}


def fmt(t):
    return time.strftime("%H:%M:%S", time.localtime(t / 1000)) if t else "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raceCd")
    ap.add_argument("--interval", type=float, default=1.0, help="轮询间隔秒,默认 1")
    ap.add_argument("--minutes", type=float, default=90, help="最多抓多久,默认 90 分钟")
    ap.add_argument("--once", action="store_true", help="只拍一张")
    ap.add_argument("--tail", type=int, default=14, help="收工时打印多少条船")
    args = ap.parse_args()
    cd = args.raceCd

    if args.once:
        s = snap(cd)
        print(f"status={s['status']}  diff={s['diff']}  风力 "
              f"{s['wind']['hdg']}° {s['wind']['spd']} m/s  设备 {len(s['devices'])}")
        for k, dv in s["devices"].items():
            print(f"  {dv['kind']:<5}{dv['name'][:22]:<24}{dv['lat']} {dv['lng']} "
                  f"hdg {dv['hdg']} spd {dv['spd']} @ {fmt(dv['ts'])}")
        return

    stamp = time.strftime("%Y%m%d-%H%M", time.localtime())
    os.makedirs(OUTDIR, exist_ok=True)
    jl = os.path.join(OUTDIR, f"{cd}-{stamp}.jsonl")
    print(f"抓取中 → {jl}", flush=True)

    records, last_status, over_since, polls = [], None, None, 0
    t_end = time.time() + args.minutes * 60
    try:
        while time.time() < t_end:
            t0 = time.time()
            try:
                s = snap(cd)
            except Exception as e:                       # noqa: BLE001
                print("  轮询失败:", e, flush=True)
                time.sleep(args.interval)
                continue
            records.append(s)
            polls += 1
            with open(jl, "a", encoding="utf-8") as f:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
            w = s["wind"]
            moving = sum(1 for d in s["devices"].values() if d["kind"] == "boat" and (d["spd"] or 0) > 0.5)
            print(f"  {time.strftime('%H:%M:%S')}  status {s['status']}  diff {s['diff']}  "
                  f"风 {w['hdg']}°/{w['spd']}  在跑的船 {moving}  第 {polls} 次", flush=True)
            if s["status"] == 99:
                over_since = over_since or time.time()
                if time.time() - over_since > 120:
                    print("  比赛结束两分钟了,收工", flush=True)
                    break
            else:
                over_since = None
            time.sleep(max(0.0, args.interval - (time.time() - t0)))
    except KeyboardInterrupt:
        print("\n手动停下", flush=True)

    doc = to_doc(records, cd, records[-1]["meta"] if records else {})
    path = jl.replace(".jsonl", ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    print(f"\n快照 {len(records)} 条 → {jl}")
    print(f"收敛后 → {path}  ({os.path.getsize(path) / 1024:.0f} KB)")
    for k, frames in list(doc["tracks"].items())[:args.tail]:
        nm = (doc["teams"].get(k) or {}).get("name") or k
        if not frames:
            continue
        a, b = num(frames[0][I_TS]), num(frames[-1][I_TS])
        print(f"  {nm[:22]:<24}{len(frames):>6} 帧  {fmt(a)} → {fmt(b)}")


if __name__ == "__main__":
    main()
