import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import httpx
from google.genai import Client as GeminiClient

from api import app
from application_guide import TOPICS


class ApplicationGuideTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"),
        )
        self.key = self.enterContext(patch("api._get_gemini_api_key", return_value=""))
        self.gemini = self.enterContext(patch("application_guide.genai.Client"))
        provider = self.gemini.return_value.__enter__.return_value.aio.__aenter__.return_value
        self.generate = AsyncMock()
        provider.models.generate_content = self.generate

    async def ask(self, question, workspace="setup"):
        response = await self.client.post("/api/help/ask", json={"question": question, "workspace": workspace})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_all_topics_return_verified_answers_without_a_key(self):
        cases = {
            "create-schedule": ("Lam sao tao lich du an?", "Tính lịch ban đầu", "Người phụ trách", "Chấp nhận lịch"),
            "tasks-and-assignments": ("Cách giao việc cho thành viên", "Thêm công việc", "Chỉnh sửa", "công việc tiên quyết"),
            "optimal": ("  optimal nghĩa là gì?! ", "CP-SAT đã chứng minh", "FEASIBLE", "Hạn mục tiêu"),
            "kanban-vs-gantt": ("Kanban khac Gantt the nao?", "Tiến độ", "To Do, Doing và Done", "khoảng ngày dự kiến"),
            "kanban": ("Bảng Kanban xài như thế nào?", "Tiến độ", "To Do, Doing và Done", "Di chuyển"),
            "kanban-doing": ("Làm sao chuyển task sang Doing?", "cột Doing", "Di chuyển", "Còn lại thực tế"),
            "kanban-done": ("Cách đánh dấu task hoàn thành?", "cột Done", "Di chuyển", "Ngày hoàn thành thực tế"),
            "update-progress": ("Tôi muốn cập nhật tiến độ", "Di chuyển", "Báo cáo tiến độ", "Kiểm tra tiến độ"),
            "reschedule": ("Khi nào đề xuất lịch mới?", "Đề xuất lịch mới", "ngày sau ngày báo cáo", "So sánh kế hoạch"),
            "remaining-duration": ("Nhập số ngày còn lại ở đâu?", "Còn lại thực tế", "Doing", "số nguyên dương"),
            "task-moves": ("Tại sao công việc bị dời?", "việc tiên quyết", "mỗi thành viên chỉ làm một việc", "Chi tiết thay đổi"),
            "deadline-warnings": ("Lịch trễ hạn thì sao?", "số ngày trễ", "vẫn được giữ", "Điều chỉnh kế hoạch"),
            "ai-planning": ("Cách dùng AI Planning Assistant?", "AI giúp lập kế hoạch", "Bỏ qua tất cả", "Áp dụng bản nháp"),
            "bulk-draft-review": ("Làm sao xác nhận hàng loạt các gợi ý trong bản nháp?", "Xác nhận các gợi ý", "còn thiếu", "sửa từng công việc"),
        }
        self.assertEqual(set(TOPICS), set(cases))
        for topic, (question, *expected) in cases.items():
            with self.subTest(topic=topic):
                response = await self.ask(question)
                self.assertEqual(response["topic"], topic)
                self.assertEqual(response["suggestions"], [])
                self.assertEqual(await self.ask(TOPICS[topic].question), response)
                for fragment in expected:
                    self.assertIn(fragment, response["answer"])
        self.key.assert_not_called()
        self.gemini.assert_not_called()

    async def test_writing_variants_and_cross_tab_questions_bypass_gemini(self):
        self.key.return_value = "mock-key"
        variants = {
            "kanban": ("Kanban dùng để làm gì?", "kanban dung sao", "Xài sao, cái bảng Kanban?!", "Xem bảng thẻ ở đâu?"),
            "kanban-vs-gantt": ("Gantt khác gì so với bảng Kanban?",),
            "kanban-doing": ("Doing: chuyen CV sang bang cach nao?", "Đang thực hiện thì đưa thẻ vào đâu?"),
            "kanban-done": ("Danh dau CV da xong sao?", "Qua cột Done thì kéo thẻ ở đâu?"),
            "tasks-and-assignments": ("NV duoc gan vao task the nao?",),
            "deadline-warnings": ("DL bị trễ thì xem ở đâu?", "Khi nào xuất hiện cảnh báo hạn chót?"),
            "create-schedule": ("Làm sao lập lịch?", "Cách lên lịch sao?", "lap lich the nao?"),
            "reschedule": ("Lịch dự án xếp lại sao?", "Làm sao lập lịch lại?", "Làm sao lập lịch theo tiến độ?"),
            "task-moves": ("Tại sao một task bị dời lịch?", "Vi sao cong viec bi lui lich?"),
            "bulk-draft-review": ("Lam sao duyet hang loat cac goi y trong ban nhap?", "Cách bấm nút Xác nhận các gợi ý?"),
            "remaining-duration": ("Dien o dau so ngay con can cho viec Doing?",),
        }
        for workspace in ("setup", "planning", "recovery"):
            for topic, questions in variants.items():
                for question in questions:
                    with self.subTest(workspace=workspace, question=question):
                        answer = await self.ask(question, workspace)
                        self.assertEqual(answer["topic"], topic)
                        self.assertEqual(answer["answer"], TOPICS[topic].answer)
        self.key.assert_not_called()
        self.gemini.assert_not_called()

    def test_documented_controls_have_matching_react_labels(self):
        source = Path(__file__).resolve().parents[1] / "frontend" / "src"
        controls = {
            "App.tsx": ("Kịch bản & mẫu chạy thử", "Kịch bản mẫu", "Cài đặt Gemini AI & BYOK", "Xuất JSON", "Nhập JSON", "Ngày bắt đầu dự án", "Tính lịch ban đầu", "Chấp nhận lịch", "So sánh kế hoạch", "Bảng Kanban"),
            "ProjectEditor.tsx": ("Thêm công việc", "Chỉnh sửa", "Người phụ trách", "Di chuyển"),
            "Schedule.tsx": ("Hạn mục tiêu", "Theo thành viên"),
            "ProgressEditor.tsx": ("Báo cáo tiến độ", "Kiểm tra tiến độ", "Đề xuất lịch mới", "Còn lại thực tế", "Ngày hoàn thành thực tế", "Dùng ngày báo cáo", "Theo kế hoạch"),
            "PlanComparison.tsx": ("Chi tiết thay đổi",),
            "DeadlineWarning.tsx": ("Điều chỉnh kế hoạch",),
            "PlanningAssistant.tsx": ("Mô tả dự án", "AI giúp lập kế hoạch", "Bỏ qua tất cả"),
            "DraftEditor.tsx": ("Áp dụng bản nháp", "Xác nhận các gợi ý"),
        }
        knowledge = " ".join(topic.answer for topic in TOPICS.values())
        for file, labels in controls.items():
            code = (source / file).read_text(encoding="utf-8")
            for label in labels:
                with self.subTest(label=label):
                    self.assertIn(label, code)
                    self.assertIn(label, knowledge)

    async def test_contextual_topics_and_unsupported_questions(self):
        for workspace, expected in {
            "setup": ["create-schedule", "ai-planning", "tasks-and-assignments", "kanban"],
            "planning": ["create-schedule", "optimal", "deadline-warnings", "kanban-vs-gantt"],
            "recovery": ["update-progress", "kanban", "remaining-duration", "reschedule", "task-moves"],
        }.items():
            with self.subTest(workspace=workspace):
                response = await self.client.get("/api/help/topics", params={"workspace": workspace})
                self.assertEqual(response.status_code, 200)
                self.assertEqual([item["topic"] for item in response.json()], expected)
                for item in response.json():
                    self.assertEqual(item["question"], TOPICS[item["topic"]].question)
                answer = await self.ask("Xuất biểu đồ Gantt thành PDF ở đâu?", workspace)
                self.assertIsNone(answer["topic"])
                self.assertIn("chưa có thông tin xác minh", answer["answer"])
                self.assertEqual(answer["suggestions"][0]["topic"], "kanban-vs-gantt")
                self.assertGreaterEqual(len(answer["suggestions"]), 4)
        self.key.assert_not_called()
        self.gemini.assert_not_called()

    async def test_related_help_and_unsupported_bulk_actions(self):
        for workspace in ("setup", "planning", "recovery"):
            with self.subTest(workspace=workspace):
                answer = await self.ask("Nếu task bị dời lịch thì xem ở đâu?", workspace)
                self.assertEqual(answer["suggestions"][0]["topic"], "task-moves")
                for question in ("Làm sao xóa hàng loạt công việc?", "Xuất PDF hàng loạt thế nào?"):
                    answer = await self.ask(question, workspace)
                    self.assertIsNone(answer["topic"])
                    self.assertIn("chưa có thông tin xác minh", answer["answer"])
        self.gemini.assert_not_called()

    async def test_gemini_composes_verified_excerpts_across_topics(self):
        self.key.return_value = "mock-key"
        self.generate.return_value = SimpleNamespace(text='{"excerpts":["update-progress:4","reschedule:1"]}')
        question = "Nếu kéo thẻ trên Kanban thì lịch có đổi liền không?"
        response = await self.ask(question, "setup")
        self.generate.assert_awaited_once()
        self.assertEqual(json.loads(self.generate.await_args.kwargs["contents"]), {"question": question, "workspace": "Thiết lập"})
        config = self.generate.await_args.kwargs["config"]
        lines = response["answer"].splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("lịch đang áp dụng", lines[0])
        self.assertIn("Đề xuất lịch mới", lines[1])
        self.assertTrue(all(line in config.system_instruction for line in lines))
        self.assertEqual(response["suggestions"], [])

    async def test_provider_receives_help_words_and_redacts_project_details(self):
        self.key.return_value = "mock-key"
        self.generate.return_value = SimpleNamespace(text='{"excerpts":["update-progress:4","reschedule:1"]}')
        private = ("Dự án Mùa Xuân", "quỹ mặt trời", "T-431", "mai@example.com", "https://private.example/a", "mock-key", "09/08/2026")
        question = f"Cách xem lịch nếu kéo thẻ trên Kanban? {private[0]}: “{private[1]}”, {', '.join(private[2:])}"
        response = await self.ask(question, "planning")
        contents = json.loads(self.generate.await_args.kwargs["contents"])
        self.assertEqual(set(contents), {"question", "workspace"})
        self.assertEqual(contents["workspace"], "Kế hoạch")
        self.assertIn("Cách xem lịch nếu kéo thẻ trên Kanban?", contents["question"])
        self.assertIn("[ẩn]", contents["question"])
        for value in (*private, "Mùa Xuân"):
            self.assertNotIn(value, contents["question"])
            self.assertNotIn(value, response["answer"])

    async def test_unsupported_features_and_project_data_have_honest_responses(self):
        self.key.return_value = "mock-key"
        for question in ("Sao xuất báo cáo tiến độ ra PDF?", "Bảng Kanban xài sao để thêm cột?", "Cách bật phân công tự động?"):
            response = await self.ask(question)
            self.assertIsNone(response["topic"])
            self.assertIn("chưa có thông tin xác minh", response["answer"])
        for question in ("Dự án của tôi có bị trễ hạn không?", "Ai đang phụ trách T2?", "Vì sao công việc Thiết Kế đã trễ?"):
            response = await self.ask(question, "recovery")
            self.assertIsNone(response["topic"])
            self.assertIn("dữ liệu của dự án đang mở", response["answer"])
            self.assertNotIn("Thiết Kế", response["answer"])
        self.key.assert_not_called()
        self.gemini.assert_not_called()

    async def test_installed_gemini_sdk_uses_one_bounded_structured_request(self):
        self.key.return_value = "mock-key"
        calls = []

        def provider(request):
            calls.append(json.loads(request.content))
            return httpx.Response(200, json={"candidates": [{
                "finishReason": "STOP",
                "content": {"role": "model", "parts": [{"text": '{"excerpts":["optimal:1","deadline-warnings:1"]}'}]},
            }]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as transport:
            def make_client(**options):
                self.assertEqual(options["http_options"].timeout, 8000)
                self.assertEqual(options["http_options"].retry_options.attempts, 1)
                options["http_options"].httpx_async_client = transport
                return GeminiClient(**options)

            self.gemini.side_effect = make_client
            answer = await self.ask("Nếu lịch tối ưu thì có đúng hạn không?", "recovery")

        self.assertEqual(answer["topic"], "optimal")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["generationConfig"]["responseMimeType"], "application/json")
        schema = calls[0]["generationConfig"]["responseJsonSchema"]
        self.assertEqual(schema["properties"]["excerpts"]["maxItems"], 5)
        contents = json.loads(calls[0]["contents"][0]["parts"][0]["text"])
        self.assertEqual(contents["workspace"], "Tiến độ")

    async def test_gemini_can_abstain_when_documentation_is_insufficient(self):
        self.key.return_value = "mock-key"
        self.generate.return_value = SimpleNamespace(text='{"excerpts":[]}')
        response = await self.ask("Tô màu riêng cho từng thẻ Kanban được không?")
        self.generate.assert_awaited_once()
        self.assertIsNone(response["topic"])
        self.assertIn("chưa có thông tin xác minh", response["answer"])
        self.assertEqual(response["suggestions"][0]["topic"], "kanban")

    async def test_invalid_or_fabricated_model_output_uses_related_suggestions(self):
        self.key.return_value = "mock-key"
        for response_text in (
            '{"excerpts":["export-pdf:1"]}',
            '{"excerpts":["reschedule:1","Bấm nút Xuất PDF"]}',
            '{"excerpts":["reschedule:1"],"answer":"Bấm nút Xuất PDF"}',
            '{"excerpts":["reschedule:1","reschedule:1"]}',
            '{"excerpts":[1]}',
            json.dumps({"excerpts": [f"{topic}:1" for topic in list(TOPICS)[:6]]}),
            'unstructured response',
        ):
            with self.subTest(response_text=response_text):
                self.generate.return_value = SimpleNamespace(text=response_text)
                answer = await self.ask("cảnh báo hạn chót hay lập lịch lại?", "recovery")
                self.assertIsNone(answer["topic"])
                self.assertEqual([item["topic"] for item in answer["suggestions"][:2]], ["reschedule", "deadline-warnings"])
                self.assertIn("Chưa thể trả lời chắc chắn", answer["answer"])
                self.assertNotIn("Xuất PDF", str(answer))

    async def test_timeout_falls_back_to_faq_and_cancels_gemini(self):
        self.key.return_value = "mock-key"
        cancelled = []

        async def slow_provider(**_kwargs):
            try:
                await asyncio.Future()
            finally:
                cancelled.append(True)

        self.generate.side_effect = slow_provider
        with patch("application_guide.GENERATION_TIMEOUT", 0.05):
            answer = await self.ask("lập lịch lại và cảnh báo hạn chót", "recovery")
        self.assertEqual(cancelled, [True])
        self.generate.assert_awaited_once()
        self.assertIsNone(answer["topic"])
        self.assertIn("Chưa thể trả lời chắc chắn", answer["answer"])
        self.assertEqual((await self.ask(answer["suggestions"][0]["question"]))["topic"], "reschedule")
        self.generate.assert_awaited_once()

    async def test_unmatched_help_question_without_a_key_offers_related_faqs(self):
        answer = await self.ask("Nếu kéo thẻ trên Kanban thì lịch có đổi liền không?")
        self.assertIsNone(answer["topic"])
        self.assertEqual(answer["suggestions"][0]["topic"], "kanban")
        self.assertGreaterEqual(len(answer["suggestions"]), 4)
        self.assertIn("Chưa thể trả lời chắc chắn", answer["answer"])
        self.key.assert_called_once()
        self.gemini.assert_not_called()

    async def test_help_rejects_project_fields_and_invalid_questions_without_echo(self):
        for body in (
            {"question": " ", "workspace": "setup"},
            {"question": "private-text" * 240, "workspace": "setup"},
            {"question": "Tạo lịch?", "workspace": "private-text"},
            {"question": "Tạo lịch?", "workspace": "setup", "project": {"notes": "private-text"}},
        ):
            with self.subTest(body=body):
                response = await self.client.post("/api/help/ask", json=body)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("private-text", response.text)
        self.key.assert_not_called()
        self.gemini.assert_not_called()
