from datetime import date
import unittest
from unittest.mock import patch

import httpx
from ortools.sat.python import cp_model

from api import app
from models import KanbanConfig, ProgressSnapshot, ProjectMember, SchedulingIR, Task
from project_calendar import ProjectCalendar, calendar_finish, date_at_offset, day_offset
from solver import reschedule_project, solve_schedule


START = date(2026, 11, 12)
CALENDAR = ProjectCalendar(project_start_date=START, target_deadline_date=date(2026, 12, 11))


def task(id, duration, assignee="mai", *, depends=(), status="To Do"):
    return Task(id=id, name=f"Work {id}", duration=duration, dependencies=list(depends),
                kanban_stage="Build", assignee_id=assignee, status=status)


def project(*tasks):
    return SchedulingIR(project_name="T4 test", team_capacity=1,
                        kanban_config=KanbanConfig(stages=["Build"], wip_limits={"Build": 1}),
                        members=[ProjectMember(id="mai", name="Mai"), ProjectMember(id="an", name="An")],
                        tasks=list(tasks))


def snapshot(as_of="2026-11-14", **progress):
    return ProgressSnapshot.model_validate({"progress_as_of_date": as_of, "task_progress": progress})


class DateTests(unittest.TestCase):
    def test_d1_project_offsets(self):
        for day, offset in [(START, 0), (date(2026, 11, 17), 5), (date(2026, 12, 11), 29)]:
            self.assertEqual(day_offset(START, day), offset)
            self.assertEqual(date_at_offset(START, offset), day)

    def test_d3_inclusive_deadline(self):
        on_time = calendar_finish(CALENDAR, 30)
        self.assertEqual(on_time.project_finish_date_exclusive, date(2026, 12, 12))
        self.assertEqual((on_time.deadline_status, on_time.days_late), ("on_time", 0))
        late = calendar_finish(CALENDAR, 31)
        self.assertEqual((late.deadline_status, late.days_late), ("late", 1))

    def test_d4_cross_month_and_year(self):
        start, finish = date(2026, 12, 31), date(2027, 1, 2)
        self.assertEqual(date_at_offset(start, 2), finish)
        self.assertEqual(day_offset(start, finish), 2)

    def test_d5_leap_year(self):
        start = date(2028, 2, 28)
        self.assertEqual(date_at_offset(start, 1), date(2028, 2, 29))
        self.assertEqual(day_offset(start, date(2028, 3, 1)), 2)


class RescheduleTests(unittest.TestCase):
    def test_d6_report_is_end_of_day(self):
        ir = project(task("A", 3, status="Done"), task("B", 2, depends=("A",)))
        result = reschedule_project(ir, CALENDAR, snapshot("2026-11-17", A={"actual_finish_date": "2026-11-17"}))
        self.assertEqual((result.replanning_start_day, result.replanning_start_date), (6, date(2026, 11, 18)))
        self.assertEqual(result.scheduled_tasks[0].start_day, 6)
        self.assertEqual(result.completed_tasks[0].actual_end_day_exclusive, 6)

    def test_r1_initial_schedule_still_uses_original_durations(self):
        result = solve_schedule(project(task("A", 3), task("B", 2, depends=("A",))))
        self.assertEqual((result.status, result.makespan), ("OPTIMAL", 5))
        self.assertEqual([(t.start_day, t.end_day) for t in result.scheduled_tasks], [(0, 3), (3, 5)])

    def test_r2_completed_predecessor_is_history_only(self):
        ir = project(task("A", 3, status="Done"), task("B", 2, depends=("A",)))
        result = reschedule_project(ir, CALENDAR, snapshot(A={"actual_finish_date": "2026-11-14"}))
        self.assertEqual(result.status, "OPTIMAL")
        self.assertEqual(result.replanning_start_date, date(2026, 11, 15))
        b, = result.scheduled_tasks
        self.assertEqual((b.id, b.start_day, b.end_day), ("B", 3, 5))
        self.assertEqual((b.start_date, b.final_work_date), (date(2026, 11, 15), date(2026, 11, 16)))
        self.assertEqual(result.completed_tasks[0].id, "A")

    def test_r3_doing_uses_remaining_work_without_changing_estimate(self):
        ir = project(task("A", 3, status="Done"), task("B", 2, depends=("A",), status="Doing"))
        before = ir.model_dump()
        progress = snapshot(A={"actual_finish_date": "2026-11-14"}, B={"remaining_duration": 4})
        result = reschedule_project(ir, CALENDAR, progress)
        self.assertEqual(result.remaining_horizon_days, 4)
        self.assertEqual(result.project_finish_day_exclusive, 7)
        self.assertEqual(result.scheduled_tasks[0].duration, 4)
        self.assertEqual(ir.model_dump(), before)

    def test_r4_same_member_has_no_overlap(self):
        result = reschedule_project(project(task("A", 3), task("B", 3)), CALENDAR, snapshot())
        first, second = sorted(result.scheduled_tasks, key=lambda t: t.start_day)
        self.assertLessEqual(first.end_day, second.start_day)
        self.assertEqual(result.remaining_horizon_days, 6)

    def test_r5_different_members_can_run_in_parallel(self):
        result = reschedule_project(project(task("A", 3), task("B", 3, "an")), CALENDAR, snapshot())
        self.assertEqual([t.start_day for t in result.scheduled_tasks], [3, 3])
        self.assertEqual(result.remaining_horizon_days, 3)

    def test_r6_reoptimizes_precedence_and_resource_order(self):
        ir = project(task("A", 2, status="Doing"), task("B", 2, "an", depends=("A",)),
                     task("C", 4), task("D", 5, "an", depends=("C",)))
        short = reschedule_project(ir, CALENDAR, snapshot(A={"remaining_duration": 1}))
        long = reschedule_project(ir, CALENDAR, snapshot(A={"remaining_duration": 7}))
        short_tasks = {t.id: t for t in short.scheduled_tasks}
        long_tasks = {t.id: t for t in long.scheduled_tasks}
        self.assertLess(short_tasks["A"].start_day, short_tasks["C"].start_day)
        self.assertLess(long_tasks["C"].start_day, long_tasks["A"].start_day)
        self.assertEqual((short.remaining_horizon_days, long.remaining_horizon_days), (10, 13))
        for result, tasks in [(short, short_tasks), (long, long_tasks)]:
            self.assertEqual(result.status, "OPTIMAL")
            self.assertGreaterEqual(tasks["B"].start_day, tasks["A"].end_day)
            self.assertGreaterEqual(tasks["D"].start_day, tasks["C"].end_day)

    def test_r8_rejects_invalid_progress_without_calling_solver(self):
        cases = [
            (project(task("A", 3, status="Done")), snapshot(), "Nhập ngày hoàn thành"),
            (project(task("A", 3, status="Done")), snapshot(A={"actual_finish_date": "2026-11-15"}), "đến hết ngày báo cáo"),
            (project(task("A", 3, status="Done")), snapshot(A={"actual_finish_date": "2026-11-11"}), "từ ngày bắt đầu"),
            (project(task("A", 3, status="Doing")), snapshot(), "Nhập số ngày còn lại"),
            (project(task("A", 3), task("B", 2, depends=("A",), status="Done")), snapshot(B={"actual_finish_date": "2026-11-14"}), "cần công việc tiên quyết 'A'"),
            (project(task("A", 3), task("B", 2, depends=("A",), status="Doing")), snapshot(B={"remaining_duration": 1}), "cần công việc tiên quyết 'A'"),
            (project(task("A", 3, depends=("B",)), task("B", 2, depends=("A",))), snapshot(), "Cycle"),
            (project(task("A", 3, depends=("Z",))), snapshot(), "'Z'"),
            (project(task("A", 3, "missing")), snapshot(), "'missing'"),
            (project(task("A", 3, None)), snapshot(), "chưa được phân công"),
            (project(task("A", 3)), snapshot("2026-11-11"), "không được trước"),
            (project(task("A", 3)), snapshot(A={"actual_finish_date": "2026-11-14"}), "Chỉ công việc Done"),
            (project(task("A", 3)), snapshot(A={"remaining_duration": 2}), "Chỉ nhập số ngày"),
            (project(task("A", 3)), snapshot(Z={"remaining_duration": 2}), "'Z'"),
            (project(), snapshot(), "không được để rỗng"),
        ]
        with patch("solver.cp_model.CpModel") as model:
            for ir, progress, message in cases:
                with self.subTest(message=message):
                    result = reschedule_project(ir, CALENDAR, progress)
                    self.assertEqual((result.status, result.scheduled_tasks), ("INVALID_INPUT", []))
                    self.assertIn(message, " ".join(result.errors))
                    self.assertIsNone(result.project_finish_date_exclusive)
            model.assert_not_called()

    def test_completed_dependency_must_have_finished_on_an_earlier_day(self):
        ir = project(task("A", 3, status="Done"), task("B", 2, depends=("A",), status="Done"))
        for earlier in ("2026-11-14", "2026-11-15"):
            result = reschedule_project(ir, CALENDAR, snapshot("2026-11-16", A={"actual_finish_date": earlier},
                                                               B={"actual_finish_date": "2026-11-14"}))
            self.assertEqual(result.status, "INVALID_INPUT")
            self.assertIn("phải sau", " ".join(result.errors))

    def test_r9_all_done_preserves_same_day_independent_history_without_new_intervals(self):
        ir = project(task("A", 3, status="Done"), task("B", 2, status="Done"))
        progress = snapshot("2026-11-25", A={"actual_finish_date": "2026-11-14"}, B={"actual_finish_date": "2026-11-14"})
        with patch("solver.cp_model.CpModel") as model:
            result = reschedule_project(ir, CALENDAR, progress)
        model.assert_not_called()
        self.assertEqual((result.status, result.remaining_horizon_days, result.scheduled_tasks), ("OPTIMAL", 0, []))
        self.assertEqual([t.actual_finish_date for t in result.completed_tasks], [date(2026, 11, 14)] * 2)
        self.assertEqual((result.final_work_date, result.project_finish_date_exclusive), (date(2026, 11, 14), date(2026, 11, 15)))

    def test_solver_status_is_not_reinterpreted(self):
        ir = project(task("A", 3))
        for status in (cp_model.UNKNOWN, cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
            with self.subTest(status=status), patch.object(cp_model.CpSolver, "Solve", return_value=status):
                result = reschedule_project(ir, CALENDAR, snapshot())
                self.assertEqual((result.status, result.scheduled_tasks), (status.name, []))
                self.assertIsNone(result.remaining_horizon_days)
                self.assertIsNone(result.final_work_date)
        solve = cp_model.CpSolver.Solve

        def solve_as_feasible(solver, model):
            self.assertEqual(solve(solver, model), cp_model.OPTIMAL)
            return cp_model.FEASIBLE

        with patch.object(cp_model.CpSolver, "Solve", solve_as_feasible):
            result = reschedule_project(ir, CALENDAR, snapshot())
        self.assertEqual((result.status, len(result.scheduled_tasks)), ("FEASIBLE", 1))


class CalendarApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_d2_initial_solve_has_exclusive_end_and_inclusive_work_date(self):
        ir = project(task("A", 3)).model_dump(mode="json")
        body = {"calendar": CALENDAR.model_dump(mode="json"), "scheduling_mode": "member"}
        for payload in ({"ir": ir, **body}, {**ir, **body}):
            data = (await self.client.post("/api/solve", json=payload)).raise_for_status().json()
            a, = data["result"]["scheduled_tasks"]
            self.assertEqual((a["start_day"], a["end_day"]), (0, 3))
            self.assertEqual(data["calendar"]["final_work_date"], "2026-11-14")
            self.assertEqual(data["calendar"]["project_finish_date_exclusive"], "2026-11-15")

    async def test_late_reschedule_is_still_optimal_even_after_the_initial_plan(self):
        ir = project(task("A", 3)).model_dump(mode="json")
        progress = snapshot("2026-12-11").model_dump(mode="json")
        response = await self.client.post("/api/reschedule", json={"ir": ir, "calendar": CALENDAR.model_dump(mode="json"), "progress": progress})
        data = response.raise_for_status().json()
        self.assertEqual((data["status"], data["deadline_status"], data["days_late"]), ("OPTIMAL", "late", 3))
        self.assertEqual(data["scheduled_tasks"][0]["start_date"], "2026-12-12")
        self.assertEqual(data["remaining_horizon_days"], 3)
        self.assertEqual(data["completed_tasks"], [])

    async def test_invalid_progress_preview_matches_reschedule_errors(self):
        body = {"ir": project(task("A", 3, status="Done")).model_dump(mode="json"),
                "calendar": CALENDAR.model_dump(mode="json"), "progress": snapshot().model_dump(mode="json")}
        validation = (await self.client.post("/api/reschedule/validate", json=body)).raise_for_status().json()
        result = (await self.client.post("/api/reschedule", json=body)).raise_for_status().json()
        self.assertFalse(validation["valid"])
        self.assertEqual(result["status"], "INVALID_INPUT")
        self.assertEqual(result["errors"], validation["errors"])

    async def test_strict_calendar_and_duration_payloads(self):
        ir = project(task("A", 3, status="Doing")).model_dump(mode="json")
        calendar = CALENDAR.model_dump(mode="json")
        progress = {"progress_as_of_date": "2026-11-14", "task_progress": {"A": {"remaining_duration": 2}}}
        body = {"ir": ir, "calendar": calendar, "progress": progress}
        for calendar_override in ({}, {"project_start_date": "20261112"}, {"project_start_date": "2026-02-29"},
                                  {"project_start_date": "2026-11-12T00:00:00Z"}, {"project_start_date": 20261112},
                                  {**calendar, "target_deadline_date": "2026-11-11"}):
            with self.subTest(calendar=calendar_override):
                response = await self.client.post("/api/reschedule", json={**body, "calendar": calendar_override})
                self.assertEqual(response.status_code, 422)
        for duration in (0, -1, 2.5, "2", True):
            with self.subTest(duration=duration):
                response = await self.client.post("/api/reschedule", json={**body, "progress": {**progress,
                    "task_progress": {"A": {"remaining_duration": duration}}}})
                self.assertEqual(response.status_code, 422)
