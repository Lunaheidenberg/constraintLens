import assert from "node:assert/strict";
import { test } from "node:test";
import { dateAtOffset, dayOffset } from "../src/calendar.ts";
import { assessDeadline, canAcceptProposal, comparisonPair, initialPlans, planReducer } from "../src/plans.ts";
import { matchesReportedStatuses, progressFromPlan } from "../src/progressReport.ts";

const START = "2026-11-13";
const DEADLINE = "2026-11-22";
const propose = (state, plan, confirmation) => planReducer(state, { type: "propose", revision: state.revision, plan, confirmation });
const accept = (state) => planReducer(state, { type: "accept" });

function plan(finalDate, deadline = DEADLINE, status = "OPTIMAL") {
  const duration = dayOffset(START, finalDate) + 1;
  const task = { id: "A", name: "Thiết kế", assignee_id: "mai", duration, status: "To Do" };
  return {
    status, tasks: [task], scheduledTasks: [{ ...task, start_day: 0, end_day: duration }], recovery: null,
    calendar: {
      project_start_date: START, target_deadline_date: deadline, project_finish_day_exclusive: duration,
      project_finish_date_exclusive: dateAtOffset(finalDate, 1), final_work_date: finalDate,
    },
  };
}

test("D1: an optimal late initial schedule stays visible and cannot be accepted, including repeated attempts", () => {
  const late = plan("2026-11-24");
  const preview = propose(initialPlans, late);
  assert.equal(preview.proposal.plan, late);
  assert.equal(preview.proposal.source, "planning");
  assert.deepEqual(assessDeadline(late), { deadline: DEADLINE, finalDate: "2026-11-24", daysLate: 2 });
  assert.equal(canAcceptProposal(preview), false);
  assert.equal(accept(accept(preview)), preview);
  assert.equal(preview.accepted, null);
});

test("D2–D4: exact, early, and no-deadline finishes can be accepted", () => {
  for (const [finalDate, deadline, daysLate] of [
    [DEADLINE, DEADLINE, 0], ["2026-11-20", DEADLINE, 0], ["2026-11-24", null, undefined],
  ]) {
    const candidate = plan(finalDate, deadline);
    const preview = propose(initialPlans, candidate);
    assert.equal(assessDeadline(candidate)?.daysLate, daysLate);
    assert.equal(canAcceptProposal(preview), true);
    const accepted = accept(preview);
    assert.equal(accepted.accepted, candidate);
    assert.equal(accept(accepted), accepted);
  }
});

test("D5 and D11: a late recovery cannot replace the accepted plan or erase the confirmed report", () => {
  const original = plan(DEADLINE);
  const active = accept(propose(initialPlans, original));
  const late = plan("2026-11-24");
  const completed = { id: "A", actual_finish_date: "2026-11-15" };
  const doing = { id: "B", duration: 9, status: "Doing" };
  late.tasks = [{ ...original.tasks[0], status: "Done" }, doing, { id: "C", status: "To Do" }];
  late.scheduledTasks = [{ ...doing, start_day: 5, end_day: 10, duration: 5 }];
  late.recovery = { progress_as_of_date: "2026-11-17", completed_tasks: [completed] };
  const snapshot = {
    progress_as_of_date: "2026-11-17", task_progress: { A: { actual_finish_date: "2026-11-15" }, B: { remaining_duration: 5 } },
  };
  const confirmation = { snapshot, completedTasks: [completed] };
  const preview = propose(active, late, confirmation);
  assert.equal(preview.proposal.source, "progress");
  assert.equal(comparisonPair(preview).revised, late);
  assert.equal(accept(preview), preview);
  assert.deepEqual(progressFromPlan(late), snapshot);
  for (const action of ["cancel", "inputsChanged"]) {
    const state = planReducer(preview, { type: action });
    assert.equal(state.accepted, original);
    assert.equal(state.proposal, null);
    assert.equal(state.confirmedProgress, confirmation);
  }
  const editedTasks = late.tasks.map((task) => task.id === "B" ? { ...task, duration: 12, assignee_id: "an" } : task);
  assert.equal(matchesReportedStatuses(editedTasks, snapshot), true);
  assert.equal(matchesReportedStatuses(editedTasks.slice(1), snapshot), false);
  assert.equal(matchesReportedStatuses([...editedTasks, { id: "D", status: "Doing" }], snapshot), false);
  assert.equal(matchesReportedStatuses([{ ...editedTasks[0], status: "To Do" }, ...editedTasks.slice(1)], snapshot), false);
  const replacement = { ...late, calendar: plan(DEADLINE).calendar, tasks: editedTasks };
  const updated = accept(propose(planReducer(preview, { type: "inputsChanged" }), replacement));
  assert.equal(updated.accepted, replacement);
  assert.equal(updated.previous, original);
  assert.equal(updated.confirmedProgress, confirmation);
});

test("D6–D7: an edit invalidates the late proposal and its in-flight response before a new solve", () => {
  const late = plan("2026-11-24");
  const preview = propose(initialPlans, late);
  const edited = planReducer(preview, { type: "inputsChanged" });
  assert.equal(edited.proposal, null);
  assert.equal(edited.stale, true);
  assert.equal(accept(edited), edited);
  assert.equal(planReducer(edited, { type: "propose", plan: late, revision: preview.revision }), edited);
  const revised = plan(DEADLINE);
  assert.equal(accept(propose(edited, revised)).accepted, revised);
});

test("D8: an existing late plan remains available for a warning, including when the current deadline changes", () => {
  const late = plan("2026-11-24");
  const legacy = { ...initialPlans, accepted: late, baseline: late };
  const edited = planReducer(legacy, { type: "inputsChanged" });
  assert.equal(accept(edited).accepted, late);
  assert.equal(assessDeadline(edited.accepted).daysLate, 2);
  assert.equal(assessDeadline(edited.accepted, "2026-11-23").daysLate, 1);
  assert.equal(assessDeadline(edited.accepted, null), null);
});

test("D9: solver status is independent of deadline compliance and unsolved results cannot be accepted", () => {
  for (const status of ["OPTIMAL", "FEASIBLE"]) {
    assert.equal(canAcceptProposal(propose(initialPlans, plan("2026-11-24", DEADLINE, status))), false);
    assert.equal(canAcceptProposal(propose(initialPlans, plan(DEADLINE, DEADLINE, status))), true);
  }
  for (const status of ["UNKNOWN", "INFEASIBLE", "INVALID_INPUT", "MODEL_INVALID"]) {
    const invalid = plan(DEADLINE, DEADLINE, status);
    assert.equal(propose(initialPlans, invalid).proposal, null);
    const restored = { ...initialPlans, proposal: { revision: 0, plan: invalid, source: "planning" } };
    assert.equal(accept(restored), restored);
  }
  const missing = plan(DEADLINE);
  missing.calendar.project_finish_date_exclusive = null;
  assert.equal(canAcceptProposal(propose(initialPlans, missing)), false);
});

test("D10: lateness counts weekend days and crosses months and years", () => {
  for (const [deadline, finish, daysLate] of [
    ["2026-11-20", "2026-11-21", 1], ["2026-11-20", "2026-11-23", 3],
    ["2026-11-30", "2026-12-01", 1], ["2026-12-31", "2027-01-01", 1],
  ]) {
    assert.equal(assessDeadline(plan(finish, deadline)).daysLate, daysLate);
  }
});
