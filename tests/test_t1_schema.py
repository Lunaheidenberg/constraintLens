import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from api import DEMO_SCENARIOS, app
from models import ProjectMember, SchedulingIR, Task
from parser import parse_kanban_prompt
from validator import validate_ir


def legacy_payload():
    return {
        "project_name": "Legacy project",
        "team_capacity": 2,
        "kanban_config": {"stages": ["Backend", "Testing"], "wip_limits": {"Backend": 2}},
        "tasks": [
            {"id": "T1", "name": "Build", "duration": 2, "kanban_stage": "Backend"},
            {"id": "T2", "name": "Verify", "duration": 1, "kanban_stage": "Testing"},
        ],
    }


class ModelAndValidationTests(unittest.TestCase):
    def test_legacy_defaults_and_round_trip(self):
        ir = SchedulingIR.model_validate(legacy_payload())
        self.assertEqual(ir.members, [])
        self.assertEqual([task.category for task in ir.tasks], ["Backend", "Testing"])
        for task in ir.tasks:
            self.assertEqual(task.status, "To Do")
            self.assertIsNone(task.assignee_id)
        self.assertEqual(validate_ir(ir), [])
        self.assertEqual(SchedulingIR.model_validate_json(ir.model_dump_json()), ir)

    def test_explicit_category_and_status_are_independent_of_legacy_stage(self):
        payload = legacy_payload()
        payload["tasks"][0].update(category="Security", status="Doing")
        payload["tasks"][1].update(status="Done")
        ir = SchedulingIR.model_validate(payload)
        self.assertEqual(ir.tasks[0].category, "Security")
        self.assertEqual(ir.tasks[0].kanban_stage, "Backend")
        self.assertEqual([task.status for task in ir.tasks], ["Doing", "Done"])
        self.assertEqual(validate_ir(ir), [])

    def test_invalid_status_and_duration(self):
        for field, value in [("status", "Backend"), ("duration", 0), ("duration", -1),
                             ("duration", 1.5), ("duration", True), ("duration", "2")]:
            with self.subTest(field=field, value=value):
                task = legacy_payload()["tasks"][0]
                task[field] = value
                with self.assertRaises(ValidationError) as caught:
                    Task.model_validate(task)
                self.assertEqual(caught.exception.errors()[0]["loc"], (field,))

    def test_invalid_member_ids(self):
        for member_id in ("", " ", "M 1", " M1", "M1 "):
            with self.subTest(member_id=member_id), self.assertRaises(ValidationError):
                ProjectMember(id=member_id, name="Alex")

    def test_assignment_readiness_is_opt_in(self):
        payload = legacy_payload()
        payload["members"] = [{"id": "M1", "name": "Alex"}]
        payload["tasks"][0]["assignee_id"] = "M1"
        ir = SchedulingIR.model_validate(payload)
        self.assertEqual(validate_ir(ir), [])
        errors = validate_ir(ir, require_assignments=True)
        self.assertEqual(len(errors), 1)
        self.assertIn("'T2' chưa được phân công", errors[0])
        ir.tasks[1].assignee_id = "M1"
        self.assertEqual(validate_ir(ir, require_assignments=True), [])

    def test_duplicate_members_and_unknown_assignee(self):
        payload = legacy_payload()
        payload["members"] = [{"id": "M1", "name": "Alex"}, {"id": "M1", "name": "Sam"}]
        payload["tasks"][0]["assignee_id"] = "M99"
        errors = validate_ir(SchedulingIR.model_validate(payload))
        self.assertEqual(len(errors), 2)
        self.assertTrue(any("'M1' bị trùng lặp" in error for error in errors))
        self.assertTrue(any("'T1'" in error and "'M99'" in error for error in errors))

    def test_legacy_dependency_and_task_id_checks(self):
        payload = legacy_payload()
        payload["tasks"][0]["dependencies"] = ["T1", "T2", "missing"]
        payload["tasks"][1]["dependencies"] = ["T1"]
        payload["tasks"].append(dict(payload["tasks"][1]))
        errors = validate_ir(SchedulingIR.model_validate(payload))
        for expected in ("'T2' bị trùng lặp", "tự phụ thuộc", "'missing'", "Cycle"):
            with self.subTest(expected=expected):
                self.assertTrue(any(expected in error for error in errors), errors)


class ParserDraftTests(unittest.TestCase):
    @patch("parser.genai.Client")
    def test_gemini_cannot_create_assignments_or_progress(self, client):
        payload = legacy_payload()
        payload["members"] = [{"id": "M1", "name": "Alex"}]
        payload["tasks"][0].update(assignee_id="M1", status="Done", category="Security")
        generate = client.return_value.models.generate_content
        generate.return_value = SimpleNamespace(text=json.dumps(payload))
        ir = parse_kanban_prompt("Build and verify", "test-key")
        self.assertEqual(ir.members, [])
        self.assertIsNone(ir.tasks[0].assignee_id)
        self.assertEqual(ir.tasks[0].status, "To Do")
        self.assertEqual(ir.tasks[0].category, "Security")
        schema = generate.call_args.kwargs["config"].response_schema
        self.assertNotIn("members", schema["properties"])
        task_fields = schema["properties"]["tasks"]["items"]["properties"]
        self.assertNotIn("assignee_id", task_fields)
        self.assertNotIn("status", task_fields)

    @patch("parser.genai.Client")
    def test_parser_preserves_structural_errors(self, client):
        client.return_value.models.generate_content.return_value = SimpleNamespace(text="{}")
        with self.assertRaises(ValidationError):
            parse_kanban_prompt("Build and verify", "test-key")


class ApiCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_presets_and_validation_modes(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            presets = (await client.get("/api/presets")).raise_for_status().json()
            self.assertEqual(list(presets), list(DEMO_SCENARIOS))
            for name, preset in presets.items():
                with self.subTest(preset=name):
                    self.assertEqual(preset["members"], [])
                    self.assertTrue(all(task["status"] == "To Do" for task in preset["tasks"]))
                    response = await client.post("/api/validate", json=preset)
                    self.assertEqual(response.raise_for_status().json()["valid"], "DAG" not in name)

            legacy = legacy_payload()
            strict = await client.post("/api/validate?require_assignments=true", json=legacy)
            self.assertFalse(strict.raise_for_status().json()["valid"])
            self.assertEqual(len(strict.json()["errors"]), 2)
            legacy["tasks"][0]["status"] = "Backend"
            invalid = await client.post("/api/validate", json=legacy)
            self.assertEqual(invalid.status_code, 422)
            self.assertEqual(invalid.json()["detail"][0]["loc"], ["body", "tasks", 0, "status"])

    async def test_legacy_and_member_solve_use_expected_capacity(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            legacy = legacy_payload()
            direct = await client.post("/api/solve", json=legacy)
            result = direct.raise_for_status().json()["result"]
            self.assertEqual(result["scheduling_mode"], "legacy")
            self.assertEqual((result["status"], result["makespan"]), ("OPTIMAL", 2))

            legacy["members"] = [{"id": "M1", "name": "Alex"}]
            for task in legacy["tasks"]:
                task["assignee_id"] = "M1"
            ready = await client.post("/api/validate?require_assignments=true", json=legacy)
            self.assertTrue(ready.raise_for_status().json()["valid"])
            wrapped = await client.post("/api/solve", json={"ir": legacy})
            result = wrapped.raise_for_status().json()["result"]
            self.assertEqual(result["scheduling_mode"], "member")
            self.assertEqual((result["status"], result["makespan"]), ("OPTIMAL", 3))

            compatibility = await client.post("/api/solve", json={"ir": legacy, "scheduling_mode": "legacy"})
            result = compatibility.raise_for_status().json()["result"]
            self.assertEqual(result["scheduling_mode"], "legacy")
            self.assertEqual((result["status"], result["makespan"]), ("OPTIMAL", 2))
