# ConstraintLens scheduling

`POST /api/solve` accepts a `SchedulingIR` directly or under `ir`. Both forms accept `scheduling_mode`, `target_deadline`, and `time_limit_sec` alongside the other top-level fields.

- `scheduling_mode: "member"` requires a valid `assignee_id` on every task. Assignment and dependency errors come back as `result.status: "INVALID_INPUT"` with task-specific details in `result.errors`. Use `POST /api/validate?require_assignments=true` to check the same rules before solving.
- When `scheduling_mode` is omitted or null, a nonempty `members` list or any non-null `assignee_id` selects member scheduling. A project with neither uses the temporary legacy mode. `scheduling_mode: "legacy"` also selects that mode explicitly.
- Member scheduling minimizes makespan with one task at a time per assigned member and respects dependency order. The T1 schema still accepts the legacy capacity and stage fields for compatibility. Member scheduling ignores them and treats Kanban status as progress metadata.
- `result.scheduling_mode` identifies the mode used. Member results return the assigned owner in each scheduled task's `assignee_id` and return empty `stage_metrics` and `bottleneck_stages`. WIP and team-capacity deadline simulations run only in legacy mode. `UNKNOWN` means CP-SAT returned without a schedule or a proof of infeasibility.

## T3 migration

The current React UI, unassigned presets, Gemini drafts, and the legacy Streamlit app can still run with WIP and team capacity. Once React supports manual member management and assignment in T3, have it request member scheduling and defer solving presets and drafts until their owners are confirmed. Migrate the preset and parser contracts and retire or migrate the Streamlit caller before removing legacy request routing, WIP validation, capacity constraints, stage metrics, deadline simulations, and the compatibility fields.
