# ConstraintLens scheduling

`POST /api/solve` accepts a `SchedulingIR` directly or under `ir`. Both forms accept `scheduling_mode`, `target_deadline`, and `time_limit_sec` alongside the other top-level fields.

- `scheduling_mode: "member"` requires a valid `assignee_id` on every task. Assignment and dependency errors come back as `result.status: "INVALID_INPUT"` with task-specific details in `result.errors`. Use `POST /api/validate?require_assignments=true` to check the same rules before solving.
- When `scheduling_mode` is omitted or null, a nonempty `members` list or any non-null `assignee_id` selects member scheduling. A project with neither uses the temporary legacy mode. `scheduling_mode: "legacy"` also selects that mode explicitly.
- Member scheduling minimizes makespan with one task at a time per assigned member and respects dependency order. The T1 schema still accepts the legacy capacity and stage fields for compatibility. Member scheduling ignores them and treats Kanban status as progress metadata.
- `result.scheduling_mode` identifies the mode used. Member results return the assigned owner in each scheduled task's `assignee_id` and return empty `stage_metrics` and `bottleneck_stages`. WIP and team-capacity deadline simulations run only in legacy mode. `UNKNOWN` means CP-SAT returned without a schedule or a proof of infeasibility.

## React planning workflow

Load a preset or create a Gemini draft, add members, and choose a member for each task. React validates the project with `require_assignments=true` and sends the confirmed input with `scheduling_mode: "member"`. Gantt shows planned intervals, and the Kanban board tracks progress independently. The legacy Streamlit workflow and API compatibility fields remain available.

The FastAPI draft and planning endpoints read `GEMINI_API_KEY` on the server. They use `gemini-3.6-flash` when `GEMINI_DRAFT_MODEL` is unset or blank. Set it to a model ID to override the default.

Each planning endpoint can retry once on the same model after HTTP 503 or 504. Both attempts and a 200–400 ms delay share a 45-second deadline, with at least five seconds reserved for a retry. The optional `GEMINI_DRAFT_FALLBACK_MODEL` still applies to `/api/parse/draft` and is disabled by default.

## Hỏi ConstraintLens

Mở **Hỏi ConstraintLens** ở thanh dự án hoặc trong trình chỉnh sửa công việc. Hỏi bằng tiếng Việt tự nhiên, có thể bỏ dấu hoặc dùng cách nói như “Bảng Kanban xài như thế nào?”. Bạn có thể hỏi về tab khác hoặc chọn một câu hỏi gợi ý. Câu hỏi có tối đa 240 ký tự. Bấm **Đóng trợ giúp** hoặc `Esc` để quay lại vị trí vừa mở.

- `GET /api/help/topics?workspace=setup|planning|recovery` trả về câu hỏi gợi ý theo tab.
- `POST /api/help/ask` nhận `question` và `workspace`, rồi trả về `topic`, `answer` và `suggestions`.

Nội dung tiếng Việt và cách nhận diện câu hỏi nằm trong [application_guide.py](application_guide.py). Khi đổi nhãn hoặc luồng thao tác, cập nhật nội dung tương ứng và chạy `tests/test_application_guide.py`. Các câu hỏi thông dụng được xử lý tại máy chủ. Với câu hỏi khó xác định thuộc tài liệu trợ giúp, Gemini nhận câu hỏi đã lọc thông tin riêng, tab hiện tại và các đoạn hướng dẫn đã xác minh. Gemini chọn và sắp xếp các đoạn để trả lời. Máy chủ kiểm tra các mã đoạn trước khi hiển thị nội dung. Mỗi câu hỏi có tối đa một lần gọi Gemini trong 8 giây, bao gồm thời gian kết nối và sinh kết quả. Khi thiếu khóa, hết thời gian hoặc kết quả không hợp lệ, bảng giữ câu hỏi và đưa ra gợi ý liên quan.
