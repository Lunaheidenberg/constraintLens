import assert from "node:assert/strict";
import { test } from "node:test";
import { dateAtOffset, formatDate, parseDateInput } from "../src/calendar.ts";
import { initialPlans, planReducer } from "../src/plans.ts";
import { hasUnscheduledStatusChanges, todoTasksDueForReview } from "../src/progressReview.ts";
import { prepareScheduleResult } from "../src/schedulingFeedback.ts";

test("D1–D5: dates display day first and round-trip to ISO, including year boundaries and leap day", () => {
  const dates = [
    ["03/04/2026", "2026-04-03"],
    ["17/11/2026", "2026-11-17"],
    ["31/12/2026", "2026-12-31"],
    ["01/01/2027", "2027-01-01"],
    ["29/02/2028", "2028-02-29"],
  ];
  for (const [display, iso] of dates) {
    assert.equal(parseDateInput(display), iso);
    assert.equal(formatDate(iso), display);
  }
  assert.equal(formatDate(dateAtOffset(parseDateInput("31/12/2026"), 1)), "01/01/2027");
  assert.equal(formatDate(dateAtOffset(parseDateInput("28/02/2028"), 1)), "29/02/2028");
  assert.equal(parseDateInput(" 03/04/2026 "), "2026-04-03");
});

test("D3: impossible dates, partial dates and other formats are rejected", () => {
  for (const input of ["31/02/2026", "29/02/2026", "00/01/2026", "01/13/2026", "01/01/0000",
    "03/04", "3/4/2026", "2026-04-03", "11/17/2026", ""]) {
    assert.equal(parseDateInput(input), null, input);
  }
});

test("S3: fast successful responses prepare the result and wait only for the remaining time", async ({ mock }) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const preparing = mock.fn();
  let revealed = false;
  const startedAt = performance.now() - 300;
  const result = prepareScheduleResult(startedAt, new AbortController().signal, preparing).then((allowed) => {
    revealed = allowed;
  });
  assert.equal(preparing.mock.callCount(), 1);
  mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(revealed, false);
  mock.timers.tick(225);
  await result;
  assert.equal(revealed, true);
});

test("S4: slow successful responses skip the preparation phase", async ({ mock }) => {
  const preparing = mock.fn();
  const allowed = await prepareScheduleResult(performance.now() - 1200, new AbortController().signal, preparing);
  assert.equal(allowed, true);
  assert.equal(preparing.mock.callCount(), 0);
});

test("S7: aborting before or during preparation prevents reveal", async ({ mock }) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const preparing = mock.fn();
  const canceled = new AbortController();
  canceled.abort();
  assert.equal(await prepareScheduleResult(performance.now(), canceled.signal, preparing), false);
  assert.equal(preparing.mock.callCount(), 0);
  const pending = new AbortController();
  const result = prepareScheduleResult(performance.now(), pending.signal, preparing);
  pending.abort();
  assert.equal(await result, false);
  assert.equal(preparing.mock.callCount(), 1);
});

const tasks = [
  { id: "T4", name: "Tích hợp chức năng", status: "To Do" },
  { id: "T5", name: "Kiểm thử", status: "To Do" },
  { id: "T6", name: "Bàn giao", status: "To Do" },
  { id: "T7", name: "Đang làm", status: "Doing" },
  { id: "T8", name: "Đã hoàn thành", status: "Done" },
  { id: "T9", name: "Mới thêm", status: "To Do" },
];
const accepted = {
  status: "OPTIMAL",
  calendar: { project_start_date: "2026-11-12" },
  scheduledTasks: [3, 5, 6, 0, 0].map((start_day, index) => ({ id: tasks[index].id, start_day })),
};

test("P1–P5: only To Do tasks starting on or before the report date in the accepted plan are flagged", () => {
  assert.deepEqual(todoTasksDueForReview(accepted, tasks, "2026-11-17"), [
    { id: "T4", name: "Tích hợp chức năng", plannedStart: "2026-11-15" },
    { id: "T5", name: "Kiểm thử", plannedStart: "2026-11-17" },
  ]);
  assert.deepEqual(todoTasksDueForReview(null, tasks, "2026-11-17"), []);
  assert.deepEqual(todoTasksDueForReview(accepted, tasks, ""), []);
});

test("P7: a Kanban status change removes the task from review", () => {
  const updated = [{ ...tasks[0], status: "Doing" }, ...tasks.slice(1)];
  assert.deepEqual(todoTasksDueForReview(accepted, updated, "2026-11-17").map(({ id }) => id), ["T5"]);
});

test("status changes are measured against the accepted snapshot until another plan is accepted", () => {
  const planned = [{ id: "T4" }, { id: "T7", status: "Doing" }];
  const current = [{ id: "T4", status: "To Do" }, planned[1]];
  const changed = [{ id: "T4", status: "Doing" }, planned[1]];
  const propose = (state, tasks) => planReducer(state, {
    type: "propose", revision: state.revision, plan: { status: "OPTIMAL", tasks },
  });
  const active = planReducer(propose(initialPlans, planned), { type: "accept" });
  const preview = propose(planReducer(active, { type: "inputsChanged" }), changed);

  assert.equal(hasUnscheduledStatusChanges(null, changed), false);
  assert.equal(hasUnscheduledStatusChanges(active.accepted, [...current, { id: "new", status: "Doing" }]), false);
  assert.equal(hasUnscheduledStatusChanges(preview.accepted, changed), true);
  assert.equal(hasUnscheduledStatusChanges(planReducer(preview, { type: "cancel" }).accepted, changed), true);
  assert.equal(hasUnscheduledStatusChanges(preview.accepted, current), false);
  assert.equal(hasUnscheduledStatusChanges(planReducer(preview, { type: "accept" }).accepted, changed), false);
});

test("P6, P8–P10: confirmation survives proposal cancellation and resets on input changes or accepting a plan", () => {
  const propose = (state, plan) => planReducer(state, { type: "propose", revision: state.revision, plan });
  const active = planReducer(propose(initialPlans, accepted), { type: "accept" });
  assert.equal(planReducer(initialPlans, { type: "confirmTodo" }).todoConfirmed, false);
  const confirmed = planReducer(active, { type: "confirmTodo" });
  assert.equal(confirmed.todoConfirmed, true);
  assert.equal(planReducer(confirmed, { type: "inputsChanged" }).todoConfirmed, false);
  assert.equal(planReducer(confirmed, { type: "reset" }).todoConfirmed, false);

  const revised = { ...accepted, scheduledTasks: [{ id: "T4", start_day: 6 }] };
  const preview = propose(confirmed, revised);
  assert.equal(preview.accepted, accepted);
  const canceled = planReducer(preview, { type: "cancel" });
  assert.equal(canceled.todoConfirmed, true);
  assert.equal(canceled.accepted, accepted);
  const applied = planReducer(preview, { type: "accept" });
  assert.equal(applied.todoConfirmed, false);
  assert.equal(applied.previous, accepted);
  assert.deepEqual(todoTasksDueForReview(applied.accepted, tasks, "2026-11-17"), []);
});
