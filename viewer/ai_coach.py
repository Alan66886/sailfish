"""只把白名单匿名统计发送给模型；凭证和调用预算始终留在服务端。"""
import json
import math
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

REQUEST_LIMIT = 32 * 1024
RESPONSE_LIMIT = 128 * 1024
PROVIDER_TIMEOUT = 30
OUTPUT_LIMIT = 2000
COOLDOWN_SECONDS = 30
HOURLY_LIMIT = 20
ENDPOINT = "https://api.openai.com/v1/responses"

INSTRUCTIONS = """你是帆船赛统计解读助手，所有输出用中文。
仅根据用户手动录制、手动提交的匿名聚合统计给参考，这不是自动实时导航。
scope可能是首个迎风段、第一圈或首场比赛；整圈和整场统计也只提取朝1标轴的可比迎风片段，
不能声称比较了顺风段或全部赛道。只能给后续同方向迎风航段的观察建议，不能导航方向已改变的当前航段。
过去的相关关系不代表因果，也不保证未来优势。
不得编造风、流、船员操作或任何输入没有的测量。wind为空或样本不足时明确未知；
即便有风向变化，也不能断言它导致了某侧更快。这里没有水流测量。
只能解释comparison.favored：left或right表示本次配对统计的方向；even表示没有明显优势，
insufficient表示证据不足，绝不能把这两者改写成某侧有利。confidence不是胜率。
evidence只能引用输入中的数值及其限制，不得虚构原始航迹、船名、位置或额外事实。
next_leg_plan是可复核的观察和尝试建议，不给具体舵角、保证秒数、抢航结论或保证提速。
recheck_conditions说明风、航线或采样条件变化时应重新观察，不宣称已发生了这些变化。
summary必须明确这是匿名聚合统计参考。严格按指定JSON结构输出，不要Markdown。
"""

OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "summary": {"type": "string", "minLength": 1, "maxLength": 600},
        **{key: {"type": "array", "minItems": 1, "maxItems": 6,
                 "items": {"type": "string", "minLength": 1, "maxLength": 300}}
           for key in ("evidence", "next_leg_plan", "recheck_conditions")},
    },
    "required": ["summary", "evidence", "next_leg_plan", "recheck_conditions"],
}


class CoachError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def configuration():
    token = os.environ.get("SAILFISH_AI_TOKEN", "").strip()
    model = os.environ.get("SAILFISH_AI_MODEL", "").strip()
    valid = bool(token and "\n" not in token and "\r" not in token
                 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", model))
    return (token, model) if valid else (None, None)


def _record(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise CoachError("摘要结构不符合要求，只接受匿名聚合统计。")


def _number(value, low, high, nullable=False, integer=False):
    if nullable and value is None:
        return
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not low <= value <= high or not math.isfinite(value)
            or (integer and not isinstance(value, int))):
        raise CoachError("摘要包含无效或超出范围的统计值。")


def _choice(value, choices):
    if not isinstance(value, str) or value not in choices:
        raise CoachError("摘要包含不支持的统计类别。")


def validate_summary(summary):
    _record(summary, ("version", "scope", "duration_s", "course_length_m", "boat_count",
                      "sample_count", "paired_windows", "paired_groups", "left", "right",
                      "comparison", "wind", "own", "quality"))
    _number(summary["version"], 1, 1, integer=True)
    _choice(summary["scope"], ("first_upwind_leg", "first_lap", "first_race"))
    for key, high in (("duration_s", 5400), ("course_length_m", 20000)):
        _number(summary[key], 100 if key == "course_length_m" else 0, high)
    for key, high in (("boat_count", 80), ("sample_count", 100000),
                      ("paired_windows", 181), ("paired_groups", 1000)):
        _number(summary[key], 0, high, integer=True)
    for side in ("left", "right"):
        values = summary[side]
        _record(values, ("boat_count", "window_count", "median_progress_kn"))
        _number(values["boat_count"], 0, 80, integer=True)
        _number(values["window_count"], 0, 100000, integer=True)
        _number(values["median_progress_kn"], -100, 100, nullable=True)
    comparison = summary["comparison"]
    _record(comparison, ("favored", "median_delta_kn", "left_win_share", "confidence"))
    _choice(comparison["favored"], ("left", "right", "even", "insufficient"))
    _choice(comparison["confidence"], ("low", "moderate", "insufficient"))
    _number(comparison["median_delta_kn"], -200, 200, nullable=True)
    _number(comparison["left_win_share"], 0, 1, nullable=True)
    wind = summary["wind"]
    _record(wind, ("sample_count", "shift_deg", "first_from_deg", "last_from_deg", "median_speed_kn"))
    _number(wind["sample_count"], 0, 100000, integer=True)
    _number(wind["shift_deg"], -180, 180, nullable=True)
    for key in ("first_from_deg", "last_from_deg"):
        _number(wind[key], 0, 360, nullable=True)
        if wind[key] == 360:
            raise CoachError("风向须在0度至360度以内。")
    _number(wind["median_speed_kn"], 0, 200, nullable=True)
    own = summary["own"]
    _record(own, ("window_count", "median_progress_kn", "left_share"))
    _number(own["window_count"], 0, 100000, integer=True)
    _number(own["median_progress_kn"], -100, 100, nullable=True)
    _number(own["left_share"], 0, 1, nullable=True)
    quality = summary["quality"]
    _record(quality, ("coverage_ratio", "rejected_samples", "gap_count", "geometry_changed"))
    _number(quality["coverage_ratio"], 0, 1)
    for key in ("rejected_samples", "gap_count"):
        _number(quality[key], 0, 100000, integer=True)
    if not isinstance(quality["geometry_changed"], bool):
        raise CoachError("摘要包含无效的航线变化标记。")
    if (comparison["favored"] == "insufficient" or comparison["confidence"] == "insufficient"
            or quality["geometry_changed"] or summary["sample_count"] == 0
            or summary["paired_windows"] < 3
            or summary["paired_groups"] < summary["paired_windows"]
            or any(not 2 <= summary[side]["boat_count"] <= summary["boat_count"]
                   for side in ("left", "right"))
            or comparison["median_delta_kn"] is None
            or comparison["left_win_share"] is None):
        raise CoachError("配对统计证据不足，请先完成有效航段记录。", 422)
    # 本地统计保留两位小数；容许阈值附近半个末位的舍入误差。
    epsilon = 0.005
    favored, delta = comparison["favored"], comparison["median_delta_kn"]
    if ((favored == "left" and delta < 0.3 - epsilon)
            or (favored == "right" and delta > -0.3 + epsilon)
            or (favored == "even" and abs(delta) > 0.3 + epsilon)):
        raise CoachError("选边结论与统计差值不一致，请重新生成摘要。", 422)
    if comparison["confidence"] == "moderate":
        left_share = comparison["left_win_share"]
        # 未传平局数量时，右侧只能核对左赢占比的必要上限，不推导真实右赢占比。
        share_ok = ((favored == "left" and left_share >= 2 / 3 - epsilon)
                    or (favored == "right" and left_share <= 1 / 3 + epsilon))
        if (summary["paired_windows"] < 6 or not share_ok
                or any(summary[side]["boat_count"] < 3 for side in ("left", "right"))):
            raise CoachError("置信度与配对窗口、船数或胜出占比不一致。", 422)
    return summary


def _strict_json(raw):
    def invalid_constant(_):
        raise ValueError("invalid numeric constant")
    return json.loads(raw, parse_constant=invalid_constant)


def parse_request(raw):
    if len(raw) > REQUEST_LIMIT:
        raise CoachError("摘要请求不能超过32KB。", 413)
    try:
        payload = _strict_json(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise CoachError("请求必须是有效JSON摘要。") from None
    _record(payload, ("summary",))
    return validate_summary(payload["summary"])


def _analysis_from_response(response):
    if not isinstance(response, dict) or response.get("status") != "completed":
        raise CoachError("模型未完成分析，请稍后重试。", 502)
    parts = []
    for item in response.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            if content.get("type") == "refusal":
                raise CoachError("模型未能提供这次分析，请复核统计后重试。", 422)
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                parts.append(content["text"])
    try:
        result = _strict_json("".join(parts))
        if not isinstance(result, dict) or set(result) != set(OUTPUT_SCHEMA["required"]):
            raise ValueError("unexpected fields")
        for key, value in result.items():
            if key == "summary":
                strings, limit = [value], 600
            else:
                if not isinstance(value, list) or not 1 <= len(value) <= 6:
                    raise ValueError("invalid list")
                strings, limit = value, 300
            if any(not isinstance(s, str) or not 1 <= len(s.strip()) <= limit
                   or not re.search(r"[\u3400-\u9fff]", s) for s in strings):
                raise ValueError("invalid text")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise CoachError("模型返回的分析格式不完整，请稍后重试。", 502) from None
    if not result["summary"].startswith("仅根据匿名聚合统计提供参考。"):
        result["summary"] = "仅根据匿名聚合统计提供参考。" + result["summary"]
    return result


def request_analysis(summary, token, model):
    payload = {"model": model, "store": False, "max_output_tokens": OUTPUT_LIMIT,
               "instructions": INSTRUCTIONS,
               "input": [{"role": "user", "content": [{"type": "input_text",
                          "text": json.dumps(summary, ensure_ascii=False, allow_nan=False)}]}],
               "text": {"format": {"type": "json_schema", "name": "sailfish_coach",
                                   "strict": True, "schema": OUTPUT_SCHEMA}}}
    req = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=PROVIDER_TIMEOUT) as response:
            raw = response.read(RESPONSE_LIMIT + 1)
        if len(raw) > RESPONSE_LIMIT:
            raise CoachError("模型响应过大，请稍后重试。", 502)
        result = _strict_json(raw)
    except (TimeoutError, OSError, urllib.error.URLError):
        raise CoachError("模型服务暂时不可用或超时，请稍后重试。", 502) from None
    except (ValueError, UnicodeError, RecursionError):
        raise CoachError("模型服务返回了无效响应，请稍后重试。", 502) from None
    try:
        return _analysis_from_response(result)
    except (TypeError, AttributeError):
        raise CoachError("模型服务返回了无效响应，请稍后重试。", 502) from None


class CoachService:
    def __init__(self, clock=time.monotonic):
        self.token = secrets.token_urlsafe(32)
        self.clock = clock
        self.lock = threading.Lock()
        self.active = False
        self.requests = []

    def status(self):
        token, model = configuration()
        return {"configured": bool(token and model), "model": model, "token": self.token}

    def analyze(self, summary):
        token, model = configuration()
        if not token or not model:
            raise CoachError("服务端尚未配置AI凭证和模型。", 503)
        validate_summary(summary)
        with self.lock:
            now = self.clock()
            self.requests = [t for t in self.requests if now - t < 3600]
            if self.active:
                raise CoachError("已有分析正在进行，请等待完成。", 429)
            if self.requests and now - self.requests[-1] < COOLDOWN_SECONDS:
                raise CoachError("每30秒最多分析一次，请稍后重试。", 429)
            if len(self.requests) >= HOURLY_LIMIT:
                raise CoachError("本小时分析次数已达上限，请稍后重试。", 429)
            self.active = True
            self.requests.append(now)
        try:
            return {"analysis": request_analysis(summary, token, model), "model": model}
        finally:
            with self.lock:
                self.active = False
