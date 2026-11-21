#!/usr/bin/env python3
"""把一整场比赛的轨迹(回放)全抓下来,存成 JSON/CSV。

用法:
  python3 tools/replay.py <raceCd>                # 抓全,存 data/<raceCd>.json,打印概览
  python3 tools/replay.py <raceCd> --at 1795146000000   # 只看某一时刻各船在哪
  python3 tools/replay.py <raceCd> --csv          # 另外导出 data/<raceCd>.csv

三条接口:
  getRace                         比赛元信息(startTime/endTime/matchCd/rounds)
  replay2/getRaceDatas            队伍/标/风/航线(replay2 才有 startTime、endTime)
  replay2/getEncryptionReplayData 轨迹分片,每片 60 秒 —— 关键参数是
                                  asTime=endTime(固定)、timestamp=片起点。
                                  少了 timestamp 会 500「系统异常」。
"""
import csv
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lzstring import decompress_from_base64

BASE = "https://www.saill.cn/sf-admin/api/app-api/match/race"
HDR = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
STEP = 60 * 1000          # 一片 60 秒(=1 分钟 timeSpan)
OUTDIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

# runtime 数组里有用的下标(和页面 JS 里 Nd 的字段号一致,1 起)
I_CD, I_SPD, I_HDG, I_LAT, I_LNG, I_TS = 3, 10, 16, 17, 18, 22


def ts_of(fr):
    """帧里的毫秒时间戳,空值/脏值给 None。"""
    if not fr or len(fr) <= I_TS:
        return None
    try:
        return int(float(fr[I_TS]))
    except (TypeError, ValueError):
        return None


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HDR),
                                        timeout=60) as f:
                return json.loads(f.read())
        except Exception as e:      # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise SystemExit(f"请求失败:{url[:120]} … {last}")


def unpack(o):
    s = o.get("result")
    if isinstance(s, str) and s:
        return json.loads(decompress_from_base64(s))
    return s if isinstance(s, (dict, list)) else None


def meta(cd):
    d = get(f"{BASE}/getRace?pageName=open_trac&raceCd={cd}")["data"]
    g = unpack(get(f"{BASE}/replay2/getRaceDatas?&raceCd={cd}&time={int(time.time() * 1000)}")) or {}
    return d, g


def full_tracks(cd, match_cd, rounds, t0, t1, log=True):
    """从 t0 到 t1 一片一片抓,返回 {teamCd: [frame, ...]}(按时间戳去重排序)。"""
    tracks, seen, done = {}, {}, 0
    t = t0
    while t <= t1:
        url = (f"{BASE}/replay2/getEncryptionReplayData?raceCd={cd}&matchCd={match_cd}"
               f"&rounds={rounds}&replayFlag=1&timeSpan=1&asTime={t1}&timestamp={t}&nonCache=false")
        d = unpack(get(url)) or {}
        for team_cd, frames in d.items():
            bucket = tracks.setdefault(team_cd, [])
            s = seen.setdefault(team_cd, set())
            for fr in frames or []:
                ts = ts_of(fr)
                if ts in s:
                    continue
                s.add(ts)
                bucket.append(fr)
        done += 1
        if log:
            n = sum(len(v) for v in tracks.values())
            print(f"  {time.strftime('%H:%M:%S', time.localtime(t / 1000))}  片 {done}  累计 {n} 帧", flush=True)
        t += STEP
    for v in tracks.values():
        v.sort(key=lambda fr: ts_of(fr) or 0)
    return tracks


def name_map(g):
    m = {}
    for t in g.get("teamList") or []:
        m[t.get("teamCd")] = {"name": t.get("teamName"), "sailNo": t.get("sailNo"),
                              "color": t.get("raceTeamColor")}
    for w in g.get("windInstrumentList") or []:
        m[w.get("windInstrumentCd")] = {"name": w.get("windInstrumentName") or "风力仪",
                                        "sailNo": "", "color": None}
    return m

def summary(doc, path):
    tracks, teams = doc["tracks"], doc["teams"]
    print(f"\n{'队':<24}{'帆号':<8}{'帧数':>6}  时间范围")
    for k, frames in tracks.items():
        nm = (teams.get(k) or {}).get("name") or "(无名)"
        t_a, t_b = (ts_of(frames[0]), ts_of(frames[-1])) if frames else (None, None)
        rng = (f"{time.strftime('%H:%M:%S', time.localtime(t_a / 1000))} → "
               f"{time.strftime('%H:%M:%S', time.localtime(t_b / 1000))}") if t_a and t_b else "-"
        print(f"{nm[:22]:<24}{(teams.get(k) or {}).get('sailNo',''):<8}{len(frames):>6}  {rng}")


def do_at(path, ts):
    d = json.load(open(path, encoding="utf-8"))
    print(f"{d['race']['raceName']} {d['race']['rounds']}  @ {time.strftime('%m-%d %H:%M:%S', time.localtime(ts / 1000))}")
    print(f"{'船队':<24}{'纬度':>12}{'经度':>13}{'航向':>7}")
    for cd, info in d["teams"].items():
        frames = d["tracks"].get(cd) or []
        pick = None
        for fr in frames:
            t = ts_of(fr)
            if t and t <= ts:
                pick = fr
        if not pick:
            continue
        print(f"{(info['name'] or cd)[:22]:<24}{str(pick[I_LAT]):>12}{str(pick[I_LNG]):>13}{str(pick[I_HDG]):>7}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cd = sys.argv[1]
    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, cd + ".json")

    if "--at" in sys.argv and os.path.exists(path):
        do_at(path, int(sys.argv[sys.argv.index("--at") + 1]))
        return

    if os.path.exists(path) and "--refresh" not in sys.argv:
        print(f"已经有 {path},直接用它(--refresh 重新抓)")
        doc = json.load(open(path, encoding="utf-8"))
        summary(doc, path)
        if "--csv" in sys.argv:
            write_csv(doc, cd)
        return

    print("拉比赛资料…")
    info, g = meta(cd)
    t0 = int(g.get("startTime") or info["startTime"])
    t1 = int(g.get("endTime") or info["endTime"])
    print(f"{g.get('matchName')} {g.get('raceName')} {g.get('rounds')}  "
          f"{time.strftime('%m-%d %H:%M:%S', time.localtime(t0 / 1000))} → "
          f"{time.strftime('%H:%M:%S', time.localtime(t1 / 1000))}")

    print("拉轨迹…")
    tracks = full_tracks(cd, info["matchCd"], g.get("rounds") or info["rounds"], t0, t1)

    teams = name_map(g)
    for k in tracks:
        teams.setdefault(k, {"name": None, "sailNo": "", "color": None})

    doc = {
        "source": "saill.cn SF-TrajX",
        "fetched": int(time.time() * 1000),
        "race": {k: info.get(k) for k in ("raceCd", "matchCd", "raceName", "matchName",
                                          "rounds", "startTime", "endTime", "status")},
        "viewConfig": g.get("viewConfig"),
        "teams": teams,
        "marks": {"positions": g.get("markpositions"), "times": g.get("marktimes"),
                  "navigation": g.get("navigationMark")},
        "searoute": g.get("searoute"),
        "tracks": tracks,
        "frameLayout": {"3": "teamCd", "10": "速度(m/s)", "16": "航向(度)",
                        "17": "纬度", "18": "经度", "22": "时间戳(ms)"},
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\n存好了:{path}  ({os.path.getsize(path) / 1024:.0f} KB)")

    summary(doc, path)
    if "--csv" in sys.argv:
        write_csv(doc, cd)


def write_csv(doc, cd):
    cpath = os.path.join(OUTDIR, cd + ".csv")
    tracks, teams = doc["tracks"], doc["teams"]
    with open(cpath, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["teamCd", "teamName", "sailNo", "time_ms", "time", "lat", "lng",
                    "heading", "speed_mps"])
        for k, frames in tracks.items():
            nm = (teams.get(k) or {}).get("name") or ""
            for fr in frames:
                t = ts_of(fr)
                g = lambda i: fr[i] if len(fr) > i else ""      # noqa: E731
                w.writerow([k, nm, (teams.get(k) or {}).get("sailNo", ""), t or "",
                            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t / 1000)) if t else "",
                            g(I_LAT), g(I_LNG), g(I_HDG), g(I_SPD)])
    print(f"\nCSV:{cpath}  ({os.path.getsize(cpath) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
