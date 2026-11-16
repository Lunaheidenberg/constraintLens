# ConstraintLens scheduling

`POST /api/solve` accepts a `SchedulingIR` directly or under `ir`. Both forms accept `scheduling_mode`, `target_deadline`, and `time_limit_sec` alongside the other top-level fields.

- `scheduling_mode: "member"` requires a valid `assignee_id` on every task. Assignment and dependency errors come back as `result.status: "INVALID_INPUT"` with task-specific details in `result.errors`. Use `POST /api/validate?require_assignments=true` to check the same rules before solving.
- When `scheduling_mode` is omitted or null, a nonempty `members` list or any non-null `assignee_id` selects member scheduling. A project with neither uses the temporary legacy mode. `scheduling_mode: "legacy"` also selects that mode explicitly.
- Member scheduling minimizes makespan with one task at a time per assigned member and respects dependency order. The T1 schema still accepts the legacy capacity and stage fields for compatibility. Member scheduling ignores them and treats Kanban status as progress metadata.
- `result.scheduling_mode` identifies the mode used. Member results return the assigned owner in each scheduled task's `assignee_id` and return empty `stage_metrics` and `bottleneck_stages`. WIP and team-capacity deadline simulations run only in legacy mode. `UNKNOWN` means CP-SAT returned without a schedule or a proof of infeasibility.

## React planning workflow

Load a preset or create a Gemini draft, add members, and choose a member for each task. React validates the project with `require_assignments=true` and sends the confirmed input with `scheduling_mode: "member"`. Gantt shows planned intervals, and the Kanban board tracks progress independently. The legacy Streamlit workflow and API compatibility fields remain available.

The FastAPI draft endpoint reads `GEMINI_API_KEY` on the server. Set the `GEMINI_DRAFT_MODEL` environment variable to override `gemini-3.8-flash`. Fallback is disabled by default for drafts. Set `GEMINI_DRAFT_FALLBACK_MODEL` only after confirming the model is available to your Gemini project and accepting that a second generation request can incur charges. The endpoint makes at most one request per model and uses the remaining request timeout for fallback.
