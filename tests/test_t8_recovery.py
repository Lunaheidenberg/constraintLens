import asyncio
import copy
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

import httpx
from google.genai import Client as GeminiClient
from google.genai.errors import ServerError
from pydantic import ValidationError

from api import app
from recovery_analysis import analyze_recovery, question_focus
from recovery_models import RecoveryRequest


def task(task_id="A", duration=2, assignee="member-secret", dependencies=(), **fields):
    return {"id": task_id, "estimated_duration": duration, "assignee_id": assignee,
            "dependencies": list(dependencies), **fields}


def interval(task_id="A", start=0, end=2, **fields):
    return {"task_id": task_id, "start_day": start, "end_day": end, **fields}


def snapshot(ref="a", tasks=None, scheduled=None, *, start="2026-02-27", deadline="2026-02-28",
             status="OPTIMAL", progress=None):
    return {
        "project_ref": "local-project", "snapshot_ref": ref, "status": status,
        "calendar": {"project_start_date": start, "target_deadline_date": deadline},
        "tasks": tasks if tasks is not None else [task()],
        "scheduled_tasks": scheduled if scheduled is not None else [interval()],
        "progress": progress,
    }


def payload(accepted=None, proposal=None, question="Vì sao dự án bị trễ?", **extra):
    return {"context_ref": "local-context", "question": question, "accepted": accepted, "proposal": proposal, **extra}


def analyze(data):
    request = RecoveryRequest.model_validate(data)
    return analyze_recovery(request, question_focus(request))


def facts(response):
    return {fact.id: fact.data for fact in response.facts}


def delay_pair(status="FEASIBLE"):
    before = snapshot(tasks=[task(), task("B", 1, "member-two", ("A",))],
                      scheduled=[interval(), interval("B", 2, 3)], deadline="2026-03-01")
    after = snapshot("p", [task(duration=5, name="Tên dữ liệu riêng"), task("B", 1, "member-two", ("A",))],
                     [interval(end=5), interval("B", 5, 6)], deadline="2026-03-01", status=status)
    return before, after


def completed_snapshot():
    return snapshot("p", [task(), task("B", 1, "member-two", ("A",))], [],
                    progress={"progress_as_of_date": "2026-03-04",
                              "actual_finishes": {"A": "2026-02-27", "B": "2026-02-28"}})


class RecoveryAnalysisTests(TestCase):
    def test_on_time_inclusive_deadline_across_month_boundary(self):
        for days, final_date, days_late in ((1, "2026-02-27", 0), (2, "2026-02-28", 0), (3, "2026-03-01", 1)):
            with self.subTest(days=days):
                response = analyze(payload(proposal=snapshot("p", [task(duration=days)], [interval(end=days)])))
                result = facts(response)
                self.assertEqual(result["proposal:schedule"]["final_work_date"], final_date)
                self.assertEqual(result["proposal:deadline"]["days_late"], days_late)
                self.assertEqual(result["proposal:deadline"]["status"], "late" if days_late else "on_time")
        self.assertEqual(result["proposal:schedule"]["project_finish_date_exclusive"], "2026-03-02")

    def test_deadline_compares_both_finishes_against_proposal_target(self):
        before, after = delay_pair()
        before["calendar"]["target_deadline_date"] = "2026-02-27"
        response = analyze(payload(before, after))
        observed = facts(response)
        self.assertEqual(response.basis.evaluation_deadline_date.isoformat(), "2026-03-01")
        self.assertEqual(observed["accepted:deadline"]["days_late"], 0)
        self.assertEqual(observed["proposal:deadline"]["days_late"], 3)
        self.assertTrue(observed["comparison:schedule_change"]["deadline_changed"])
        self.assertEqual(observed["comparison:schedule_change"]["days_late_delta"], 3)

        after["calendar"]["target_deadline_date"] = None
        observed = facts(analyze(payload(before, after)))
        self.assertIsNone(observed["accepted:deadline"]["days_late"])
        self.assertEqual(observed["proposal:deadline"]["assessment"], "no_target")

    def test_delayed_prerequisite_tight_dependency_and_attention(self):
        response = analyze(payload(*delay_pair(), focus_task_ids=["B"]))
        observed = facts(response)
        self.assertEqual(observed["comparison:task_change:A"]["finish_delta_days"], 3)
        self.assertEqual(observed["comparison:task_change:B"]["start_delta_days"], 3)
        self.assertEqual(observed["comparison:schedule_change"]["moved_count"], 2)
        self.assertLessEqual({"proposal:dependency:A:B", "comparison:task_change:B"},
                             set(observed["proposal:attention:B"]["evidence_fact_ids"]))
        edge = observed["proposal:dependency:A:B"]
        self.assertTrue(edge["tight"])
        self.assertEqual(edge["prerequisite_end_date_exclusive"], edge["successor_start_date"])
        explanation = next(item for item in response.possible_explanations if item.id.startswith("tight_after_move:"))
        self.assertEqual(explanation.fact_ids, ["proposal:dependency:A:B", "comparison:task_change:A"])
        self.assertIn("có thể", explanation.text)
        duration_explanation = next(item for item in response.possible_explanations
                                    if item.id.startswith("scheduled_duration_change:"))
        self.assertEqual(duration_explanation.fact_ids, ["comparison:task_change:A", "proposal:task:A"])
        self.assertIn("tăng 3 ngày", duration_explanation.text)
        self.assertTrue(set(observed) >= set(response.basis.highlighted_fact_ids))

    def test_independent_parallel_tasks(self):
        proposal = snapshot("p", [task(), task("B", 1, "other")], [interval(), interval("B", 0, 1)])
        result = facts(analyze(payload(proposal=proposal)))
        self.assertEqual(result["proposal:parallel:A:B"]["overlap_end_date_exclusive"], "2026-02-28")
        self.assertFalse(any(":dependency:" in fact_id or ":attention:" in fact_id for fact_id in result))

    def test_shared_assignee_and_observed_wait(self):
        proposal = snapshot("p", [task(), task("B", 1)], [interval(), interval("B", 2, 3, queue_wait_days=2)])
        response = analyze(payload(proposal=proposal))
        observed = facts(response)
        self.assertEqual(observed["proposal:shared_assignee:member-secret"]["scheduled_order"], ["A", "B"])
        self.assertEqual(observed["proposal:wait:B"], {
            "ready_date": "2026-02-27", "start_date": "2026-03-01", "days": 2,
            "same_assignee_work_during_wait": ["A"],
        })
        self.assertTrue(any(item.id.startswith("shared_capacity:") for item in response.possible_explanations))
        self.assertTrue(any(item.id.startswith("review_assignment:") for item in response.suggestions))

    def test_wait_without_assignee_overlap_stays_an_observation(self):
        proposal = snapshot("p", [task()], [interval(start=2, end=4)], status="FEASIBLE")
        response = analyze(payload(proposal=proposal))
        self.assertEqual(facts(response)["proposal:wait:A"]["days"], 2)
        self.assertFalse(any(item.id.startswith("shared_capacity:") for item in response.possible_explanations))

    def test_kanban_done_without_confirmed_progress_is_still_a_planned_interval(self):
        response = analyze(payload(proposal=snapshot("p", [task(status="Done")])))
        self.assertIsNone(facts(response)["proposal:task:A"]["actual_finish_date"])
        self.assertIsNone(facts(response)["proposal:task:A"]["remaining_duration"])
        self.assertEqual(facts(response)["proposal:schedule"]["completion_kind"], "scheduled")
        self.assertIn("missing_confirmed_progress", [item.code for item in response.unknowns])

    def test_only_accepted_schedule(self):
        response = analyze(payload(accepted=snapshot()))
        self.assertEqual(response.basis.selected_role, "accepted")
        self.assertEqual(response.basis.comparison, "single_schedule")
        self.assertIn("missing_proposal", [item.code for item in response.unknowns])
        self.assertIn("accepted:schedule", facts(response))

    def test_only_initial_proposal(self):
        response = analyze(payload(proposal=snapshot("p")))
        self.assertEqual(response.basis.selected_role, "proposal")
        self.assertIsNone(response.basis.accepted_ref)
        self.assertIn("missing_accepted", [item.code for item in response.unknowns])
        self.assertIn("proposal:schedule", facts(response))

    def test_no_schedule(self):
        response = analyze(payload())
        self.assertEqual(response.basis.comparison, "no_schedule")
        self.assertEqual(response.facts, [])
        self.assertEqual({item.code for item in response.unknowns}, {"missing_accepted", "missing_proposal"})

    def test_completed_project_uses_latest_actual_and_zero_horizon(self):
        response = analyze(payload(proposal=completed_snapshot()))
        observed = facts(response)
        self.assertEqual(observed["proposal:schedule"]["completion_kind"], "actual")
        self.assertEqual(observed["proposal:progress"]["remaining_horizon_days"], 0)
        self.assertEqual(observed["proposal:schedule"]["final_work_date"], "2026-02-28")
        self.assertEqual(observed["proposal:task:A"]["estimated_duration"], 2)
        self.assertEqual(observed["proposal:task:A"]["actual_finish_date"], "2026-02-27")
        self.assertIsNone(observed["proposal:task:A"]["scheduled_duration"])
        self.assertEqual(response.suggestions, [])

    def test_progress_remaining_differs_from_estimate_and_completion_is_not_removal(self):
        before = snapshot(tasks=[task(), task("B", 4, "other", ("A",))],
                          scheduled=[interval(), interval("B", 2, 6)], deadline="2026-03-02")
        after = snapshot("p", before["tasks"], [interval("B", 3, 4)], deadline="2026-03-02",
                         progress={"progress_as_of_date": "2026-03-01",
                                   "actual_finishes": {"A": "2026-02-28"}, "remaining_durations": {"B": 1}})
        response = analyze(payload(before, after))
        observed = facts(response)
        self.assertEqual(observed["proposal:progress"]["replanning_start_date"], "2026-03-02")
        self.assertEqual(observed["proposal:task:B"]["estimated_duration"], 4)
        self.assertEqual(observed["proposal:task:B"]["remaining_duration"], 1)
        self.assertEqual(observed["proposal:task:B"]["scheduled_duration"], 1)
        self.assertTrue(observed["comparison:task_change:A"]["newly_confirmed"])
        self.assertTrue(observed["comparison:task_change:A"]["present_in_proposal"])
        self.assertIsNone(observed["comparison:task_change:A"]["finish_delta_days"])
        self.assertTrue(observed["comparison:task_change:B"]["prior_start_before_replanning"])
        self.assertEqual(observed["proposal:dependency:A:B"]["prerequisite_end_kind"], "actual")
        self.assertFalse(observed["proposal:dependency:A:B"]["tight"])
        self.assertTrue(any(item.id.startswith("replanning_boundary:") for item in response.possible_explanations))
        self.assertTrue(any("Khoảng mới dùng số ngày còn lại đã xác nhận" in item.text
                            for item in response.possible_explanations))

    def test_no_schedule_changes_and_stable_fact_ids(self):
        before, after = snapshot(), snapshot("p")
        before["tasks"][0]["status"] = "Done"
        response = analyze(payload(before, after))
        self.assertTrue(facts(response)["comparison:schedule_change"]["no_changes"])
        self.assertEqual(facts(response)["comparison:schedule_change"]["unchanged_interval_count"], 1)
        after["calendar"]["project_start_date"] = "2026-02-28"
        shifted = facts(analyze(payload(before, after)))
        self.assertFalse(shifted["comparison:schedule_change"]["no_changes"])
        self.assertEqual(shifted["comparison:schedule_change"]["project_start_delta_days"], 1)
        self.assertEqual(shifted["comparison:task_change:A"]["finish_delta_days"], 1)
        self.assertEqual(set(facts(response)), set(shifted) - {"proposal:attention:A"})

    def test_inconsistent_snapshots_are_rejected(self):
        for change in ({"project_ref": "other"}, {"snapshot_ref": "a"}, {"scheduled_tasks": [interval(end=3)]},
                       {"scheduled_tasks": [interval(earliest_ready_day=1)]}, {"scheduled_tasks": [interval(end=9_000_000)]},
                       {"scheduled_tasks": [interval("missing")]}, {"scheduled_tasks": []},
                       {"scheduled_tasks": [interval(), interval()]}, {"tasks": [task(), task()]},
                       {"tasks": [task(), task("B")], "scheduled_tasks": [interval(), interval("B")]}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                analyze(payload(snapshot(), {**snapshot("p"), **change}))

    def test_incompatible_confirmed_completion_dates_are_rejected(self):
        before = completed_snapshot()
        before["snapshot_ref"] = "a"
        after = completed_snapshot()
        after["progress"]["actual_finishes"]["B"] = "2026-03-01"
        with self.assertRaisesRegex(ValidationError, "ngày hoàn thành thực tế khác nhau"):
            analyze(payload(before, after))
        with self.assertRaisesRegex(ValidationError, "công việc đã xác nhận hoàn thành"):
            analyze(payload(before, snapshot("p")))

    def test_invalid_dependency_reference_and_cycle_are_rejected(self):
        for tasks in ([task(dependencies=["ghost"])], [task(dependencies=["B"]), task("B", dependencies=["A"])]):
            with self.subTest(tasks=tasks), self.assertRaises(ValidationError):
                analyze(payload(proposal=snapshot("p", tasks)))

    def test_duplicate_historical_edges_are_normalized_without_mutating_either_snapshot(self):
        before, after = delay_pair()
        before["tasks"][1]["dependencies"] = ["A", "A"]
        raw = payload(before, after)
        original = copy.deepcopy(raw)
        request = RecoveryRequest.model_validate(raw)
        self.assertEqual(request.accepted.tasks[1].dependencies, ["A"])
        validated = request.model_copy(deep=True)
        response = analyze_recovery(request, question_focus(request))
        self.assertEqual(raw, original)
        self.assertEqual(request, validated)
        self.assertEqual([fact.id for fact in response.facts if fact.kind == "dependency"],
                         ["accepted:dependency:A:B", "proposal:dependency:A:B"])

    def test_all_input_objects_unchanged_and_advice_is_grounded(self):
        raw = payload(*delay_pair(), focus_task_ids=["A", "missing"])
        raw_before = copy.deepcopy(raw)
        validated = RecoveryRequest.model_validate(raw)
        validated_before = validated.model_copy(deep=True)
        response = analyze_recovery(validated, question_focus(validated))
        self.assertEqual(raw, raw_before)
        self.assertEqual(validated, validated_before)
        self.assertEqual(response.context_ref, raw["context_ref"])
        for item in response.possible_explanations + response.suggestions:
            self.assertTrue(item.fact_ids)
            self.assertLessEqual(set(item.fact_ids), facts(response).keys())
            self.assertLessEqual(set(item.task_ids), {"A", "B"})
        self.assertTrue(all(item.status == "unverified" for item in response.suggestions))

    def test_unknown_infeasible_and_invalid_input_remain_distinct(self):
        messages = {}
        for status in ("UNKNOWN", "INFEASIBLE", "INVALID_INPUT", "MODEL_INVALID"):
            proposal = snapshot("p", [], [], status=status)
            response = analyze(payload(snapshot(), proposal))
            self.assertEqual(response.basis.selected_role, "accepted")
            self.assertEqual(facts(response)["proposal:solver_status"]["status"], status)
            self.assertNotIn("proposal:deadline", facts(response))
            self.assertNotIn("comparison:schedule_change", facts(response))
            messages[status] = response.possible_explanations[0].text
        self.assertEqual(len(set(messages.values())), 4)
        self.assertIn("chưa cung cấp", messages["UNKNOWN"])
        self.assertIn("đã xác định", messages["INFEASIBLE"])
        self.assertIn("đầu vào", messages["INVALID_INPUT"])

    def test_feasible_optimal_and_actual_deadline_claims(self):
        for status, assessment in (("FEASIBLE", "available_solution_late"), ("OPTIMAL", "reported_optimal_late")):
            with self.subTest(status=status):
                response = analyze(payload(*delay_pair(status)))
                self.assertEqual(facts(response)["proposal:deadline"]["assessment"], assessment)
                explanation = next(item.text for item in response.possible_explanations if item.id.startswith("late_finish:"))
                self.assertEqual("ngày sớm nhất" in explanation, status == "OPTIMAL")
                if status == "OPTIMAL":
                    self.assertIn("Nếu trạng thái OPTIMAL đến từ CP-SAT", explanation)
        completed = completed_snapshot()
        completed["calendar"]["target_deadline_date"] = "2026-02-27"
        self.assertEqual(facts(analyze(payload(proposal=completed)))["proposal:deadline"]["assessment"], "actual_late")


class RecoveryApiTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.http = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"),
        )
        self.key = self.enterContext(patch("api._get_gemini_api_key", return_value="fake-api-key"))
        self.client = self.enterContext(patch("recovery_api.genai.Client"))
        provider = self.client.return_value.__enter__.return_value.aio.__aenter__.return_value
        self.generate = AsyncMock()
        provider.models.generate_content = self.generate
        self.enterContext(patch("api.solve_schedule", side_effect=AssertionError("Recovery invoked solver")))
        self.enterContext(patch("api.reschedule_project", side_effect=AssertionError("Recovery invoked rescheduling")))

    async def post(self, body, status=200):
        response = await self.http.post("/api/recovery/explain", json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    async def fallback(self, ai_status):
        body = payload(*delay_pair())
        baseline = analyze(body).model_dump(mode="json")
        response = await self.post(body)
        self.assertEqual(response, {**baseline, "ai_status": ai_status})

    async def test_missing_api_key_keeps_deterministic_result(self):
        self.key.return_value = ""
        await self.fallback("missing_key")
        self.client.assert_not_called()

    async def test_direct_questions_completed_projects_and_no_change_skip_gemini(self):
        for data in (payload(*delay_pair(), question="Dự án trễ bao nhiêu ngày?", context_ref="response-ref"),
                     payload(*delay_pair(), question="Khi nào dự án hoàn thành?"),
                     payload(*delay_pair(), question="Những công việc nào bị dời?", intent="changes"),
                     payload(proposal=completed_snapshot()), payload(snapshot(), snapshot("p")), payload(),
                     payload(snapshot(), snapshot("p", [], [], status="UNKNOWN"))):
            response = await self.post(data)
            self.assertEqual(response["context_ref"], data["context_ref"])
            self.assertEqual(response["ai_status"], "skipped")
        self.key.assert_not_called()
        self.generate.assert_not_awaited()

    async def test_provider_503_504_and_non_retryable_errors_preserve_facts(self):
        for code, ai_status in ((503, "unavailable"), (504, "timeout"), (401, "unavailable"),
                                (403, "unavailable"), (429, "unavailable")):
            with self.subTest(code=code):
                self.generate.reset_mock()
                self.generate.side_effect = ServerError(code, {"message": "fake-api-key"})
                await self.fallback(ai_status)
                self.generate.assert_awaited_once()
                self.assertEqual(self.client.call_args.kwargs["http_options"].retry_options.attempts, 1)

    async def test_local_timeout_cancels_mock_and_returns_facts(self):
        cancelled = asyncio.Event()

        async def slow(**kwargs):
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()

        self.generate.side_effect = slow
        with patch("recovery_api.AI_TIMEOUT_SECONDS", 0.03):
            await self.fallback("timeout")
        self.generate.assert_awaited_once()
        self.assertTrue(cancelled.is_set())

    async def test_invalid_gemini_json_and_schema(self):
        for output in ("{", '[]', '{"highlights": []}', '{"highlights": [], "explanation_ids": [], '
                       '"suggestion_ids": [], "text": "unverified free text"}'):
            with self.subTest(output=output):
                self.generate.return_value = SimpleNamespace(text=output, candidates=[])
                await self.fallback("invalid_output")

    async def test_unknown_fact_candidate_and_task_references(self):
        for bad in ("fact", "task", "candidate", "mismatched_task"):
            async def fake(**kwargs):
                context = json.loads(kwargs["contents"])
                fact_id = next(alias for alias, fact in context["facts"].items() if fact["task_ids"] == ["t1"])
                chosen = {"highlights": [{
                    "fact_id": "f999" if bad == "fact" else fact_id,
                    "task_ids": ["t999" if bad == "task" else "t2" if bad == "mismatched_task" else "t1"],
                }], "explanation_ids": ["e999"] if bad == "candidate" else [], "suggestion_ids": []}
                return SimpleNamespace(text=json.dumps(chosen), candidates=[])

            with self.subTest(bad=bad):
                self.generate.side_effect = fake
                await self.fallback("invalid_output")

    async def test_valid_selection_only_prioritizes_grounded_server_content(self):
        async def fake(**kwargs):
            serialized = kwargs["contents"]
            self.assertEqual(kwargs["model"], "gemini-3.6-flash")
            for hidden in ("fake-api-key", "Tên dữ liệu riêng", "private question detail", "member-secret",
                           "local-project", "local-context", "proposal:task:A"):
                self.assertNotIn(hidden, serialized)
            context = json.loads(serialized)
            self.assertIn("causes", context["question_topics"])
            self.assertEqual(context["focus_task_ids"], ["t2"])
            alias = next(key for key, fact in context["facts"].items() if fact["kind"] == "dependency")
            self.assertLessEqual(len(context["facts"]), 30)
            return SimpleNamespace(candidates=[], text=json.dumps({
                "highlights": [{"fact_id": alias, "task_ids": context["facts"][alias]["task_ids"]}],
                "explanation_ids": list(context["explanations"])[-1:],
                "suggestion_ids": list(context["suggestions"])[-1:],
            }))

        self.generate.side_effect = fake
        data = payload(*delay_pair(), question="Vì sao B bị trễ? private question detail", focus_task_ids=["B"])
        with patch.dict("os.environ", {"GEMINI_DRAFT_MODEL": ""}):
            response = await self.post(data)
        self.assertEqual(response["ai_status"], "used")
        self.assertEqual(response["basis"]["highlighted_fact_ids"][0], "proposal:dependency:A:B")
        self.assertEqual(response["facts"], analyze(data).model_dump(mode="json")["facts"])
        self.assertEqual(response["suggestions"][0]["status"], "unverified")

    async def test_invalid_snapshots_get_422_without_echoing_body(self):
        body = payload(snapshot(), snapshot("p", scheduled=[interval(end=3)]), question="private question")
        response = await self.post(body, status=422)
        self.assertIn("detail", response)
        self.assertNotIn("private question", json.dumps(response))
        self.assertNotIn('"input"', json.dumps(response))
        self.client.assert_not_called()

    async def test_duplicate_edges_do_not_hide_invalid_recovery_dependencies(self):
        for edges, message in (
            (["ghost", "ghost"], "không tồn tại"),
            (["B", "B"], "không thể tự phụ thuộc"),
            (["A", "A"], "Cycle"),
            ([1, 1], "Input should be a valid string"),
            ([" ", " "], "String should match pattern"),
        ):
            with self.subTest(edges=edges):
                before, _ = delay_pair()
                before["tasks"][1]["dependencies"] = edges
                if message == "Cycle":
                    before["tasks"][0]["dependencies"] = ["B"]
                response = await self.post(payload(proposal=before, intent="dependencies"), status=422)
                self.assertTrue(any(message in issue["msg"] for issue in response["detail"]), response)
        self.client.assert_not_called()

    async def test_installed_sdk_sends_structured_selection_request_over_mock_transport(self):
        calls = []

        def provider(request):
            wire = json.loads(request.content)
            calls.append(wire)
            context = json.loads(wire["contents"][0]["parts"][0]["text"])
            chosen = {"highlights": [], "explanation_ids": [], "suggestion_ids": list(context["suggestions"])[:1]}
            return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {
                "role": "model", "parts": [{"text": json.dumps(chosen)}],
            }}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as transport:
            def make_client(**options):
                self.assertEqual(options["http_options"].timeout, 8000)
                self.assertEqual(options["http_options"].retry_options.attempts, 1)
                options["http_options"].httpx_async_client = transport
                return GeminiClient(**options)

            self.client.side_effect = make_client
            response = await self.post(payload(*delay_pair()))

        self.assertEqual(response["ai_status"], "used")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["generationConfig"]["responseMimeType"], "application/json")
        self.assertEqual(calls[0]["generationConfig"]["responseJsonSchema"]["properties"]["highlights"]["maxItems"], 8)
