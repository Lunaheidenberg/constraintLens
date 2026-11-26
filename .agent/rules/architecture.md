# Project architecture

## Current implementation

React and Vite provide the scheduling interface. `frontend/src/main.tsx` mounts `App.tsx`, which owns one editable `SchedulingIR`, a project calendar, and a progress draft. `ProjectEditor.tsx` provides the member list, inline-editable task table (name, duration, category, prerequisites, assignee), task dialog, and full-card draggable Kanban board with prerequisite warnings. Setup starts with a collapsible 3-step Quick Start card, a unified preset selector combining complete ready-to-run demos (`demoPresets.ts`) with server scenarios (`GET /api/presets`), browser `localStorage` persistence, JSON export/import (`projectStorage.ts`), and `DateField.tsx` quick actions (`Hôm nay`, clear button, month/year pickers). Members have stable IDs; removing a referenced member requires clearing or changing the affected assignments first.

The task table, Kanban board, and `ProgressEditor.tsx` share task statuses. `ProgressEditor.tsx` supports inline status changes and explicit 1-click quick-fill buttons (`Theo kế hoạch`, `Dùng ngày báo cáo`, +/-1 day steppers) without ever inferring or auto-assigning `actual_finish_date`. Moving a task to **Done** never assigns an actual date automatically. `Schedule.tsx` renders planned intervals in calendar dates, overdue extensions beyond the deadline boundary, `Theo công việc` / `Theo thành viên` member swimlanes, and confirmed completions as points with no inferred start or historical duration. `plans.ts` keeps the baseline, accepted schedule, and current proposal separate, with sticky proposal acceptance controls on resolved schedules. Only explicit acceptance of a current, solved proposal that meets the optional deadline replaces the accepted schedule; input edits cancel in-flight requests and discard proposals.

The UI sends HTTP/JSON scheduling requests to FastAPI (`http://localhost:8000` in dev, proxying `/api` in Vite). The assistant roles stay separate: `Hướng dẫn sử dụng` (`ApplicationGuide.tsx`) answers app usage questions, while `Trợ lý phân tích lịch` (`RecoveryAssistant.tsx`) opens in a non-obstructive side drawer with grounded 1–2 sentence `TL;DR` summaries for both proposals and accepted schedules. `run_dev.bat` starts Uvicorn on port 8000 and Vite for local development.

| Endpoint | Behavior |
|---|---|
| `GET /api/presets` | Returns built-in scheduling scenarios from `api.py`. |
| `GET /api/ai/status` | Returns `{ configured, model }` indicating whether server or optional session `X-Gemini-Api-Key` header is ready, without exposing any key. |
| `POST /api/parse/draft` | Retains the T6 task extraction endpoint for Vietnamese or English text. Reads the Gemini API key on the server or session header. |
| `POST /api/planning/clarify` | Accepts a project description and returns a goal and up to three clarification questions. |
| `POST /api/planning/draft` | Accepts the description and optional clarification answers. Returns a reviewable draft, field provenance, assumptions, and uncertainties. |
| `GET /api/help/topics?workspace=setup\|planning\|recovery` | Returns suggested help questions for the active workspace. |
| `POST /api/help/ask` | Accepts `question` and `workspace` and returns `topic`, `answer`, and `suggestions`. Common FAQs are answered locally. Other requests may use Gemini to select verified excerpts. |
| `POST /api/parse/confirm` | Converts a reviewed draft into an unassigned scheduling IR using Pydantic and `validate_ir`. Returns HTTP 422 for incomplete or invalid drafts. |
| `POST /api/parse` | Retains the legacy Gemini-to-IR contract for older callers. |
| `POST /api/validate` | Accepts a scheduling IR and returns a validity flag and business-rule errors. React sets `require_assignments=true` to validate member assignments, durations, and dependencies before solving. |
| `POST /api/solve` | Accepts scheduling input with optional time limit and `calendar`. React requests `scheduling_mode: "member"` and reviews the result as an initial proposal. A calendar request also returns project finish dates and deadline status. Legacy numeric requests and what-if responses still work. |
| `POST /api/reschedule/validate` | Validates the member-assigned IR, calendar, and progress snapshot without solving. |
| `POST /api/reschedule` | Accepts the same input as progress validation. Returns solver status, errors, the replanning boundary, confirmed completions, remaining intervals, exclusive project finish, final work date, remaining horizon, and deadline status when available. Returns `INVALID_INPUT` for business-rule errors and HTTP 422 for malformed fields. The API is stateless; proposal acceptance is owned by React. |

`models.py` defines the Pydantic input IR, including tasks, dependencies, durations, members, category, status, and assignee IDs. It also retains the T1 team-capacity, Kanban-stage, and WIP fields for compatibility. `frontend/src/types.ts` mirrors the API data structures. `validator.py` checks business rules, including dependency references and cycles. `solver.py` validates the IR before invoking CP-SAT and minimizes makespan while preserving task dependencies.

T2 implements member-constrained scheduling. When requested explicitly, or when members or task assignments are present, the solver requires every task to have a valid assignee and uses `AddNoOverlap()` per member. Tasks assigned to different members can overlap. Member scheduling uses task durations, dependencies, and assignee IDs as scheduling constraints. The API and solver retain aggregate team-capacity and stage-WIP behavior for legacy callers, including Streamlit.

T4 keeps the date contract separate from `SchedulingIR` for compatibility. `calendar` requires `project_start_date` and optionally takes `target_deadline_date`. `project_calendar.py` converts strict ISO `YYYY-MM-DD` dates to calendar-day offsets from project start (day 0). All days count. Solver intervals are `[start_day, end_day)`, so the final occupied date is `end_day - 1`; the exclusive finish is `end_day`. The target date is inclusive and compares against `target_deadline_date + 1 day`. Missing the target does not make a schedule infeasible. React uses date-only arithmetic and displays `DD/MM/YYYY`.

`progress` contains `progress_as_of_date` and `task_progress` keyed by task ID. A report confirms progress through the end of that date. Remaining work starts no earlier than the following day. **To Do** uses the original estimate and needs no progress entry; **Doing** requires `remaining_duration` as a positive integer; **Done** requires `actual_finish_date` and has no remaining interval. Status is read from the IR, and the original estimate never changes during rescheduling. Completed prerequisites contribute their exclusive finish as a fixed boundary. A Doing or Done task needs Done prerequisites; a Done successor must have finished on a later date than its prerequisites. With no actual start dates, validation cannot reconstruct past execution or member capacity.

The initial and revised plans share the integer CP-SAT interval builder. Revised intervals use remaining durations and obey finish-to-start dependencies and one-task-at-a-time member capacity. The solver minimizes the absolute project finish, with earlier starts as a secondary objective. The remaining horizon measures from the replanning boundary to the finish; when all tasks are Done it is zero and the project finish comes from the latest confirmed completion. A failed or unknown solve yields no proposal.

Planning can solve again with the edited task definitions. With a confirmed report, it sends the same reporting day, actual completion dates, and Doing remaining durations to `/api/reschedule`. A successful Progress solve records the submitted execution history separately from schedule acceptance, so cancelling or blocking a proposal keeps the report and its locked completions. New or changed execution statuses need confirmation in Progress before Planning can reschedule against them. Planning edits keep the identity of work that has started. Incompatible changes, such as a project start after a confirmed completion, surface the existing progress validation errors.

T5 previews the accepted plan against a valid rescheduling proposal. Acceptance retains the outgoing accepted snapshot as the previous plan and leaves the original baseline intact. The comparison then shows the previous plan against the current accepted plan, with an option to use the baseline when it is a different reference. Canceling or invalidating a proposal clears its comparison. After edits, comparisons between accepted snapshots are labeled as using accepted data.

`comparison.ts` compares snapshot tasks by ID and computes calendar-day differences from the stored exclusive finish boundaries. The UI shows the last occupied day for planned work and the last confirmed completion for an all-Done plan. Both finishes use the revised snapshot's inclusive target so the change in lateness uses the same deadline. Remaining horizon is shown separately. Moved and unchanged counts require two comparable planned intervals. Confirmed completion uses the recovery records, and a duration change can accompany a move. The comparison Gantt aligns both sets of intervals on one calendar axis and shows actual completions as points.

The React/FastAPI workflow keeps the editable project and the comparison snapshots in memory. The repository retains the legacy Streamlit entry point in `app.py`.

### T7 AI planning, BYOK, and application help

React keeps the planning draft separate from the editable project. Duration, prerequisites, and optional member/assignee suggestions carry explicit review state (`provided`, `suggested`, `missing`, `confirmed`). Values grounded in the description or a clarification answer can be `provided`; a clear duration correction takes precedence over the description and records the question ID. Unresolved duration conflicts leave the duration blank for manual entry. Bulk confirmation applies to concrete suggestions (`Xác nhận các gợi ý`), and an empty prerequisite list records an explicit decision that no prerequisites are needed.

AI Planning supports two modes in `Cài đặt Gemini AI & BYOK`:
- **Default server mode:** uses FastAPI (`/api/planning/clarify`, `/api/planning/draft`) with `.env` flexible parsing or optional `X-Gemini-Api-Key` session header.
- **Zero-Server-Knowledge BYOK (`byokGemini.ts`):** keeps the user's API key strictly in React state (never `localStorage`, JSON exports, or server requests) and calls `generativelanguage.googleapis.com` directly from the browser using selectable Gemini `3.x` models via `x-goog-api-key`.

React applies a validated draft only to a project without tasks, schedules, or progress (warning early in `PlanningInput` if `applyBlocked` is non-empty, and re-checking when confirmation arrives). Applying the draft merges suggested draft members, keeps the calendar, and adds `To Do` tasks with verified or unassigned assignees. Help requests (`ApplicationGuide.tsx`) carry only the question and workspace and leave project, progress, and schedule state intact. Planning rejects invalid provider responses and preserves user inputs for retry. Draft review, presets, manual entry, scheduling, and local FAQs can run without Gemini.

### Historical T6 extraction

The former React flow generated a draft with `/api/parse/draft`. Applying a reviewed draft could replace the active task list and clear its plans and progress. The T6 extraction endpoint remains available to callers, and T7 uses the same `/api/parse/confirm` endpoint and Validator to convert a reviewed draft into a scheduling IR.

Local checks include `uv run --locked python -m unittest discover -s tests`, the executable scenarios in `validator.py` and `solver.py`, and the frontend TypeScript check, build, and `npm test` (Node 24). The direct parser demo and `diagnose_api.py` use the live Gemini API and are outside this baseline.

## Planned features

- Migration of remaining legacy callers and contracts, followed by removal of legacy category or stage WIP constraints and their compatibility fields.
- The MVP will continue without a database.
