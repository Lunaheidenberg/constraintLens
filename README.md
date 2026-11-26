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

## Hướng dẫn sử dụng

Mở **Hướng dẫn sử dụng** (trợ giúp thao tác ConstraintLens) ở thanh dự án hoặc trong trình chỉnh sửa công việc. Hỏi bằng tiếng Việt tự nhiên, có thể bỏ dấu hoặc dùng cách nói như “Bảng Kanban xài như thế nào?”. Bạn có thể hỏi về tab khác hoặc chọn một câu hỏi gợi ý. Câu hỏi có tối đa 240 ký tự. Bấm **Đóng trợ giúp** hoặc `Esc` để quay lại vị trí vừa mở.

- `GET /api/help/topics?workspace=setup|planning|recovery` trả về câu hỏi gợi ý theo tab.
- `POST /api/help/ask` nhận `question` và `workspace`, rồi trả về `topic`, `answer` và `suggestions`.

Nội dung tiếng Việt và cách nhận diện câu hỏi nằm trong [application_guide.py](application_guide.py). Khi đổi nhãn hoặc luồng thao tác, cập nhật nội dung tương ứng và chạy `tests/test_application_guide.py`. Các câu hỏi thông dụng được xử lý tại máy chủ. Với câu hỏi khó xác định thuộc tài liệu trợ giúp, Gemini nhận câu hỏi đã lọc thông tin riêng, tab hiện tại và các đoạn hướng dẫn đã xác minh. Gemini chọn và sắp xếp các đoạn để trả lời. Máy chủ kiểm tra các mã đoạn trước khi hiển thị nội dung. Mỗi câu hỏi có tối đa một lần gọi Gemini trong 8 giây, bao gồm thời gian kết nối và sinh kết quả. Khi thiếu khóa, hết thời gian hoặc kết quả không hợp lệ, bảng giữ câu hỏi và đưa ra gợi ý liên quan.

## Project Recovery API

`POST /api/recovery/explain` phân tích các bản lịch theo thành viên do client gửi. Endpoint chỉ đọc. Xem schema đầy đủ tại `/docs` hoặc `/openapi.json`.

| Trường yêu cầu | Cách sử dụng |
|---|---|
| `context_ref`, `question` | Gửi mã ngữ cảnh do client tạo và câu hỏi từ 1–500 ký tự. Backend trả lại `context_ref` trong phản hồi 200. Mã này chỉ dùng để phát hiện phản hồi cũ. Nguồn snapshot, quan hệ giữa các bản lịch và trạng thái solver do client khai báo. |
| `intent`, `focus_task_ids` | Có thể bỏ qua. `intent` nhận `overview`, `changes`, `deadline`, `dependencies`, `progress`, `attention`, `causes` hoặc `actions`. `focus_task_ids` ưu tiên dữ kiện liên quan đến các ID được hỏi. |
| `accepted`, `proposal` | Hai vai trò tách biệt. Mỗi vai trò nhận một snapshot hoặc `null`. Hai bản cùng dự án dùng chung `project_ref` và mỗi phiên bản có `snapshot_ref` riêng. Client tạo và quản lý cả hai mã. |

Ví dụ cho đề xuất ban đầu chưa được chấp nhận.

```json
{
  "context_ref": "comparison-7",
  "question": "Dự án có đúng hạn không?",
  "proposal": {
    "project_ref": "local-project-1",
    "snapshot_ref": "proposal-7",
    "status": "OPTIMAL",
    "calendar": {"project_start_date": "2026-11-20", "target_deadline_date": "2026-11-21"},
    "tasks": [{"id": "T1", "estimated_duration": 2, "assignee_id": "M1"}],
    "scheduled_tasks": [{"task_id": "T1", "start_day": 0, "end_day": 2}]
  }
}
```

- Dựng từng snapshot từ đúng phiên bản đã giải. Lấy `estimated_duration` từ `Task.duration`, `dependencies` từ task cùng phiên bản và khoảng lịch từ `scheduledTasks`. Có thể gửi `earliest_ready_day` và `queue_wait_days` để backend đối chiếu. Dùng `project_start_date` của từng bản để đổi offset sang ngày. Ngày làm việc cuối là `end_day - 1`. Ngày hạn tính cả chính ngày đó, kể cả cuối tuần.
- Với lịch lập lại theo tiến độ, `progress` chứa `progress_as_of_date`, `actual_finishes` và `remaining_durations` theo ID. Có thể dựng hai bảng từ `progressFromPlan(plan)` với báo cáo thuộc đúng bản lịch. Giữ công việc đã xác nhận hoàn thành trong `tasks` và chỉ biểu diễn mốc thực tế của nó trong `actual_finishes`. Nếu đang làm, gửi số ngày còn lại đã xác nhận. Công việc tương lai dùng ước lượng gốc. Trường `status` của task chỉ là thông tin Kanban tùy chọn.
- HTTP 200 trả `context_ref`, `basis`, `facts`, `possible_explanations`, `suggestions`, `unknowns` và `ai_status`. `basis` ghi các mã snapshot, vai trò đang phân tích, hạn dùng để đánh giá và ID dữ kiện ưu tiên. Khi cả hai lịch có nghiệm, hạn của đề xuất được áp dụng cho cả cặp. Mỗi dữ kiện có `id`, `kind`, `role`, `task_ids` và `data`. Dữ kiện so sánh có `role: null`. Dùng `fact_ids` nối giải thích hoặc gợi ý với dữ kiện. Mọi gợi ý có `status: "unverified"` và cần tính lại lịch sau khi người dùng thay đổi dữ liệu.
- Kết quả giải thiếu nghiệm có thể được gửi ở `proposal` với `scheduled_tasks: []`. Có thể gửi `tasks: []` nếu chỉ có trạng thái lần giải. API báo riêng `UNKNOWN`, `INFEASIBLE`, `INVALID_INPUT` và `MODEL_INVALID`. Đề xuất `FEASIBLE` trễ chỉ cho biết nghiệm hiện có trễ. `reported_optimal_late` áp dụng có điều kiện khi trạng thái `OPTIMAL` do CP-SAT của ConstraintLens trả về cho đúng snapshot. Mục tiêu chính của solver hiện tại là tối thiểu hóa ngày kết thúc. Dự án đã hoàn thành dùng ngày thực tế muộn nhất.
- Payload sai cấu trúc hoặc snapshot mâu thuẫn trả HTTP 422. Thiếu một hoặc cả hai lịch và lỗi Gemini trả HTTP 200 với dữ kiện sẵn có. Câu hỏi tra cứu trực tiếp, lịch không đổi và dự án đã hoàn thành có `ai_status: "skipped"`. Với câu hỏi cần ưu tiên giải thích hoặc gợi ý, Gemini có tối đa một lượt gọi trong 8 giây. Recovery dùng cấu hình `GEMINI_API_KEY` và `GEMINI_DRAFT_MODEL` hiện có với mặc định `gemini-3.6-flash`. Provider chỉ nhận chủ đề suy ra tại chỗ, mã tạm và dữ kiện rút gọn. Backend kiểm tra toàn bộ mã tham chiếu trước khi ưu tiên nội dung. Các trạng thái dự phòng gồm `missing_key`, `unavailable`, `timeout` và `invalid_output`.
