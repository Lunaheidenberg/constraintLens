# Project architecture

## Current implementation

React and Vite provide the scheduling interface. `frontend/src/main.tsx` mounts `App.tsx`, which owns one editable `SchedulingIR`, a project calendar, and a progress draft. `ProjectEditor.tsx` provides the member list, task table, task dialog, and Kanban board. Presets load as editable projects. Members have stable IDs, and users assign tasks manually. Removing a referenced member requires clearing or changing the affected assignments first.

The task table, Kanban board, and `ProgressEditor.tsx` read the same task statuses. Moving a task to **Done** does not assign an actual date. `Schedule.tsx` renders planned intervals in calendar dates and confirmed completions as points with no inferred start or historical duration. The first accepted schedule is the baseline. `plans.ts` keeps the baseline, accepted schedule, and current proposal separate. Only explicit acceptance of a current, solved proposal that meets the optional deadline replaces the accepted schedule. Input edits cancel in-flight requests and discard proposals. Project start and structural edits mark the accepted plan outdated. Status edits leave its intervals intact. Deadline edits re-evaluate the accepted finish against the current due date and can expose an existing late schedule for revision. The accepted schedule remains available for reference.

The UI sends HTTP/JSON requests to FastAPI. `App.tsx` currently uses the absolute base URL `http://localhost:8000`. Vite serves the frontend on port 5173 and defines a proxy for relative `/api` requests. The absolute calls bypass that proxy. `run_dev.bat` starts Uvicorn on port 8000 and Vite for local development.

| Endpoint | Behavior |
|---|---|
| `GET /api/presets` | Returns built-in scheduling scenarios from `api.py`. |
| `POST /api/parse/draft` | Retains the T6 task extraction endpoint for Vietnamese or English text. Reads the Gemini API key on the server. |
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

### T7 AI planning and application help

React keeps the planning draft separate from the editable project. Duration and prerequisites carry a review state. Values grounded in the description or a clarification answer can be `provided`. A clear duration correction naming one task takes precedence over the description and records the answer's question ID. Unresolved duration conflicts leave the duration blank for manual entry. Bulk confirmation applies to concrete suggestions. An empty prerequisite list records a decision that no prerequisites are needed.

React applies a validated draft only to a project without tasks, schedules, or progress. It checks this condition again when the confirmation response arrives. Applying the draft preserves the roster and calendar and adds unassigned To Do tasks. Help requests carry the question and workspace and leave project, progress, and schedule state intact.

Planning rejects invalid provider responses and keeps the user's description, edits, and active project available for retry. Selected transient provider errors get one retry on the same model. Draft review, presets, manual entry, scheduling, and local FAQs can run without Gemini.

### Historical T6 extraction

The former React flow generated a draft with `/api/parse/draft`. Applying a reviewed draft could replace the active task list and clear its plans and progress. The T6 extraction endpoint remains available to callers, and T7 uses the same `/api/parse/confirm` endpoint and Validator to convert a reviewed draft into a scheduling IR.

Local checks include `uv run --locked python -m unittest discover -s tests`, the executable scenarios in `validator.py` and `solver.py`, and the frontend TypeScript check, build, and `npm test` (Node 24). The direct parser demo and `diagnose_api.py` use the live Gemini API and are outside this baseline.

## Planned features

- Migration of remaining legacy callers and contracts, followed by removal of legacy category or stage WIP constraints and their compatibility fields.
- The MVP will continue without a database.
