import assert from "node:assert/strict";
import test from "node:test";
import { initialPlans, planReducer } from "../src/plans.ts";
import {
  collectTaskProgress, hasProgressReportEdits, parseRemainingDuration, plannedRemainingDays, remainingDurationDifference,
} from "../src/progressReport.ts";

const reportingDate = "2026-11-17";
const accepted = {
  status: "OPTIMAL",
  calendar: { project_start_date: "2026-11-13" },
  scheduledTasks: [
    { id: "T3", start_day: 3, end_day: 7 },
    { id: "T4", start_day: 3, end_day: 6 },
  ],
};
const auth = Object.freeze({ id: "T3", status: "Doing", duration: 4, assignee_id: "mai" });
const cart = Object.freeze({ id: "T4", status: "Doing", duration: 3, assignee_id: "an" });

test("F2: report comparison uses the reporting date, remaining days and actual finish dates", () => {
  const done = { ...cart, status: "Done" };
  const confirmed = {
    progress_as_of_date: reportingDate,
    task_progress: { [done.id]: { actual_finish_date: "2026-11-16" }, [auth.id]: { remaining_duration: 8 } },
  };
  const draft = (duration, finish) =>
    collectTaskProgress([auth, done], new Map([[auth.id, duration], [done.id, finish]]), new Map());

  assert.equal(hasProgressReportEdits("17/11/2026", draft("8", "16/11/2026"), confirmed), false);
  assert.equal(hasProgressReportEdits(" 17/11/2026 ", draft("08", " 16/11/2026 "), confirmed), false);
  assert.equal(hasProgressReportEdits("17/11/2026", draft("20", "16/11/2026"), confirmed), true);
  assert.equal(hasProgressReportEdits("18/11/2026", draft("8", "16/11/2026"), confirmed), true);
  assert.equal(hasProgressReportEdits("2026-11-17", draft("8", "16/11/2026"), confirmed), true);
  assert.equal(hasProgressReportEdits("17/11/2026", draft("8", "15/11/2026"), confirmed), true);
  assert.equal(hasProgressReportEdits("17/11/2026", draft("8", ""), confirmed), true);
  assert.equal(hasProgressReportEdits("17/11/2026", draft("8", "31/11/2026"), confirmed), true);
});

test("F2: absent and blank entries are equivalent before the first report", () => {
  const draft = collectTaskProgress([{ ...auth, status: "To Do" }], new Map([[auth.id, "8"]]), new Map());
  assert.equal(hasProgressReportEdits(" ", draft, null), false);
  assert.equal(hasProgressReportEdits("17/", draft, null), true);
  assert.equal(hasProgressReportEdits("17/11/2026", draft, null), true);
});

test("P1: Nov 17 closes the reporting day; Auth has Nov 18 and 19 left", () => {
  assert.equal(plannedRemainingDays(accepted, reportingDate).get("T3"), 2);
});

test("P2: +5 days is the comparison; the request still uses all 7 days", () => {
  const entered = "7";
  const planned = plannedRemainingDays(accepted, reportingDate).get(auth.id);
  assert.equal(remainingDurationDifference(planned, parseRemainingDuration(entered)), 5);
  assert.deepEqual(collectTaskProgress([auth], new Map([[auth.id, entered]]), new Map()), {
    taskProgress: { T3: { remaining_duration: 7 } },
    errors: [],
  });
});

test("P3: Cart independently has one day left and no change", () => {
  const planned = plannedRemainingDays(accepted, reportingDate).get(cart.id);
  assert.equal(planned, 1);
  assert.equal(remainingDurationDifference(planned, parseRemainingDuration("1")), 0);
});

test("P4: report before the task starts leaves the full scheduled interval", () => {
  assert.equal(plannedRemainingDays(accepted, "2026-11-14").get("T3"), 4);
  assert.equal(plannedRemainingDays(accepted, "2026-11-15").get("T3"), 4);
  assert.equal(remainingDurationDifference(4, parseRemainingDuration("2")), -2);
});

test("P5: a planned finish on or before the report leaves zero planned days", () => {
  for (const date of ["2026-11-19", "2026-11-20"]) {
    const planned = plannedRemainingDays(accepted, date).get(auth.id);
    assert.equal(planned, 0);
    assert.equal(remainingDurationDifference(planned, parseRemainingDuration("2")), 2);
  }
});

test("P6: missing or invalid reference data never becomes zero planned days", () => {
  assert.equal(plannedRemainingDays(null, reportingDate).size, 0);
  assert.equal(plannedRemainingDays(accepted, "").size, 0);
  assert.equal(plannedRemainingDays(accepted, "2026-11-31").size, 0);
  assert.equal(plannedRemainingDays(accepted, reportingDate).has("unknown"), false);
  const invalid = { ...accepted, scheduledTasks: [
    { id: "zero", start_day: 3, end_day: 3 },
    { id: "fraction", start_day: 2.5, end_day: 7 },
    { id: "before", start_day: -1, end_day: 3 },
    { id: "overflow", start_day: 3, end_day: Number.MAX_SAFE_INTEGER },
  ] };
  assert.equal(plannedRemainingDays(invalid, reportingDate).size, 0);
  assert.equal(plannedRemainingDays({ ...accepted, calendar: { project_start_date: "" } }, reportingDate).size, 0);
  assert.equal(remainingDurationDifference(undefined, parseRemainingDuration("7")), null);
});

test("P7: changing the reporting day or accepting a new plan re-evaluates only the reference", () => {
  const entries = new Map([[auth.id, "7"], [cart.id, "1"]]);
  const propose = (state, plan) => planReducer(state, { type: "propose", revision: state.revision, plan });
  const accept = (state) => planReducer(state, { type: "accept" });
  const active = accept(propose(initialPlans, accepted));
  const proposal = propose(active, {
    ...accepted,
    calendar: { project_start_date: "2026-11-14" },
    scheduledTasks: [{ id: "T3", start_day: 4, end_day: 11 }],
  });

  assert.equal(plannedRemainingDays(proposal.accepted, reportingDate).get(auth.id), 2);
  const nextReference = plannedRemainingDays(proposal.accepted, "2026-11-18").get(auth.id);
  assert.equal(nextReference, 1);
  assert.equal(remainingDurationDifference(nextReference, parseRemainingDuration(entries.get(auth.id))), 6);
  const applied = accept(proposal);
  assert.equal(applied.baseline, accepted);
  assert.equal(plannedRemainingDays(applied.accepted, reportingDate).get(auth.id), 7);
  assert.deepEqual(collectTaskProgress([auth, cart], entries, new Map()).taskProgress,
    { T3: { remaining_duration: 7 }, T4: { remaining_duration: 1 } });
});

test("P8: invalid durations are flagged, To Do is omitted, and Done keeps confirmed history", () => {
  const locked = Object.freeze({ actual_finish_date: "2026-11-15" });
  const tasks = [
    Object.freeze({ id: "T1", status: "Done" }), Object.freeze({ id: "T2", status: "Done" }),
    auth, cart, Object.freeze({ id: "T5", status: "To Do", duration: 3 }),
  ];
  const entries = new Map([["T1", "16/11/2026"], ["T2", "16/11/2026"], ["T3", "7"], ["T4", "1"], ["T5", "4"]]);
  const completed = new Map([["T1", locked]]);
  assert.deepEqual(collectTaskProgress(tasks, entries, completed), {
    taskProgress: {
      T1: { actual_finish_date: "2026-11-15" }, T2: { actual_finish_date: "2026-11-16" },
      T3: { remaining_duration: 7 }, T4: { remaining_duration: 1 },
    },
    errors: [],
  });
  for (const invalid of ["0", "-1", "2.5", "9007199254740992"]) {
    entries.set("T4", invalid);
    const { taskProgress, errors } = collectTaskProgress(tasks, entries, completed);
    assert.equal(taskProgress.T4, undefined);
    assert.equal(remainingDurationDifference(1, parseRemainingDuration(invalid)), null);
    assert.match(errors.join(), /số nguyên dương.*T4/);
  }
  entries.set("T4", "");
  entries.set("T2", "31/11/2026");
  const { taskProgress, errors } = collectTaskProgress(tasks, entries, completed);
  assert.equal(taskProgress.T4, undefined); // Missing entries are still validated by FastAPI.
  assert.match(errors.join(), /ngày hoàn thành thực tế.*T2/);
  assert.equal(completed.get("T1"), locked);
});
