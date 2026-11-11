import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from ortools.sat.python import cp_model

from api import app
from models import KanbanConfig, ProjectMember, SchedulingIR, Task
from solver import solve_schedule


def member_project() -> SchedulingIR:
    return SchedulingIR(
        project_name="Member scheduling",
        team_capacity=2,
        kanban_config=KanbanConfig(stages=["Build"], wip_limits={"Build": 1}),
        members=[ProjectMember(id="alex", name="Alex"), ProjectMember(id="sam", name="Sam")],
        tasks=[
            Task(id="T1", name="Build A", duration=3, kanban_stage="Build", assignee_id="alex"),
            Task(id="T2", name="Build B", duration=2, kanban_stage="Build", assignee_id="sam"),
        ],
    )


def unassigned_project() -> SchedulingIR:
    ir = member_project()
    ir.members = []
    for task in ir.tasks:
        task.assignee_id = None
    return ir


class MemberSchedulingTests(unittest.TestCase):
    def test_same_member_tasks_cannot_overlap_across_categories(self):
        ir = member_project()
        ir.tasks[1].assignee_id = "alex"
        ir.tasks[1].category = "Review"
        ir.tasks[1].kanban_stage = "Review"
        ir.tasks[1].status = "Done"

        result = solve_schedule(ir)

        self.assertEqual((result.scheduling_mode, result.status, result.makespan), ("member", "OPTIMAL", 5))
        first, second = sorted(result.scheduled_tasks, key=lambda task: task.start_day)
        self.assertLessEqual(first.end_day, second.start_day)
        self.assertEqual([first.assignee_id, second.assignee_id], ["alex", "alex"])

    def test_different_members_can_overlap_regardless_of_legacy_capacity_and_doing_status(self):
        ir = member_project()
        ir.team_capacity = 1
        for task in ir.tasks:
            task.status = "Doing"

        for wip_limit in (1, 2, 0, 99):
            with self.subTest(wip_limit=wip_limit):
                ir.kanban_config.wip_limits["Build"] = wip_limit
                result = solve_schedule(ir, scheduling_mode="member")
                self.assertEqual((result.status, result.makespan), ("OPTIMAL", 3))
                self.assertEqual([task.start_day for task in result.scheduled_tasks], [0, 0])
                self.assertEqual([task.assignee_id for task in result.scheduled_tasks], ["alex", "sam"])
                self.assertEqual(result.stage_metrics, [])
                self.assertEqual(result.bottleneck_stages, [])

    def test_minimizes_makespan_with_member_capacity_and_dependencies(self):
        ir = member_project()
        ir.tasks[1].assignee_id = "alex"
        ir.tasks.extend([
            Task(id="T3", name="Test B", duration=4, dependencies=["T2"],
                 kanban_stage="Build", assignee_id="sam"),
            Task(id="T4", name="Release", duration=1, dependencies=["T1", "T3"],
                 kanban_stage="Build", assignee_id="sam"),
        ])

        result = solve_schedule(ir)

        self.assertEqual((result.status, result.makespan), ("OPTIMAL", 7))
        tasks = {task.id: task for task in result.scheduled_tasks}
        self.assertLessEqual(tasks["T2"].end_day, tasks["T1"].start_day)
        for task in tasks.values():
            self.assertEqual(task.end_day - task.start_day, task.duration)
            ready_day = max((tasks[dep].end_day for dep in task.dependencies), default=0)
            self.assertLessEqual(ready_day, task.start_day)
            self.assertEqual(task.earliest_ready_day, ready_day)
        self.assertEqual(result.makespan, max(task.end_day for task in tasks.values()))

    def test_rejects_missing_and_unknown_assignees_before_constructing_model(self):
        ir = member_project()
        ir.tasks[0].assignee_id = None
        ir.tasks[1].assignee_id = "missing-member"

        with patch("solver.cp_model.CpModel") as model:
            result = solve_schedule(ir)

        model.assert_not_called()
        self.assertEqual((result.scheduling_mode, result.status), ("member", "INVALID_INPUT"))
        self.assertEqual(result.scheduled_tasks, [])
        self.assertEqual(len(result.errors), 2)
        self.assertIn("'T1' chưa được phân công", result.errors[0])
        self.assertIn("'T2' được giao cho ID 'missing-member'", result.errors[1])
        self.assertEqual([task.assignee_id for task in ir.tasks], [None, "missing-member"])

    def test_keeps_feasible_solution_when_optimality_is_unproven(self):
        real_solve = cp_model.CpSolver.Solve

        def solve_as_feasible(solver, model):
            self.assertEqual(real_solve(solver, model), cp_model.OPTIMAL)
            return cp_model.FEASIBLE

        with patch.object(cp_model.CpSolver, "Solve", solve_as_feasible):
            result = solve_schedule(member_project())

        self.assertEqual((result.status, result.makespan), ("FEASIBLE", 3))
        self.assertEqual(len(result.scheduled_tasks), 2)
        self.assertEqual(result.errors, [])

    def test_solver_failures_preserve_status_and_do_not_read_solution(self):
        for solver_status in (cp_model.UNKNOWN, cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
            with self.subTest(status=solver_status):
                with (
                    patch.object(cp_model.CpSolver, "Solve", return_value=solver_status),
                    patch.object(cp_model.CpSolver, "Value") as value,
                ):
                    result = solve_schedule(member_project())
                value.assert_not_called()
                self.assertEqual((result.status, result.makespan), (solver_status.name, 0))
                self.assertEqual(result.scheduled_tasks, [])
                self.assertTrue(result.errors)
                if solver_status == cp_model.UNKNOWN:
                    self.assertIn("tăng thời gian giải", result.errors[0])


class SchedulingApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_explicit_member_mode_accepts_both_payload_shapes_and_skips_legacy_what_if(self):
        ir = member_project()
        ir.tasks[1].assignee_id = "alex"
        body = ir.model_dump()
        options = {"scheduling_mode": "member", "target_deadline": 3}
        for payload in ({"ir": body, **options}, {**body, **options}):
            with self.subTest(wrapped="ir" in payload):
                with patch("api.solve_schedule", wraps=solve_schedule) as solve:
                    response = await self.client.post("/api/solve", json=payload)
                solve.assert_called_once()
                data = response.raise_for_status().json()
                result = data["result"]
                self.assertEqual((result["scheduling_mode"], result["status"], result["makespan"]),
                                 ("member", "OPTIMAL", 5))
                self.assertEqual([task["assignee_id"] for task in result["scheduled_tasks"]], ["alex", "alex"])
                self.assertEqual(data["rescue_suggestions"], [])

    async def test_member_intent_never_falls_back_when_assignments_are_missing(self):
        draft = unassigned_project().model_dump()
        roster_only = {**draft, "members": [{"id": "alex", "name": "Alex"}]}
        partial = member_project().model_dump()
        partial["tasks"][1]["assignee_id"] = None

        for payload in (
            {"ir": draft, "scheduling_mode": "member"},
            {**draft, "scheduling_mode": "member"},
            roster_only,
            partial,
        ):
            with self.subTest(payload=payload):
                response = await self.client.post("/api/solve", json=payload)
                result = response.raise_for_status().json()["result"]
                self.assertEqual((result["scheduling_mode"], result["status"]), ("member", "INVALID_INPUT"))
                self.assertIn("'T2' chưa được phân công", " ".join(result["errors"]))
                self.assertEqual(result["scheduled_tasks"], [])

    async def test_invalid_assignment_matches_strict_validation(self):
        body = member_project().model_dump()
        body["members"] = []
        response = await self.client.post("/api/validate?require_assignments=true", json=body)
        validation = response.raise_for_status().json()
        response = await self.client.post("/api/solve", json=body)
        result = response.raise_for_status().json()["result"]
        self.assertFalse(validation["valid"])
        self.assertEqual((result["scheduling_mode"], result["status"]), ("member", "INVALID_INPUT"))
        self.assertEqual(result["errors"], validation["errors"])
        self.assertIn("'T1' được giao cho ID 'alex'", result["errors"][0])

    async def test_strict_validation_ignores_legacy_wip_rules(self):
        body = member_project().model_dump()
        body["kanban_config"]["wip_limits"]["Build"] = 0
        response = await self.client.post("/api/validate?require_assignments=true", json=body)
        self.assertEqual(response.raise_for_status().json(), {"valid": True, "errors": []})
        response = await self.client.post("/api/validate", json=body)
        self.assertFalse(response.raise_for_status().json()["valid"])

    async def test_legacy_solve_retains_wip_and_deadline_simulations(self):
        draft = unassigned_project().model_dump(exclude={"members"})
        for task in draft["tasks"]:
            del task["assignee_id"]
        response = await self.client.post("/api/solve", json={**draft, "target_deadline": 3})
        data = response.raise_for_status().json()
        result = data["result"]
        self.assertEqual((result["scheduling_mode"], result["status"], result["makespan"]), ("legacy", "OPTIMAL", 5))
        self.assertEqual(result["bottleneck_stages"], ["Build"])
        self.assertIn("Tăng WIP cột 'Build' từ 1 lên 2", data["rescue_suggestions"][0])
        self.assertTrue(all(task["assignee_id"] is None for task in result["scheduled_tasks"]))

    async def test_all_presets_can_follow_the_existing_react_auto_solve_flow(self):
        presets = (await self.client.get("/api/presets")).raise_for_status().json()
        for name, ir in presets.items():
            with self.subTest(preset=name):
                response = await self.client.post("/api/solve", json={"ir": ir})
                result = response.raise_for_status().json()["result"]
                self.assertEqual(result["scheduling_mode"], "legacy")
                self.assertEqual(result["status"], "INVALID_INPUT" if "DAG Cycle" in name else "OPTIMAL")

    async def test_gemini_draft_can_follow_the_existing_react_auto_solve_flow(self):
        draft = unassigned_project().model_dump()
        with patch("parser.genai.Client") as gemini:
            gemini.return_value.models.generate_content.return_value = SimpleNamespace(text=json.dumps(draft))
            parsed = await self.client.post("/api/parse", json={"prompt": "Build A and B", "api_key": "test-key"})
        response = await self.client.post("/api/solve", json={"ir": parsed.raise_for_status().json()})
        result = response.raise_for_status().json()["result"]
        self.assertEqual((result["scheduling_mode"], result["status"], result["makespan"]), ("legacy", "OPTIMAL", 5))
