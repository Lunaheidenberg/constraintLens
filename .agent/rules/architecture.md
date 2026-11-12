# Project architecture

## Current implementation

React and Vite provide the scheduling interface. `frontend/src/main.tsx` mounts `App.tsx`, which owns one editable `SchedulingIR` and the validation and scheduling results. `ProjectEditor.tsx` provides the member list, task table, task dialog, and progress board. Presets and Gemini responses load as editable drafts. Members have stable IDs, and users assign tasks manually. Removing a referenced member requires clearing or changing the affected assignments first.

The task table and Kanban board read the same tasks. The Kanban columns **To Do**, **Doing**, and **Done** represent actual progress, and cards can move by dragging or using their status selectors. `Schedule.tsx` shows the solver's planned task intervals and assignees. Scheduling-relevant edits cancel pending validation or solving in the UI and mark the previous result outdated. Status edits leave the schedule current. Member display names and the optional deadline marker update the view without a new solve.

The UI sends HTTP/JSON requests to FastAPI. `App.tsx` currently uses the absolute base URL `http://localhost:8000`. Vite serves the frontend on port 5173 and defines a proxy for relative `/api` requests. The absolute calls bypass that proxy. `run_dev.bat` starts Uvicorn on port 8000 and Vite for local development.

| Endpoint | Behavior |
|---|---|
| `GET /api/presets` | Returns built-in scheduling scenarios from `api.py`. |
| `POST /api/parse` | Uses `parser.py` and Gemini to extract a scheduling draft from natural-language text. Requires a Gemini API key. |
| `POST /api/validate` | Accepts a scheduling IR and returns a validity flag and business-rule errors. React sets `require_assignments=true` to validate member assignments, durations, and dependencies before solving. |
| `POST /api/solve` | Accepts scheduling input with optional deadline and time limit. React sends the confirmed IR with `scheduling_mode: "member"` and displays successful CP-SAT results. Legacy callers can still receive deadline recovery suggestions from what-if runs. |

`models.py` defines the Pydantic input IR, including tasks, dependencies, durations, members, category, status, and assignee IDs. It also retains the T1 team-capacity, Kanban-stage, and WIP fields for compatibility. `frontend/src/types.ts` mirrors the API data structures. `validator.py` checks business rules, including dependency references and cycles. `solver.py` validates the IR before invoking CP-SAT and minimizes makespan while preserving task dependencies.

T2 implements member-constrained scheduling. When requested explicitly, or when members or task assignments are present, the solver requires every task to have a valid assignee and uses `AddNoOverlap()` per member. Tasks assigned to different members can overlap. Member scheduling uses task durations, dependencies, and assignee IDs as scheduling constraints. The API and solver retain aggregate team-capacity and stage-WIP behavior for legacy callers, including Streamlit.

The React/FastAPI workflow keeps the editable project in memory and uses no database. The repository retains the legacy Streamlit entry point in `app.py`.

Local baseline checks include the executable scenarios in `validator.py` and `solver.py`, the frontend TypeScript check and build, and API smoke tests with built-in presets. The direct parser demo and `diagnose_api.py` use the live Gemini API and are outside this baseline.

## Planned features

- Migration of remaining legacy callers and contracts, followed by removal of legacy category or stage WIP constraints and their compatibility fields.
- Dynamic rescheduling that accounts for delays and actual progress, preserves completed work, and supports comparison between baseline and updated schedules.
- The MVP will continue without a database.
