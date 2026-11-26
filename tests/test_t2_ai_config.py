import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from api import _get_gemini_api_key, _get_gemini_model, _load_dotenv_file, app
from parser import propose_project_plan
from planning_draft import GeneratePlanningRequest


class DotenvAndAiStatusTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"),
        )

    def test_flexible_dotenv_parsing_with_spaces_quotes_comments_and_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            env_path.write_text(
                "# Comment line\n"
                "\n"
                '  GEMINI_API_KEY = "sk-test-123"  \n'
                "export GEMINI_DRAFT_MODEL = models/gemini-2.5-flash\n",
                encoding="utf-8",
            )
            parsed = _load_dotenv_file(env_path)
            self.assertEqual(parsed["GEMINI_API_KEY"], "sk-test-123")
            self.assertEqual(parsed["GEMINI_DRAFT_MODEL"], "models/gemini-2.5-flash")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(_get_gemini_api_key(env_path=env_path), "sk-test-123")
                self.assertEqual(_get_gemini_model(env_path=env_path), "gemini-2.5-flash")

    async def test_ai_status_reports_configured_and_model_without_leaking_key(self):
        secret = "AIza-secret-session-key-999"
        with patch("api._get_gemini_api_key", return_value=""), patch("api._get_gemini_model", return_value="gemini-3.6-flash"):
            unconfigured = await self.client.get("/api/ai/status")
            self.assertEqual(unconfigured.status_code, 200)
            self.assertEqual(unconfigured.json(), {"configured": False, "model": "gemini-3.6-flash"})

            with_session = await self.client.get("/api/ai/status", headers={"X-Gemini-Api-Key": secret})
            self.assertEqual(with_session.status_code, 200)
            self.assertEqual(with_session.json(), {"configured": True, "model": "gemini-3.6-flash"})
            self.assertNotIn(secret, with_session.text)
            self.assertNotIn(secret, os.environ.get("GEMINI_API_KEY", ""))

    async def test_session_header_key_powers_clarify_without_persisting_or_logging(self):
        secret = "AIza-temporary-tab-key"
        provider = self.enterContext(patch("parser.genai.Client"))
        generate = provider.return_value.__enter__.return_value.aio.__aenter__.return_value.models.generate_content = AsyncMock(
            return_value=SimpleNamespace(text=json.dumps({"goal": "Xây app", "questions": []})),
        )
        with (
            patch("api._get_gemini_api_key", return_value=""),
            patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False),
            self.assertLogs("parser", level="INFO") as logs,
        ):
            response = await self.client.post(
                "/api/planning/clarify",
                json={"prompt": "Xây dựng ứng dụng quản lý nhóm."},
                headers={"X-Gemini-Api-Key": secret},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["goal"], "Xây app")
        self.assertEqual(provider.call_args.kwargs["api_key"], secret)
        generate.assert_awaited_once()
        self.assertEqual(os.environ.get("GEMINI_API_KEY", ""), "")
        self.assertNotIn(secret, response.text)
        self.assertNotIn(secret, "\n".join(logs.output))


class DraftMembersAndAssignmentReviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(patch("api._get_gemini_api_key", return_value="mock-key"))
        self.enterContext(patch.dict(os.environ, {"GEMINI_DRAFT_MODEL": "", "GEMINI_DRAFT_FALLBACK_MODEL": ""}))
        provider = self.enterContext(patch("parser.genai.Client"))
        self.generate = provider.return_value.__enter__.return_value.aio.__aenter__.return_value.models.generate_content = AsyncMock()
        self.client = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"),
        )

    async def test_suggested_members_and_assignments_always_require_user_review(self):
        plan_output = {
            "goal": "Xây dựng trang web bán sách",
            "project_name": "Bookstore",
            "members": [
                {"id": "M1", "name": "An"},
                {"id": "M2", "name": "Bình"},
            ],
            "tasks": [
                {
                    "id": "T1",
                    "name": "Thiết kế UI",
                    "category": "Design",
                    "duration": 2,
                    "duration_quote": "Thiết kế UI mất 2 ngày",
                    "dependencies": [],
                    "dependency_quote": "Thiết kế UI độc lập",
                    "suggested_assignee_id": "M1",
                    "assignee_quote": "An phụ trách Thiết kế UI",
                },
                {
                    "id": "T2",
                    "name": "Code API",
                    "category": "Backend",
                    "duration": 3,
                    "duration_quote": "Code API mất 3 ngày",
                    "dependencies": ["T1"],
                    "dependency_quote": "Code API sau khi Thiết kế UI",
                    "suggested_assignee_id": None,
                    "assignee_quote": None,
                },
            ],
            "assumptions": [],
            "uncertainties": [],
        }
        self.generate.return_value = SimpleNamespace(text=json.dumps(plan_output, ensure_ascii=False))
        prompt = "An phụ trách Thiết kế UI mất 2 ngày, Thiết kế UI độc lập. Code API mất 3 ngày, Code API sau khi Thiết kế UI."
        planned = await propose_project_plan(GeneratePlanningRequest(prompt=prompt), "mock-key")
        self.assertEqual([(m.id, m.name) for m in planned.draft.members], [("M1", "An"), ("M2", "Bình")])
        self.assertEqual(planned.draft.tasks[0].suggested_assignee_id, "M1")
        # Phải giữ ở trạng thái suggested để người dùng xác nhận, không tự xác nhận ngầm.
        self.assertEqual(planned.draft.tasks[0].assignee_review, "suggested")
        self.assertIsNone(planned.draft.tasks[1].suggested_assignee_id)
        self.assertIsNone(planned.draft.tasks[1].assignee_review)

        draft_json = planned.draft.model_dump()
        for item in draft_json["tasks"]:
            item["duration_review"] = "confirmed"
            item["dependency_review"] = "confirmed"
        rejected = await self.client.post("/api/parse/confirm", json=draft_json)
        self.assertEqual(rejected.status_code, 422)
        self.assertIn("người phụ trách", rejected.json()["detail"])

        draft_json["tasks"][0]["assignee_review"] = "confirmed"
        confirmed = await self.client.post("/api/parse/confirm", json=draft_json)
        self.assertEqual(confirmed.status_code, 200)
        ir = confirmed.json()
        self.assertEqual(ir["members"], [{"id": "M1", "name": "An"}, {"id": "M2", "name": "Bình"}])
        self.assertEqual(ir["team_capacity"], 2)
        self.assertEqual(ir["tasks"][0]["assignee_id"], "M1")
        self.assertIsNone(ir["tasks"][1]["assignee_id"])
