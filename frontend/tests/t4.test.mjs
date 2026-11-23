import assert from "node:assert/strict";
import { test } from "node:test";
import { dateAtOffset, dayOffset, formatDate, isCalendarDate } from "../src/calendar.ts";
import { initialPlans, planReducer } from "../src/plans.ts";

const baseline = Object.freeze({ status: "OPTIMAL", scheduledTasks: [{ id: "A", start_day: 0, end_day: 3 }], recovery: null });
const completed = Object.freeze({ id: "A", actual_finish_date: "2026-11-14", actual_end_day_exclusive: 3 });
const revised = Object.freeze({ status: "OPTIMAL", scheduledTasks: [{ id: "B", start_day: 3, end_day: 5 }],
  recovery: { completed_tasks: [completed], progress_as_of_date: "2026-11-14" } });
const propose = (state, plan, revision = state.revision) => planReducer(state, { type: "propose", revision, plan });
const accept = (state) => planReducer(state, { type: "accept" });

test("R7/R10: preview, cancel and acceptance preserve history and the initial baseline", () => {
  const initialPreview = propose(initialPlans, baseline);
  assert.equal(initialPreview.accepted, null);
  const active = accept(initialPreview);
  const preview = propose(active, revised);
  assert.equal(preview.accepted, baseline);
  assert.equal(preview.proposal.plan.recovery.completed_tasks[0].actual_finish_date, "2026-11-14");
  const canceled = planReducer(preview, { type: "cancel" });
  assert.equal(canceled.accepted, baseline);
  assert.equal(canceled.proposal, null);
  const applied = accept(propose(canceled, revised));
  assert.equal(applied.accepted, revised);
  assert.equal(applied.baseline, baseline);
  assert.equal(applied.accepted.recovery.completed_tasks[0], completed);
});

test("R11: editing inputs invalidates displayed and in-flight proposals", () => {
  const active = accept(propose(initialPlans, baseline));
  const preview = propose(active, revised);
  const edited = planReducer(preview, { type: "inputsChanged" });
  assert.equal(edited.proposal, null);
  assert.equal(edited.stale, true);
  assert.equal(propose(edited, revised, preview.revision), edited);
  assert.equal(accept(edited).accepted, baseline);
  assert.equal(accept(propose(edited, revised)).accepted, revised);
  const reset = planReducer(preview, { type: "reset" });
  assert.equal(propose(reset, revised, preview.revision), reset);
  assert.equal(accept(reset).accepted, null);
});

test("D1–D6: chart dates and end-of-day boundaries match the API convention", () => {
  const start = "2026-11-12";
  assert.equal(dayOffset(start, "2026-11-12"), 0);
  assert.equal(dayOffset(start, "2026-11-17"), 5);
  assert.equal(dayOffset(start, "2026-12-11"), 29);
  assert.equal(formatDate(dateAtOffset(start, 3 - 1)), "14/11/2026");
  assert.equal(dateAtOffset(start, 3), "2026-11-15");
  assert.equal(dateAtOffset("2026-12-11", 1), "2026-12-12");
  assert.equal(dateAtOffset("2026-12-31", 2), "2027-01-02");
  assert.equal(dateAtOffset("2028-02-28", 1), "2028-02-29");
  assert.equal(dateAtOffset("2026-11-17", 1), "2026-11-18");
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2028-02-29"), true);
});
