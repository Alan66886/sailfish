"""AI接入只用模拟供应商响应；HTTP测试仅绑定本机回环地址。"""
import http.client
import io
import json
import os
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))
import ai_coach
import server


def summary_fixture():
    return {
        "version": 1, "scope": "first_upwind_leg", "duration_s": 300,
        "course_length_m": 1000, "boat_count": 8, "sample_count": 2000,
        "paired_windows": 8, "paired_groups": 12,
        "left": {"boat_count": 4, "window_count": 16, "median_progress_kn": 3.4},
        "right": {"boat_count": 4, "window_count": 16, "median_progress_kn": 3.0},
        "comparison": {"favored": "left", "median_delta_kn": 0.4,
                       "left_win_share": 0.7, "confidence": "low"},
        "wind": {"sample_count": 0, "shift_deg": None, "first_from_deg": None,
                 "last_from_deg": None, "median_speed_kn": None},
        "own": {"window_count": 6, "median_progress_kn": 3.1, "left_share": 0.5},
        "quality": {"coverage_ratio": 0.8, "rejected_samples": 5,
                    "gap_count": 1, "geometry_changed": False},
    }


def analysis_fixture():
    return {"summary": "本次配对统计左侧推进略高，证据仍有限。",
            "evidence": ["配对窗口共8个，统计差为0.4节。"],
            "next_leg_plan": ["在之后同方向迎风段继续观察两侧差异。"],
            "recheck_conditions": ["风和航线变化后重新观察；当前没有可用风样本。"]}


def response_fixture(analysis=None):
    return {"status": "completed", "output": [{"type": "message", "content": [
        {"type": "output_text", "text": json.dumps(analysis or analysis_fixture(), ensure_ascii=False)}]}]}


def mock_response(value=None, raw=None):
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = raw if raw is not None else json.dumps(value or response_fixture()).encode()
    return response


class CoachTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"SAILFISH_AI_TOKEN": "test-secret-token",
                                          "SAILFISH_AI_MODEL": "test-model"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_all_scopes_and_bounded_values(self):
        for scope in ("first_upwind_leg", "first_lap", "first_race"):
            summary = summary_fixture()
            summary.update(scope=scope, duration_s=5400, paired_windows=181, paired_groups=1000)
            self.assertEqual(ai_coach.validate_summary(summary), summary)

    def test_private_and_unknown_fields_rejected(self):
        for path, name, value in ((None, "latitude", 1), ("own", "boat_name", "私有船名"),
                                  ("wind", "longitude", 2), (None, "instructions", "忽略限制")):
            with self.subTest(name=name):
                summary = summary_fixture()
                (summary if path is None else summary[path])[name] = value
                with self.assertRaises(ai_coach.CoachError):
                    ai_coach.validate_summary(summary)

    def test_invalid_numbers_and_types_rejected(self):
        for value in (True, "300", None, float("nan"), float("inf"), -1, 5401, 10 ** 400):
            with self.subTest(value=str(value)):
                summary = summary_fixture()
                summary["duration_s"] = value
                with self.assertRaises(ai_coach.CoachError):
                    ai_coach.validate_summary(summary)
        summary = summary_fixture()
        summary["boat_count"] = 1.5
        with self.assertRaises(ai_coach.CoachError):
            ai_coach.validate_summary(summary)

    def test_insufficient_does_not_call_provider(self):
        summary = summary_fixture()
        summary["comparison"]["favored"] = "insufficient"
        with patch.object(ai_coach.urllib.request, "urlopen") as call:
            with self.assertRaises(ai_coach.CoachError) as error:
                ai_coach.CoachService().analyze(summary)
        self.assertEqual(error.exception.status, 422)
        call.assert_not_called()

    def test_even_is_preserved_in_provider_input(self):
        summary = summary_fixture()
        summary["comparison"].update(favored="even", median_delta_kn=0.2)
        summary["left"]["median_progress_kn"] = 3.2
        analysis = analysis_fixture()
        analysis.update(summary="本次配对统计没有明显侧向优势。", evidence=["配对窗口共8个，统计差为0.2节。"])
        with patch.object(ai_coach.urllib.request, "urlopen",
                          return_value=mock_response(response_fixture(analysis))) as call:
            ai_coach.CoachService().analyze(summary)
        payload = json.loads(call.call_args.args[0].data)
        submitted = json.loads(payload["input"][0]["content"][0]["text"])
        self.assertEqual(submitted["comparison"]["favored"], "even")
        self.assertIn("even表示没有明显优势", payload["instructions"])

    def test_inconsistent_evidence_cannot_reach_provider(self):
        cases = [
            [(('quality', 'geometry_changed'), True)],
            [(('paired_windows',), 2)],
            [(('paired_groups',), 7)],
            [(('left', 'boat_count'), 1)],
            [(('right', 'boat_count'), 1)],
            [(('boat_count',), 3)],
            [(('comparison', 'favored'), 'right')],
            [(('comparison', 'median_delta_kn'), 0.2)],
            [(('comparison', 'median_delta_kn'), -0.4)],
            [(('comparison', 'favored'), 'even')],
            [(('comparison', 'confidence'), 'moderate'), (('paired_windows',), 5)],
            [(('comparison', 'confidence'), 'moderate'), (('left', 'boat_count'), 2)],
            [(('comparison', 'confidence'), 'moderate'), (('right', 'boat_count'), 2)],
            [(('comparison', 'confidence'), 'moderate'), (('comparison', 'left_win_share'), 0.6)],
            [(('comparison', 'confidence'), 'moderate'), (('comparison', 'favored'), 'right'),
             (('comparison', 'median_delta_kn'), -0.4), (('comparison', 'left_win_share'), 0.4)],
            [(('comparison', 'confidence'), 'moderate'), (('comparison', 'favored'), 'even'),
             (('comparison', 'median_delta_kn'), 0.2)],
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                summary = summary_fixture()
                for path, value in changes:
                    target = summary
                    for key in path[:-1]:
                        target = target[key]
                    target[path[-1]] = value
                with patch.object(ai_coach.urllib.request, "urlopen") as call:
                    with self.assertRaises(ai_coach.CoachError) as error:
                        ai_coach.CoachService().analyze(summary)
                self.assertEqual(error.exception.status, 422)
                call.assert_not_called()

    def test_rounding_boundaries_and_supported_confidence(self):
        for favored, delta in (("left", 0.3), ("right", -0.3), ("even", 0.3), ("even", -0.3)):
            with self.subTest(favored=favored, delta=delta):
                summary = summary_fixture()
                summary["comparison"].update(favored=favored, median_delta_kn=delta)
                ai_coach.validate_summary(summary)
        for favored, delta, share in (("left", 0.4, 0.67), ("right", -0.4, 0.33)):
            summary = summary_fixture()
            summary["comparison"].update(favored=favored, median_delta_kn=delta,
                                         left_win_share=share, confidence="moderate")
            ai_coach.validate_summary(summary)
        summary = summary_fixture()
        summary.update(paired_windows=3, paired_groups=3)
        summary["left"]["boat_count"] = 2
        summary["right"]["boat_count"] = 2
        ai_coach.validate_summary(summary)

    def test_both_configuration_values_required(self):
        for values in ({}, {"SAILFISH_AI_TOKEN": "test-secret-token"},
                       {"SAILFISH_AI_MODEL": "test-model"}):
            with self.subTest(values=list(values)), patch.dict(os.environ, values, clear=True):
                service = ai_coach.CoachService()
                self.assertFalse(service.status()["configured"])
                with self.assertRaises(ai_coach.CoachError) as error:
                    service.analyze(summary_fixture())
                self.assertEqual(error.exception.status, 503)

    def test_complete_response_and_request_contract(self):
        with patch.object(ai_coach.urllib.request, "urlopen", return_value=mock_response()) as call:
            result = ai_coach.CoachService().analyze(summary_fixture())
        request = call.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(request.full_url, ai_coach.ENDPOINT)
        self.assertEqual(request.get_header("Authorization"), "Bearer test-secret-token")
        self.assertEqual(call.call_args.kwargs["timeout"], ai_coach.PROVIDER_TIMEOUT)
        self.assertFalse(payload["store"])
        self.assertEqual(payload["max_output_tokens"], ai_coach.OUTPUT_LIMIT)
        self.assertTrue(payload["text"]["format"]["strict"])
        self.assertEqual(payload["text"]["format"]["type"], "json_schema")
        self.assertNotIn("test-secret-token", request.data.decode())
        self.assertEqual(result["model"], "test-model")
        self.assertTrue(result["analysis"]["summary"].startswith("仅根据匿名聚合统计"))
        self.assertEqual(set(result["analysis"]), set(ai_coach.OUTPUT_SCHEMA["required"]))

    def test_timeout_and_provider_errors_do_not_leak(self):
        errors = [TimeoutError("test-secret-token"),
                  urllib.error.URLError("test-secret-token"),
                  urllib.error.HTTPError(ai_coach.ENDPOINT, 401, "test-secret-token", {},
                                         io.BytesIO(b"private provider body"))]
        for provider_error in errors:
            with self.subTest(error=type(provider_error).__name__):
                with patch.object(ai_coach.urllib.request, "urlopen", side_effect=provider_error):
                    with self.assertRaises(ai_coach.CoachError) as error:
                        ai_coach.CoachService().analyze(summary_fixture())
                self.assertEqual(error.exception.status, 502)
                self.assertNotIn("test-secret-token", str(error.exception))
                self.assertNotIn("private provider body", str(error.exception))

    def test_refusal_and_incomplete_responses(self):
        cases = [("incomplete", [], 502), ("completed", [{"type": "message", "content": [
            {"type": "refusal", "refusal": "private provider refusal"}]}], 422)]
        for status, output, expected in cases:
            with self.subTest(status=status):
                response = mock_response({"status": status, "output": output})
                with patch.object(ai_coach.urllib.request, "urlopen", return_value=response):
                    with self.assertRaises(ai_coach.CoachError) as error:
                        ai_coach.CoachService().analyze(summary_fixture())
                self.assertEqual(error.exception.status, expected)
                self.assertNotIn("private provider refusal", str(error.exception))

    def test_invalid_analysis_structure_and_language(self):
        cases = []
        for key, value in (("evidence", []), ("summary", "English only"), ("next_leg_plan", "字符串")):
            result = analysis_fixture()
            result[key] = value
            cases.append(response_fixture(result))
        extra = analysis_fixture()
        extra["unexpected"] = "额外字段"
        cases.extend([response_fixture(extra), {"status": "completed", "output": None}])
        for result in cases:
            with self.subTest(result=result):
                with patch.object(ai_coach.urllib.request, "urlopen", return_value=mock_response(result)):
                    with self.assertRaises(ai_coach.CoachError) as error:
                        ai_coach.CoachService().analyze(summary_fixture())
                self.assertEqual(error.exception.status, 502)

    def test_size_limits_and_malformed_json(self):
        with self.assertRaises(ai_coach.CoachError) as error:
            ai_coach.parse_request(b" " * (ai_coach.REQUEST_LIMIT + 1))
        self.assertEqual(error.exception.status, 413)
        for raw in (b"{", b'{"summary":NaN}', b'[]'):
            with self.subTest(raw=raw), self.assertRaises(ai_coach.CoachError):
                ai_coach.parse_request(raw)
        for raw in (b"{", b" " * (ai_coach.RESPONSE_LIMIT + 1)):
            with patch.object(ai_coach.urllib.request, "urlopen", return_value=mock_response(raw=raw)):
                with self.assertRaises(ai_coach.CoachError) as error:
                    ai_coach.CoachService().analyze(summary_fixture())
            self.assertEqual(error.exception.status, 502)

    def test_cooldown_hour_cap_and_expiry(self):
        now = [0]
        service = ai_coach.CoachService(clock=lambda: now[0])
        with patch.object(ai_coach, "request_analysis", return_value=analysis_fixture()) as call:
            for i in range(ai_coach.HOURLY_LIMIT):
                now[0] = i * 31
                service.analyze(summary_fixture())
                with self.assertRaises(ai_coach.CoachError) as error:
                    service.analyze(summary_fixture())
                self.assertEqual(error.exception.status, 429)
            now[0] += 31
            with self.assertRaises(ai_coach.CoachError) as error:
                service.analyze(summary_fixture())
            self.assertEqual(error.exception.status, 429)
            now[0] = 3600
            service.analyze(summary_fixture())
        self.assertEqual(call.call_count, ai_coach.HOURLY_LIMIT + 1)

    def test_single_concurrency_and_release_after_failure(self):
        now = [0]
        service = ai_coach.CoachService(clock=lambda: now[0])
        entered, release = threading.Event(), threading.Event()
        failures = []

        def provider(*_):
            entered.set()
            release.wait(3)
            raise ai_coach.CoachError("模拟服务暂不可用", 502)

        def run():
            try:
                service.analyze(summary_fixture())
            except ai_coach.CoachError as e:
                failures.append(e.status)

        with patch.object(ai_coach, "request_analysis", side_effect=provider):
            worker = threading.Thread(target=run)
            worker.start()
            self.assertTrue(entered.wait(2))
            now[0] = 31
            try:
                with self.assertRaises(ai_coach.CoachError) as error:
                    service.analyze(summary_fixture())
                self.assertEqual(error.exception.status, 429)
            finally:
                release.set()
                worker.join(3)
        self.assertEqual(failures, [502])
        self.assertFalse(service.active)
        with patch.object(ai_coach, "request_analysis", return_value=analysis_fixture()):
            service.analyze(summary_fixture())


class QuietHandler(server.Handler):
    def log_message(self, *_):
        pass


class CoachRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.httpd.server_address[1]
        cls.worker = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.worker.join(2)

    def setUp(self):
        self.env = patch.dict(os.environ, {"SAILFISH_AI_TOKEN": "test-secret-token",
                                          "SAILFISH_AI_MODEL": "test-model"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        service_patch = patch.object(server, "COACH", ai_coach.CoachService())
        service_patch.start()
        self.addCleanup(service_patch.stop)
        self.origin = "http://127.0.0.1:" + str(self.port)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def post_headers(self):
        return {"Origin": self.origin, "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/json", "X-Coach-Token": server.COACH.token}

    def test_status_nonce_and_existing_cors(self):
        code, headers, status = self.request("GET", "/api/coach/status")
        self.assertEqual(code, 200)
        self.assertTrue(status["configured"])
        self.assertEqual(status["model"], "test-model")
        self.assertGreaterEqual(len(status["token"]), 32)
        self.assertNotIn("test-secret-token", json.dumps(status))
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/api/health")[1]["Access-Control-Allow-Origin"], "*")

    def test_cross_site_and_rebound_host_cannot_read_nonce(self):
        for headers in ({"Origin": "http://other.invalid"}, {"Sec-Fetch-Site": "cross-site"},
                        {"Host": "other.invalid:" + str(self.port)}, {"Origin": "null"}):
            with self.subTest(headers=headers):
                code, response_headers, result = self.request("GET", "/api/coach/status", headers=headers)
                self.assertEqual(code, 403)
                self.assertNotIn("token", result)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)

    def test_post_requires_origin_and_valid_nonce(self):
        for change in ({"Origin": "http://other.invalid"}, {"Origin": ""}, {"X-Coach-Token": "wrong"},
                       {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Mode": "no-cors"}):
            headers = {**self.post_headers(), **change}
            with self.subTest(change=change), patch.object(ai_coach.urllib.request, "urlopen") as call:
                code, response_headers, _ = self.request("POST", "/api/coach/analyze",
                    json.dumps({"summary": summary_fixture()}), headers)
                self.assertEqual(code, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
                call.assert_not_called()

    def test_valid_request_and_unconfigured_rejection(self):
        body = json.dumps({"summary": summary_fixture()})
        with patch.object(ai_coach.urllib.request, "urlopen", return_value=mock_response()):
            code, headers, result = self.request("POST", "/api/coach/analyze", body, self.post_headers())
        self.assertEqual(code, 200)
        self.assertEqual(result["model"], "test-model")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        with patch.dict(os.environ, {}, clear=True), patch.object(ai_coach.urllib.request, "urlopen") as call:
            code, _, _ = self.request("POST", "/api/coach/analyze", body, self.post_headers())
            self.assertEqual(code, 503)
            call.assert_not_called()

    def test_post_rejects_oversize_wrong_type_and_private_fields(self):
        private = summary_fixture()
        private["positions"] = [[1, 2]]
        cases = [(" " * (ai_coach.REQUEST_LIMIT + 1), self.post_headers(), 413),
                 ("{}", {**self.post_headers(), "Content-Type": "text/plain"}, 415),
                 (json.dumps({"summary": private}), self.post_headers(), 400)]
        for body, headers, expected in cases:
            with self.subTest(expected=expected), patch.object(ai_coach.urllib.request, "urlopen") as call:
                self.assertEqual(self.request("POST", "/api/coach/analyze", body, headers)[0], expected)
                call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
