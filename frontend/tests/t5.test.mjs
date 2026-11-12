import assert from "node:assert/strict";
import { test } from "node:test";
import { dayOffset } from "../src/calendar.ts";
import { comparePlans, hasTaskChange } from "../src/comparison.ts";
import { comparisonPair, initialPlans, planReducer } from "../src/plans.ts";

const START = "2026-11-12";
const TARGET = "2026-12-11";
const work = (id, start, end, assignee = "mai") => ({
  id, name: "Shared task name", assignee_id: assignee, start_day: start, end_day: end,
  duration: end - start, dependencies: [], kanban_stage: "Coding", earliest_ready_day: start, queue_wait_days: 0,
});
const completion = (id, date) => ({ id, name: "Shared task name", assignee_id: "mai", actual_finish_date: date });
const recovery = (completed_tasks = [], horizon = 5) => ({
  completed_tasks, remaining_horizon_days: horizon, progress_as_of_date: "2026-11-20",
  replanning_start_day: 9, replanning_start_date: "2026-11-21",
});

function plan(finish, options = {}) {
  const { start = START, target = null, tasks = [work("A", 0, 1)], progress = null, status = "OPTIMAL",
    members = [{ id: "mai", name: "Mai" }, { id: "an", name: "An" }] } = options;
  const metadata = [
    ...tasks.map((task) => ({ ...task, status: "To Do" })),
    ...(progress?.completed_tasks ?? []).map((task) => ({ ...task, status: "Done", duration: 1, dependencies: [], kanban_stage: "Coding" })),
  ];
  return Object.freeze({
    status, scheduleRevision: 1, solveTimeMs: 1, scheduledTasks: tasks, tasks: metadata, members, recovery: progress,
    calendar: {
      project_start_date: start, target_deadline_date: target, project_finish_date_exclusive: finish,
      project_finish_day_exclusive: finish ? dayOffset(start, finish) : null,
    },
  });
}

const propose = (state, snapshot, revision = state.revision) => planReducer(state, { type: "propose", revision, plan: snapshot });
const accept = (state) => planReducer(state, { type: "accept" });
const baseline = plan("2026-11-24", { tasks: [work("A", 0, 12)] });
const revised = plan("2026-11-28", { tasks: [work("A", 9, 16)], progress: recovery([], 7) });
const active = accept(propose(initialPlans, baseline));

test("C1: a later stored finish gives a positive calendar-day delta", () => {
  const result = comparePlans(baseline, revised);
  assert.deepEqual(result.previousFinish, { boundary: "2026-11-24", finalDate: "2026-11-23", actual: false });
  assert.equal(result.revisedFinish.boundary, "2026-11-28");
  assert.equal(result.finishDelta, 4);
  assert.equal(result.remainingHorizon, 7);
});

test("C2: an earlier stored finish gives a negative delta", () => {
  assert.equal(comparePlans(revised, baseline).finishDelta, -4);
});

test("C3: unchanged project finish can coexist with changed tasks", () => {
  const before = plan("2026-11-24", { tasks: [work("A", 2, 5), work("B", 8, 12)] });
  const after = plan("2026-11-24", { tasks: [work("A", 0, 3), work("B", 8, 12)] });
  const result = comparePlans(before, after);
  assert.equal(result.finishDelta, 0);
  assert.equal(result.movedCount, 1);
  assert.deepEqual(result.tasks.map(({ startDelta, finishDelta }) => [startDelta, finishDelta]), [[-2, -2], [0, 0]]);
});

test("C4: match IDs across reordered snapshots with equal display names", () => {
  const before = plan("2026-11-24", { tasks: [work("A", 0, 2), work("B", 4, 6)] });
  const after = plan("2026-11-24", { tasks: [work("B", 4, 6, "an"), work("A", 1, 3)] });
  const result = comparePlans(before, after);
  const [a, b] = result.tasks;
  assert.deepEqual([a.id, a.moved, a.startDelta, a.finishDelta], ["A", true, 1, 1]);
  assert.deepEqual([b.id, b.unchanged, b.assigneeChanged, b.previous.assignee, b.revised.assignee], ["B", true, true, "Mai", "An"]);
  assert.equal(a.previous.interval.finalWorkDate, "2026-11-13");
});

test("C5: same calendar intervals are unchanged even if project offsets changed", () => {
  const before = plan("2026-11-17", { tasks: [work("A", 2, 5)] });
  const after = plan("2026-11-17", { start: "2026-11-13", tasks: [work("A", 1, 4)] });
  const result = comparePlans(before, after);
  assert.equal(result.unchangedCount, 1);
  assert.equal(result.movedCount, 0);
  assert.equal(hasTaskChange(result.tasks[0]), false);
});

test("C6: a newly confirmed completion keeps the old interval and adds only an actual date", () => {
  const before = plan("2026-11-24", { tasks: [work("A", 0, 2), work("B", 9, 12)] });
  const after = plan("2026-11-24", { tasks: [work("B", 9, 12)], progress: recovery([completion("A", "2026-11-15")], 3) });
  const result = comparePlans(before, after);
  const [a] = result.tasks;
  assert.equal(a.previous.interval.start, START);
  assert.deepEqual([a.revised.done, a.revised.actualFinish, a.revised.interval], [true, "2026-11-15", null]);
  assert.deepEqual([a.startDelta, a.finishDelta, a.moved, a.durationChanged, a.unchanged], [null, null, false, false, false]);
  assert.deepEqual([result.confirmedCount, result.newlyConfirmedCount, result.unchangedCount], [1, 1, 1]);
  assert.equal(comparePlans(after, after).newlyConfirmedCount, 0);
});

test("C7: a duration change is separate from the movement flag", () => {
  const result = comparePlans(baseline, revised);
  assert.deepEqual(result.tasks.map(({ moved, durationChanged }) => [moved, durationChanged]), [[true, true]]);
  const sameDuration = plan("2026-11-25", { tasks: [work("A", 1, 13)] });
  assert.deepEqual(comparePlans(baseline, sameDuration).tasks.map(({ moved, durationChanged }) => [moved, durationChanged]), [[true, false]]);
});

test("C8: inclusive target day counts as on time", () => {
  const onTime = plan("2026-12-12", { target: TARGET });
  const result = comparePlans(onTime, onTime);
  assert.deepEqual(result.deadline.revised, { status: "on_time", daysLate: 0 });
  assert.equal(result.deadline.latenessDelta, 0);
});

test("C9: deadline miss and recovery use the same target for both plans", () => {
  const onTime = plan("2026-12-12", { target: TARGET });
  const late = plan("2026-12-15", { target: TARGET });
  assert.deepEqual(comparePlans(onTime, late).deadline, {
    target: TARGET, previous: { status: "on_time", daysLate: 0 }, revised: { status: "late", daysLate: 3 }, latenessDelta: 3,
  });
  assert.equal(comparePlans(late, onTime).deadline.latenessDelta, -3);
  assert.equal(comparePlans(plan("2026-12-12", { target: "2026-11-30" }), late).deadline.previous.status, "on_time");
});

test("C10: comparisons without a revised deadline still show finish impact", () => {
  const result = comparePlans(plan("2026-11-24", { target: TARGET }), revised);
  assert.equal(result.deadline, null);
  assert.equal(result.finishDelta, 4);
});

test("C11: finish deltas cross month, year, leap day and DST boundaries", () => {
  for (const [start, before, after, days] of [
    ["2026-11-01", "2026-11-29", "2026-12-02", 3],
    ["2026-12-01", "2026-12-31", "2027-01-02", 2],
    ["2028-02-01", "2028-02-28", "2028-03-01", 2],
    ["2026-03-01", "2026-03-07", "2026-03-09", 2],
  ]) {
    assert.equal(comparePlans(plan(before, { start }), plan(after, { start })).finishDelta, days);
  }
});

test("C12: preview exposes comparison data without changing accepted or baseline", () => {
  assert.equal(comparisonPair(initialPlans), null);
  assert.equal(comparisonPair(propose(initialPlans, baseline)), null);
  assert.equal(comparisonPair(active), null);
  const preview = propose(active, revised);
  const pair = comparisonPair(preview, "baseline");
  assert.deepEqual(pair, { mode: "proposal", previous: baseline, revised });
  assert.equal(comparePlans(pair.previous, pair.revised).finishDelta, 4);
  assert.equal(preview.accepted, baseline);
  assert.equal(preview.previous, null);
});

test("C13: cancel discards preview and preserves accepted, previous and baseline", () => {
  const history = accept(propose(active, revised));
  const rejected = plan("2026-12-01");
  const canceled = planReducer(propose(history, rejected), { type: "cancel" });
  assert.deepEqual(comparisonPair(canceled), { mode: "previous", previous: baseline, revised });
  assert.equal(canceled.baseline, baseline);
  assert.equal(canceled.accepted, revised);
  assert.equal(canceled.proposal, null);
});

test("C14: acceptance retains the immediately previous plan and preserves the baseline across revisions", () => {
  const baselineBefore = structuredClone(baseline);
  const latest = plan("2026-11-26", { status: "FEASIBLE" });
  const first = accept(propose(active, revised));
  assert.deepEqual(comparisonPair(first), { mode: "previous", previous: baseline, revised });
  const second = accept(propose(first, latest));
  assert.deepEqual(comparisonPair(second), { mode: "previous", previous: revised, revised: latest });
  assert.deepEqual(comparisonPair(second, "baseline"), { mode: "baseline", previous: baseline, revised: latest });
  assert.equal(second.accepted, latest);
  assert.equal(second.baseline, baseline);
  assert.deepEqual(second.baseline, baselineBefore);
  assert.equal(second.proposal, null);
});

test("C15: input edits remove pending impact and reject late responses and stale acceptance", () => {
  const preview = propose(active, revised);
  const edited = planReducer(preview, { type: "inputsChanged" });
  assert.equal(comparisonPair(edited), null);
  assert.equal(edited.stale, true);
  assert.equal(propose(edited, revised, preview.revision), edited);
  assert.equal(accept(edited), edited);
  assert.equal(edited.accepted, baseline);
  const historical = planReducer(accept(preview), { type: "inputsChanged" });
  assert.equal(comparisonPair(historical).mode, "previous");
  assert.notEqual(historical.acceptedRevision, historical.revision);
});

test("C16: all-Done uses actual completion before the reporting day, with a zero remaining horizon", () => {
  for (const finish of ["2026-11-16", null]) {
    const allDone = plan(finish, { tasks: [], progress: recovery([completion("A", "2026-11-15")], 0) });
    const result = comparePlans(baseline, allDone);
    assert.deepEqual(result.revisedFinish, { boundary: "2026-11-16", finalDate: "2026-11-15", actual: true });
    assert.equal(result.finishDelta, -8);
    assert.equal(result.remainingHorizon, 0);
    assert.equal(result.replanningDate, "2026-11-21");
    assert.equal(result.tasks[0].revised.interval, null);
  }
});

test("C17: solver failures have no comparison or acceptable proposal", () => {
  for (const status of ["INFEASIBLE", "UNKNOWN", "MODEL_INVALID", "INVALID_INPUT"]) {
    const failed = plan(null, { tasks: [], status });
    assert.equal(comparePlans(baseline, failed), null);
    const state = propose(propose(active, revised), failed);
    assert.equal(comparisonPair(state), null);
    assert.equal(accept(state).accepted, baseline);
  }
});

test("invalid dates and unmatched IDs preserve unavailable values", () => {
  const invalid = plan("2026-02-30", { target: TARGET, tasks: [work("A", -1, 4), work("B", 4, 6)] });
  const result = comparePlans(baseline, invalid);
  assert.equal(result.revisedFinish.boundary, null);
  assert.equal(result.finishDelta, null);
  assert.equal(result.deadline.revised, null);
  assert.equal(result.deadline.latenessDelta, null);
  assert.equal(result.tasks[0].revised.interval, null);
  assert.equal(result.tasks[0].startDelta, null);
  assert.equal(result.tasks[1].previous, null);
  assert.equal(result.unchangedCount, 0);
});
