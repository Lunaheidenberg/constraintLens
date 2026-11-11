# Project architecture

## Current implementation

React and Vite provide the scheduling interface. `frontend/src/main.tsx` mounts `App.tsx`, which keeps the editable project, controls, validation feedback, and latest result in React state. The UI loads presets, parses project descriptions, supports task editing and what-if runs, and displays a Gantt chart and bottleneck metrics. Loading a preset or receiving a parsed draft triggers a solve automatically. The editor also supports manual reruns.

The UI sends HTTP/JSON requests to FastAPI. `App.tsx` currently uses the absolute base URL `http://localhost:8000`. Vite serves the frontend on port 5173 and defines a proxy for relative `/api` requests. The absolute calls bypass that proxy. `run_dev.bat` starts Uvicorn on port 8000 and Vite for local development.

| Endpoint | Behavior |
|---|---|
| `GET /api/presets` | Returns built-in scheduling scenarios from `api.py`. |
| `POST /api/parse` | Uses `parser.py` and Gemini to extract a scheduling draft from natural-language text. Requires a Gemini API key. |
| `POST /api/validate` | Accepts a scheduling IR and returns a validity flag and business-rule errors. |
| `POST /api/solve` | Accepts scheduling input with optional deadline and time limit. Returns the CP-SAT result and any deadline recovery suggestions from what-if runs. |

`models.py` defines the Pydantic input IR, including tasks, dependencies, durations, members, category, status, and assignee IDs. It also retains the T1 team-capacity, Kanban-stage, and WIP fields for compatibility. `frontend/src/types.ts` mirrors the API data structures. `validator.py` checks business rules, including dependency references and cycles. `solver.py` validates the IR before invoking CP-SAT and minimizes makespan while preserving task dependencies.

T2 implements member-constrained scheduling. When requested explicitly, or when members or task assignments are present, the solver requires every task to have a valid assignee and uses `AddNoOverlap()` per member. Tasks assigned to different members can overlap. This path does not constrain scheduling by team capacity, Kanban status, or stage WIP. The API and solver temporarily retain the old aggregate team-capacity and stage-WIP behavior for unassigned legacy callers, including current presets, Gemini drafts, and Streamlit. Remove that path when the React UI, presets, parser, and any remaining callers migrate to confirmed assignments in T3.

The React/FastAPI workflow keeps the editable project in memory and uses no database. The repository retains the legacy Streamlit entry point in `app.py`.

Local baseline checks include the executable scenarios in `validator.py` and `solver.py`, the frontend TypeScript check and build, and API smoke tests with built-in presets. The direct parser demo and `diagnose_api.py` use the live Gemini API and are outside this baseline.

## Planned features

- React controls for users to manage project members and manually assign every task before starting a member-constrained schedule. The backend solver already supports confirmed assignments.
- React Kanban progress controls using **To Do**, **Doing**, and **Done**. Task category remains independent of Kanban status in the data model.
- Migration of presets, Gemini drafts, and any remaining callers to confirmed member assignments, followed by removal of legacy category or stage WIP constraints and their compatibility fields.
- Dynamic rescheduling that accounts for delays and actual progress, preserves completed work, and supports comparison between baseline and updated schedules.
- The MVP will continue without a database.
