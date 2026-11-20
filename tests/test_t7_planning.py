import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from google import genai
from google.genai.errors import APIError

from api import app
from parser import GeminiDraftError, clarify_project, propose_project_plan
from planning_draft import GeneratePlanningRequest


EN_PROMPT = "Build a small website for taking orders."
VI_PROMPT = (
    "Nhóm mình có 5 sinh viên, muốn xây dựng một website bán sách để làm đồ án đại học. "
    "Thời gian hoàn thành là 30 ngày, nhóm chưa có kinh nghiệm quản lý dự án "
    "và chưa biết nên chia công việc như thế nào."
)
DETAILED_PROMPT = (
    "Build a 30-day bookstore MVP for a team of five. Customers browse and search the catalog, "
    "then reserve books for pickup without online payment. Staff manage inventory and reservations. "
    "Exclude shipping and customer accounts."
)


def task(id_, name, category, duration, dependencies, **evidence):
    return {
        "id": id_, "name": name, "category": category, "duration": duration, "dependencies": dependencies,
        "duration_quote": None, "dependency_quote": None, **evidence,
    }


def english_plan():
    return {
        "goal": "Take orders online",
        "project_name": "Order website",
        "tasks": [
            task("T1", "Build API", "Backend", 3, []),
            task("T2", "Test API", "QA", 2, ["T1"]),
        ],
        "assumptions": ["A basic order form is sufficient."],
        "uncertainties": ["Payment integration may be needed."],
    }


def response(value):
    return SimpleNamespace(text=json.dumps(value, ensure_ascii=False))


def mock_generate(client):
    provider = client.return_value.__enter__.return_value.aio.__aenter__.return_value
    provider.models.generate_content = AsyncMock()
    return provider.models.generate_content


class PlanningParserTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"GEMINI_DRAFT_MODEL": "", "GEMINI_DRAFT_FALLBACK_MODEL": "gemini-3.5-flash"}))
        self.client = self.enterContext(patch("parser.genai.Client"))
        self.generate = mock_generate(self.client)

    async def plan(self, output, prompt=EN_PROMPT, clarifications=()):
        self.generate.return_value = response(output)
        request = GeneratePlanningRequest(prompt=prompt, clarifications=list(clarifications))
        return await propose_project_plan(request, "mock-key")

    async def test_short_vietnamese_description_and_three_questions(self):
        questions = [
            "Website có cần thanh toán trực tuyến không?",
            "Người quản trị cần quản lý sách và đơn hàng như thế nào?",
            "Bản đầu tiên cần có những tính năng nào để nộp đồ án?",
        ]
        goal = "Xây dựng website bán sách"
        self.generate.return_value = response({"goal": goal, "questions": questions})
        clarified = await clarify_project(VI_PROMPT, "mock-key")
        self.assertEqual(clarified.goal, goal)
        self.assertEqual([(item.id, item.text) for item in clarified.questions], list(zip(("Q1", "Q2", "Q3"), questions)))
        for call in self.generate.call_args_list:
            self.assertEqual(call.kwargs["contents"], VI_PROMPT)
        plan = await self.plan({
            "goal": goal, "project_name": "Website bán sách",
            "tasks": [task("T1", "Tạo biểu mẫu đặt hàng", "Giao diện", 3, [])],
            "assumptions": ["Cửa hàng xác nhận đơn thủ công."],
            "uncertainties": ["Chưa rõ phương thức giao hàng."],
        }, VI_PROMPT)
        self.assertEqual(plan.draft.tasks[0].category, "Giao diện")
        self.assertEqual(plan.draft.tasks[0].duration_review, "suggested")
        self.assertEqual(plan.uncertainties, ["Chưa rõ phương thức giao hàng."])

    async def test_short_english_description_asks_only_high_impact_questions(self):
        questions = ["Should customers pay online or pay on pickup?"]
        self.generate.return_value = response({"goal": "Take orders online", "questions": questions})
        clarified = await clarify_project(EN_PROMPT, "mock-key")
        self.assertEqual([item.text for item in clarified.questions], questions)
        config = self.generate.call_args.kwargs["config"]
        self.assertIn("scope, required features, task breakdown, dependencies, or duration estimates", config.system_instruction)
        self.assertIn("Do not ask for information already given", config.system_instruction)
        self.assertIn("empty questions list", config.system_instruction)

    async def test_detailed_description_needs_no_questions(self):
        self.generate.return_value = response({"goal": "Build an online bookstore", "questions": []})
        clarified = await clarify_project(DETAILED_PROMPT, "mock-key")
        self.assertEqual(clarified.questions, [])
        self.assertEqual(self.generate.call_args.kwargs["contents"], DETAILED_PROMPT)

    async def test_skipping_all_keeps_assumptions_and_suggestions_unconfirmed(self):
        plan = await self.plan(english_plan(), clarifications=[
            {"id": "Q1", "question": "Should customers pay online?"},
            {"id": "Q2", "question": "Should staff manage items in an admin dashboard?", "answer": None},
        ])
        first, second = plan.draft.tasks
        self.assertEqual((first.duration, first.duration_review), (3, "suggested"))
        self.assertEqual((first.dependencies, first.dependency_review), ([], "suggested"))
        self.assertEqual((second.dependencies, second.dependency_review), (["T1"], "suggested"))
        self.assertEqual(plan.assumptions, ["A basic order form is sufficient."])
        self.assertEqual(plan.sources.tasks["T2"].dependencies.kind, "ai")
        self.assertEqual([item["answer"] for item in json.loads(self.generate.call_args.kwargs["contents"])["clarifications"]], [None, None])
        self.assertIn("skipped questions", self.generate.call_args.kwargs["config"].system_instruction)

    async def test_partial_answers_are_used_and_skipped_questions_are_not_evidence(self):
        duration = "Build API takes 3 days"
        order = "Test API runs after Build API"
        independent = "Build API has no prerequisites"
        output = english_plan()
        output["tasks"][0].update(duration_quote=duration, dependency_quote=independent)
        output["tasks"][1].update(dependency_quote=order)
        plan = await self.plan(output, f"{EN_PROMPT} {order}.", [
            {"id": "Q1", "question": "How long is the API work?", "answer": duration},
            {"id": "Q2", "question": independent, "answer": None},
            {"id": "Q3", "question": "Which orders should it support?", "answer": "  "},
        ])
        first, second = plan.draft.tasks
        self.assertEqual((first.duration_review, second.dependency_review), ("provided", "provided"))
        self.assertEqual(plan.sources.tasks["T1"].duration.model_dump(), {"kind": "answer", "question_id": "Q1"})
        self.assertEqual(plan.sources.tasks["T2"].dependencies.kind, "description")
        self.assertEqual((first.dependencies, first.dependency_review), ([], "suggested"))
        sent = json.loads(self.generate.call_args.kwargs["contents"])
        self.assertEqual([item["answer"] for item in sent["clarifications"]], [duration, None, None])

    async def test_explicit_absence_and_missing_dependencies_have_different_states(self):
        independent = "Build API has no prerequisites"
        output = english_plan()
        output["tasks"][0]["dependency_quote"] = independent
        output["tasks"][1].update(dependencies=None, duration=None)
        plan = await self.plan(output, f"{EN_PROMPT} {independent}.")
        first, second = plan.draft.tasks
        self.assertEqual((first.dependencies, first.dependency_review), ([], "provided"))
        self.assertEqual((second.dependencies, second.dependency_review), (None, "missing"))
        self.assertEqual((second.duration, second.duration_review), (None, "missing"))
        self.assertEqual(plan.sources.tasks["T2"].dependencies.kind, "unknown")
        self.assertIsNone(plan.draft.confirm()[0])

    async def test_confirming_suggestions_uses_existing_draft_and_never_assigns_tasks(self):
        plan = await self.plan(english_plan())
        first, second = plan.draft.tasks
        for item in (first, second):
            item.duration_review = "confirmed"
        second.dependency_review = "confirmed"
        ir, errors = plan.draft.confirm()
        self.assertIsNone(ir)
        self.assertEqual(len(errors), 1)
        self.assertIn("T1", errors[0])
        first.dependency_review = "confirmed"
        ir, errors = plan.draft.confirm()
        self.assertEqual(errors, [])
        self.assertEqual([item.dependencies for item in ir.tasks], [[], ["T1"]])
        self.assertTrue(all(item.assignee_id is None and item.status == "To Do" for item in ir.tasks))

    async def test_fabricated_ambiguous_or_conflicting_evidence_requires_review(self):
        duration = "Build API takes 3 days"
        order = "Test API runs after Build API"
        output = english_plan()
        output["tasks"][0]["duration_quote"] = "3 days"
        output["tasks"][1]["dependency_quote"] = order
        for prompt, answers in (
            (EN_PROMPT, []),
            (f"Maybe {duration}. {order}?", []),
            (f"{duration} and 2 hours. {order}, but Build API can also run later.", []),
            ("Build API -3 days. Test API depends on an unknown external task.", []),
        ):
            with self.subTest(prompt=prompt):
                plan = await self.plan(output, prompt, answers)
                self.assertEqual(plan.draft.tasks[0].duration_review, "suggested")
                self.assertEqual(plan.draft.tasks[1].dependency_review, "suggested")

    async def test_unrelated_and_ambiguous_answers_do_not_override_duration(self):
        output = english_plan()
        output["tasks"][0]["duration_quote"] = "Build API takes 3 days"
        for answer in ("Test API takes 5 days.", "Test Build API takes 5 days.", "Correction: it takes 5 days instead."):
            with self.subTest(answer=answer):
                plan = await self.plan(output, "Build API takes 3 days.", [
                    {"id": "Q1", "question": "Any further details?", "answer": answer},
                ])
                self.assertEqual((plan.draft.tasks[0].duration, plan.draft.tasks[0].duration_review), (3, "provided"))
                self.assertEqual(plan.sources.tasks["T1"].duration.kind, "description")

    async def test_correction_cannot_disambiguate_duplicate_task_names(self):
        output = english_plan()
        output["tasks"][1]["name"] = "Build API"
        plan = await self.plan(output, "Build API takes 3 days.", [
            {"id": "Q1", "question": "Any correction?", "answer": "Correction: Build API takes 5 days instead."},
        ])
        for draft_task in plan.draft.tasks:
            self.assertIsNone(draft_task.duration)
            self.assertEqual(draft_task.duration_review, "missing")
            self.assertEqual(plan.sources.tasks[draft_task.id].duration.kind, "unknown")

    async def test_conflicting_prerequisites_still_require_review(self):
        output = english_plan()
        order = "Test API runs after Build API"
        output["tasks"][1]["dependency_quote"] = order
        plan = await self.plan(output, order + ".", [
            {"id": "Q1", "question": "Any corrections?", "answer": "Test API is independent."},
        ])
        self.assertEqual(plan.draft.tasks[1].dependency_review, "suggested")

    async def test_partial_prerequisite_list_cannot_be_marked_provided(self):
        order = "Test API runs after Build API and Prepare fixtures"
        output = english_plan()
        output["tasks"].append(task("T3", "Prepare fixtures", "QA", 1, []))
        output["tasks"][1]["dependency_quote"] = order
        plan = await self.plan(output, f"{order}.")
        self.assertEqual(plan.draft.tasks[1].dependency_review, "suggested")
        output["tasks"][1]["dependencies"] = ["T1", "T3"]
        plan = await self.plan(output, f"{order}.")
        self.assertEqual(plan.draft.tasks[1].dependency_review, "provided")

    async def test_name_and_category_provenance(self):
        name = "Build API"
        category = "Build API belongs to Backend"
        output = english_plan()
        output["tasks"][0].update(name_quote=name, category_quote=category)
        plan = await self.plan(output, f"{EN_PROMPT} {category}.")
        self.assertEqual(plan.sources.tasks["T1"].name.kind, "description")
        self.assertEqual(plan.sources.tasks["T1"].category.kind, "description")
        self.assertEqual(plan.sources.tasks["T2"].category.kind, "ai")
        self.assertEqual(plan.sources.project_name.kind, "ai")

    async def test_bad_dependency_graphs_are_rejected_before_review(self):
        for first, second in (([], ["T99"]), (["T2"], ["T1"]), (["T1"], ["T1"])):
            with self.subTest(first=first, second=second):
                output = english_plan()
                output["tasks"][0]["dependencies"] = first
                output["tasks"][1]["dependencies"] = second
                with self.assertRaises(GeminiDraftError) as raised:
                    await self.plan(output)
                self.assertEqual(raised.exception.status_code, 502)
                self.assertNotIn("T99", str(raised.exception))

    async def test_invalid_output_and_attempts_to_set_project_state_are_rejected(self):
        for fields in ({"assignee_id": "M1"}, {"status": "Done"}, {"duration_review": "confirmed"},
                       {"duration": True}, {"deadline": "2027-01-01"}, {"id": "T2"}):
            with self.subTest(fields=fields):
                output = english_plan()
                output["tasks"][0].update(fields)
                with self.assertRaises(GeminiDraftError) as raised:
                    await self.plan(output)
                self.assertEqual(raised.exception.status_code, 502)

        self.generate.return_value = SimpleNamespace(text="broken JSON with sensitive text")
        with self.assertRaises(GeminiDraftError) as raised:
            await clarify_project(EN_PROMPT, "mock-key")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertNotIn("sensitive text", str(raised.exception))

    async def test_unset_empty_and_explicit_planning_models_use_the_shared_draft_configuration(self):
        for setting, expected in (
            (None, "gemini-3.6-flash"), ("", "gemini-3.6-flash"), ("   ", "gemini-3.6-flash"),
            (" models/gemini-3.7-flash ", "gemini-3.7-flash"),
        ):
            with self.subTest(setting=setting), patch.dict(os.environ):
                if setting is None:
                    os.environ.pop("GEMINI_DRAFT_MODEL", None)
                else:
                    os.environ["GEMINI_DRAFT_MODEL"] = setting
                self.generate.reset_mock()
                self.generate.return_value = response({"goal": "Take orders online", "questions": []})
                await clarify_project(EN_PROMPT, "mock-key")
                await self.plan(english_plan())
                self.assertEqual([call.kwargs["model"] for call in self.generate.call_args_list], [expected, expected])
                for call in self.generate.call_args_list:
                    self.assertEqual(call.kwargs["config"].response_mime_type, "application/json")
                    self.assertEqual(call.kwargs["config"].thinking_config.thinking_level, "LOW")

    async def test_first_attempt_success(self):
        self.generate.return_value = response({"goal": "Take orders online", "questions": []})
        with self.assertLogs("parser", level="INFO") as logs:
            result = await clarify_project(EN_PROMPT, "mock-key")
        self.assertEqual(result.goal, "Take orders online")
        self.generate.assert_awaited_once()
        self.assertRegex(logs.output[0], (
            r"stage=clarify model=gemini-3\.6-flash attempt=1 elapsed_ms=\d+ "
            r"status=200 exception=none retry=none outcome=succeeded"
        ))

    async def test_retry_also_fails_and_never_attempts_a_third_request(self):
        self.generate.side_effect = [APIError(503, {}), APIError(504, {})]
        with patch("parser.uniform", return_value=0), self.assertLogs("parser", level="WARNING") as logs:
            with self.assertRaises(GeminiDraftError) as raised:
                await clarify_project(EN_PROMPT, "mock-key")
        self.assertEqual(raised.exception.status_code, 504)
        self.assertEqual(self.generate.await_count, 2)
        self.assertIn("status=503 exception=APIError retry=scheduled outcome=retrying", logs.output[0])
        self.assertIn("status=504 exception=APIError retry=limit outcome=failed", logs.output[1])

    async def test_gateway_timeout_with_insufficient_budget_is_not_retried(self):
        self.generate.side_effect = APIError(504, {})
        with patch("parser._DRAFT_TIMEOUT_MS", 5_100), self.assertLogs("parser", level="WARNING") as logs:
            with self.assertRaises(GeminiDraftError) as raised:
                await clarify_project(EN_PROMPT, "mock-key")
        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("Gemini phản hồi", str(raised.exception))
        self.generate.assert_awaited_once()
        self.assertIn("status=504 exception=APIError retry=budget outcome=failed", logs.output[0])

    async def test_nontransient_provider_errors_and_local_failures_are_not_retried(self):
        for error, status, provider_status, decision in (
            (APIError(400, {}), 502, 400, "ineligible"),
            (APIError(400, {"message": "API key invalid"}), 503, 400, "ineligible"),
            (APIError(401, {}), 503, 401, "ineligible"),
            (APIError(403, {}), 503, 403, "ineligible"),
            (APIError(429, {}), 429, 429, "ineligible"),
            (httpx.ReadTimeout("local timeout"), 504, None, "none"),
            (httpx.ConnectError("local connection error"), 503, None, "none"),
        ):
            with self.subTest(status=status), self.assertLogs("parser", level="WARNING") as logs:
                self.generate.reset_mock()
                self.generate.side_effect = error
                with self.assertRaises(GeminiDraftError) as raised:
                    await clarify_project(EN_PROMPT, "mock-key")
                self.assertEqual(raised.exception.status_code, status)
                self.generate.assert_awaited_once()
                self.assertIn(f"status={provider_status} exception={type(error).__name__} retry={decision}", logs.output[0])
                self.assertIn("outcome=failed", logs.output[0])

    async def test_invalid_structured_output_and_question_limits_do_not_retry(self):
        for result in (
            SimpleNamespace(text="broken JSON"),
            response({"goal": None, "questions": ["Who?", "Where?", "When?", "How?"]}),
            response({"goal": None, "questions": ["Who?", "who?"]}),
        ):
            self.generate.reset_mock()
            self.generate.return_value = result
            with self.assertLogs("parser", level="WARNING") as logs:
                with self.assertRaises(GeminiDraftError) as raised:
                    await clarify_project(EN_PROMPT, "mock-key")
            self.assertEqual(raised.exception.status_code, 502)
            self.generate.assert_awaited_once()
            self.assertIn("status=200 exception=ValidationError retry=none outcome=failed", logs.output[0])

    async def test_shared_deadline_cancels_a_slow_retry_with_a_reduced_http_timeout(self):
        timeouts = []
        cancelled = asyncio.Event()

        async def slow_response(*, model, contents, config):
            timeouts.append(config.http_options.timeout)
            if len(timeouts) == 1:
                await asyncio.sleep(0.05)
                raise APIError(503, {})
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        self.generate.side_effect = slow_response
        with (
            patch("parser._DRAFT_TIMEOUT_MS", 300),
            patch("parser._PLANNING_MIN_RETRY_TIME_S", 0.05),
            patch("parser.uniform", return_value=0.04),
            self.assertLogs("parser", level="WARNING") as logs,
        ):
            with self.assertRaises(GeminiDraftError) as raised:
                await asyncio.wait_for(clarify_project(EN_PROMPT, "mock-key"), timeout=2)
        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("Kết nối tới Gemini", str(raised.exception))
        self.assertTrue(cancelled.is_set())
        self.assertEqual(len(timeouts), 2)
        self.assertLessEqual(timeouts[0], 300)
        self.assertLess(timeouts[1], timeouts[0] - 70)
        self.assertIn("attempt=2", logs.output[-1])
        self.assertIn("status=None exception=TimeoutError retry=none outcome=failed", logs.output[-1])

    async def test_diagnostics_never_include_sensitive_input_or_output(self):
        secrets = ["private prompt", "private question", "private answer", "mock-key", "raw Gemini response", "provider body"]
        self.generate.side_effect = [
            APIError(503, {"message": "provider body with private answer and mock-key"}),
            SimpleNamespace(text="invalid raw Gemini response"),
        ]
        request = GeneratePlanningRequest(prompt="private prompt", clarifications=[
            {"id": "Q1", "question": "private question", "answer": "private answer"},
        ])
        with patch("parser.uniform", return_value=0), self.assertLogs("parser", level="INFO") as logs:
            with self.assertRaises(GeminiDraftError) as raised:
                await propose_project_plan(request, "mock-key")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(len(logs.output), 2)
        self.assertIn("stage=draft", logs.output[0])
        for secret in secrets:
            self.assertNotIn(secret, str(raised.exception))
            self.assertNotIn(secret, "\n".join(logs.output))


class PlanningSDKTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_stages_retry_transient_http_errors_on_the_same_model_with_the_installed_sdk(self):
        calls = []
        outputs = iter((503, {"goal": "Take orders online", "questions": []}, 504, english_plan()))

        def provider(request):
            calls.append((request.url.path, json.loads(request.content)))
            output = next(outputs)
            if isinstance(output, int):
                return httpx.Response(output, json={"error": {"code": output, "message": "temporary failure"}})
            return httpx.Response(200, json={"candidates": [{
                "finishReason": "STOP",
                "content": {"role": "model", "parts": [{"text": json.dumps(output)}]},
            }]})

        real_client = genai.Client
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as transport:
            def make_client(**options):
                options["http_options"].httpx_async_client = transport
                return real_client(**options)

            with (
                patch("parser.genai.Client", side_effect=make_client),
                patch.dict(os.environ, {"GEMINI_DRAFT_MODEL": "", "GEMINI_DRAFT_FALLBACK_MODEL": "gemini-3.5-flash"}),
                patch("parser.uniform", return_value=0),
                self.assertLogs("parser", level="INFO") as logs,
            ):
                clarified = await clarify_project(EN_PROMPT, "mock-key")
                plan = await propose_project_plan(GeneratePlanningRequest(prompt=EN_PROMPT), "mock-key")
        self.assertEqual(clarified.goal, plan.goal)
        self.assertEqual(len(calls), 4)
        for path, _ in calls:
            self.assertTrue(path.endswith("/models/gemini-3.6-flash:generateContent"))
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[2], calls[3])
        for line, (stage, attempt, status, outcome) in zip(logs.output, (
            ("clarify", 1, 503, "retrying"), ("clarify", 2, 200, "succeeded"),
            ("draft", 1, 504, "retrying"), ("draft", 2, 200, "succeeded"),
        ), strict=True):
            self.assertIn(f"stage={stage} model=gemini-3.6-flash attempt={attempt}", line)
            self.assertIn(f"status={status}", line)
            self.assertIn(f"outcome={outcome}", line)
        clear_schema, draft_schema = (
            calls[index][1]["generationConfig"]["responseJsonSchema"]["properties"] for index in (0, 2)
        )
        self.assertEqual(set(clear_schema), {"goal", "questions"})
        self.assertIn("assumptions", draft_schema)
        fields = draft_schema["tasks"]["items"]["properties"]
        self.assertIn("dependency_quote", fields)
        self.assertEqual(fields["dependencies"]["anyOf"][1], {"type": "null"})
        self.assertNotIn("assignee_id", fields)


class PlanningApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(patch("api._get_gemini_api_key", return_value="mock-key"))
        self.enterContext(patch.dict(os.environ, {"GEMINI_DRAFT_FALLBACK_MODEL": ""}))
        provider = self.enterContext(patch("parser.genai.Client"))
        self.generate = mock_generate(provider)
        self.client = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"),
        )

    async def test_planning_routes_and_t6_confirmation_contract(self):
        self.generate.side_effect = [
            response({"goal": "Take orders online", "questions": ["Do orders require payment?"]}),
            response(english_plan()),
        ]
        clarified = (await self.client.post("/api/planning/clarify", json={"prompt": EN_PROMPT})).raise_for_status().json()
        self.assertEqual(clarified["questions"], [{"id": "Q1", "text": "Do orders require payment?"}])
        planned = (await self.client.post("/api/planning/draft", json={
            "prompt": EN_PROMPT,
            "clarifications": [{"id": "Q1", "question": clarified["questions"][0]["text"]}],
        })).raise_for_status().json()
        self.assertEqual(set(planned), {"goal", "draft", "assumptions", "uncertainties", "sources"})
        draft = planned["draft"]
        self.assertEqual((await self.client.post("/api/parse/confirm", json=draft)).status_code, 422)
        for item in draft["tasks"]:
            item.update(duration_review="confirmed", dependency_review="confirmed")
        ir = (await self.client.post("/api/parse/confirm", json=draft)).raise_for_status().json()
        self.assertEqual(ir["tasks"][0]["dependencies"], [])
        self.assertEqual(ir["tasks"][1]["dependencies"], ["T1"])
        self.assertEqual(ir["members"], [])
        self.assertEqual(self.generate.call_count, 2)

    async def test_duration_corrections_through_draft_and_confirmation(self):
        description = "Design form takes 2 days."
        output = english_plan()
        output["tasks"][0].update(name="Design form", duration=2, duration_quote=description)
        output["tasks"][1]["duration_quote"] = "Test API takes 2 days."
        self.generate.return_value = response(output)

        for answer, extra_answer, expected in (
            ("Correction: Design form takes 5 days.", None, 5),
            ("Correction: Design form takes 5 days instead.", None, 5),
            ("Design form takes 5 days instead.", None, 5),
            ("Đính chính: Design form cần 5 ngày.", None, 5),
            ("Design form takes 5 days.", None, None),
            ("Correction: maybe Design form takes 5 days instead.", None, None),
            ("Correction: Design form takes 5–6 days.", None, None),
            ("Correction: Design form takes 5 days.", "Design form takes 6 days.", None),
        ):
            with self.subTest(answer=answer, extra_answer=extra_answer):
                clarifications = [{"id": "Q1", "question": "Any correction?", "answer": answer}]
                if extra_answer:
                    clarifications.append({"id": "Q2", "question": "How many days?", "answer": extra_answer})
                planned = (await self.client.post("/api/planning/draft", json={
                    "prompt": description + " Test API takes 2 days.",
                    "clarifications": clarifications,
                })).raise_for_status().json()
                draft = planned["draft"]
                first, second = draft["tasks"]
                self.assertEqual(first["duration"], expected)
                self.assertEqual(first["duration_review"], "provided" if expected else "missing")
                origin = {"kind": "answer", "question_id": "Q1"} if expected else {"kind": "unknown", "question_id": None}
                self.assertEqual(planned["sources"]["tasks"]["T1"]["duration"], origin)
                self.assertEqual((second["duration"], second["duration_review"]), (2, "provided"))

                # Mirror bulk confirmation: only concrete, suggested values are accepted.
                for item in draft["tasks"]:
                    for field, review in (("duration", "duration_review"), ("dependencies", "dependency_review")):
                        if item[field] is not None and item[review] == "suggested":
                            item[review] = "confirmed"
                confirmed = await self.client.post("/api/parse/confirm", json=draft)
                if expected is None:
                    self.assertEqual(confirmed.status_code, 422)
                    first.update(duration=6, duration_review="confirmed")
                    confirmed = await self.client.post("/api/parse/confirm", json=draft)
                self.assertEqual(confirmed.raise_for_status().json()["tasks"][0]["duration"], expected or 6)

    async def test_input_errors_are_sanitized_and_provider_errors_are_mapped(self):
        for payload in (
            {"prompt": "  "},
            {"prompt": EN_PROMPT, "api_key": "sensitive secret"},
            {"prompt": EN_PROMPT, "clarifications": [{"id": "Q1", "question": "Sensitive question"}] * 2},
        ):
            rejected = await self.client.post("/api/planning/draft", json=payload)
            self.assertEqual(rejected.status_code, 422)
            self.assertEqual(set(rejected.json()), {"detail"})
            self.assertNotIn("sensitive", rejected.text.lower())
        self.generate.assert_not_called()
        self.generate.side_effect = httpx.ReadTimeout("sensitive request")
        failure = await self.client.post("/api/planning/clarify", json={"prompt": EN_PROMPT})
        self.assertEqual(failure.status_code, 504)
        self.assertNotIn("sensitive", failure.text)
