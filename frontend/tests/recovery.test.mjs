import assert from "node:assert/strict";
import { test } from "node:test";
import { initialPlans, planReducer } from "../src/plans.ts";
import { explainRecovery } from "../src/recoveryApi.ts";
import { acceptedRecoveryContext, recoveryContext } from "../src/recoveryContext.ts";
import { describeRecoveryFact, summarizeRecovery } from "../src/recoveryFacts.ts";

test("F5: Recovery uses scheduled order and keeps completed work out of that order", () => {
  const render = (kind, data, task_ids) => describeRecoveryFact({ kind, data, task_ids }, (id) => id);
  for (const scheduled_order of [["T2", "T1"], ["T1", "T2"]]) {
    const description = render("shared_assignee", { scheduled_order }, ["T1", "T2", "Done"]);
    assert.ok(description.includes(scheduled_order.join(" → ")));
    assert.ok(!description.includes("Done"));
  }
  const withoutOrder = render("shared_assignee", { scheduled_order: ["T2"] }, ["Done", "T2"]);
  assert.ok(!withoutOrder.includes("thứ tự"));
  assert.match(render("parallel", { overlap_start_date: "2026-11-20", overlap_end_date_exclusive: "2026-11-21" },
    ["T1", "T2"]), /song song/);
  assert.equal(render("task", { actual_finish_date: "2026-11-19" }, ["Done"]),
    "Done hoàn thành thực tế ngày 19/11/2026.");
});

const original = {
  calendar: { project_start_date: "2026-11-20", target_deadline_date: "2026-11-26",
    final_work_date: "2026-11-24", project_finish_date_exclusive: "2026-11-25" },
  status: "OPTIMAL", recovery: null,
  tasks: [{ id: "T1", name: "Bàn giao", duration: 2, dependencies: [], assignee_id: "mai", status: "To Do" },
    { id: "T2", name: "Kiểm tra", duration: 3, dependencies: ["T1"], assignee_id: "mai", status: "To Do" }],
  scheduledTasks: [{ id: "T1", start_day: 0, end_day: 2, earliest_ready_day: 0, queue_wait_days: 0, duration: 2 },
    { id: "T2", start_day: 2, end_day: 5, earliest_ready_day: 2, queue_wait_days: 0, duration: 3 }],
};
const propose = (state, plan) => planReducer(state, { type: "propose", revision: state.revision, plan });
const accept = (state) => planReducer(state, { type: "accept" });

test("Recovery maps independent accepted and late proposal snapshots, including confirmed progress", () => {
  const active = accept(propose(initialPlans, original));
  const revised = {
    ...original,
    calendar: { ...original.calendar, final_work_date: "2026-11-29", project_finish_date_exclusive: "2026-11-30" },
    tasks: [{ ...original.tasks[0], status: "Done" }, { ...original.tasks[1], name: "Kiểm tra lại", status: "Doing" }],
    scheduledTasks: [{ ...original.scheduledTasks[1], end_day: 10, duration: 8 }],
    recovery: { progress_as_of_date: "2026-11-21", completed_tasks: [{ id: "T1", actual_finish_date: "2026-11-21" }] },
  };
  const preview = propose(active, revised);
  const stateBefore = structuredClone(preview);
  const context = recoveryContext(preview, 0);
  assert.equal(context.accepted.tasks[1].name, "Kiểm tra");
  assert.equal(context.accepted.progress, null);
  assert.deepEqual(context.accepted.calendar, { project_start_date: "2026-11-20", target_deadline_date: "2026-11-26" });
  assert.deepEqual(context.proposal.scheduled_tasks, [{ task_id: "T2", start_day: 2, end_day: 10, earliest_ready_day: 2, queue_wait_days: 0 }]);
  assert.deepEqual(context.proposal.tasks[1], { id: "T2", name: "Kiểm tra lại", estimated_duration: 3,
    dependencies: ["T1"], assignee_id: "mai", status: "Doing" });
  assert.deepEqual(context.proposal.progress, { progress_as_of_date: "2026-11-21", actual_finishes: { T1: "2026-11-21" },
    remaining_durations: { T2: 8 } });
  assert.notStrictEqual(context.proposal.tasks[1].dependencies, revised.tasks[1].dependencies);
  assert.notEqual(context.accepted.snapshot_ref, context.proposal.snapshot_ref);
  assert.notEqual(context.key, recoveryContext(propose(active, { ...revised }), 0).key);
  assert.notEqual(context.key, recoveryContext(preview, 1).key);
  assert.equal(context.key, recoveryContext(preview, 0).key);
  assert.deepEqual(preview, stateBefore);
  assert.equal(accept(preview), preview);
});

test("Recovery allows an initial or all-completed proposal and excludes missing, stale and historical schedules", () => {
  assert.equal(recoveryContext(initialPlans, 0), null);
  const initial = propose(initialPlans, original);
  assert.equal(recoveryContext(initial, 0).accepted, null);
  assert.equal(recoveryContext({ ...initial, revision: initial.revision + 1 }, 0), null);
  assert.equal(recoveryContext(propose(initialPlans, { ...original, scheduledTasks: [] }), 0), null);
  const active = accept(initial);
  const completed = propose(active, {
    ...original,
    tasks: original.tasks.map((task) => ({ ...task, status: "Done" })),
    scheduledTasks: [],
    recovery: { progress_as_of_date: "2026-11-24", completed_tasks: [
      { id: "T1", actual_finish_date: "2026-11-21" }, { id: "T2", actual_finish_date: "2026-11-24" },
    ] },
  });
  const context = recoveryContext(completed, 0);
  assert.deepEqual(context.proposal.scheduled_tasks, []);
  assert.deepEqual(context.proposal.progress.actual_finishes, { T1: "2026-11-21", T2: "2026-11-24" });
  const history = accept(completed);
  assert.equal(history.previous, original);
  assert.equal(recoveryContext(history, 0), null);

  assert.equal(acceptedRecoveryContext(initialPlans, 0), null);
  const singleAccepted = acceptedRecoveryContext(active, 0);
  assert.equal(singleAccepted.mode, "accepted");
  assert.equal(singleAccepted.accepted, null);
  assert.equal(singleAccepted.proposal.tasks.length, 2);

  const historyPrev = acceptedRecoveryContext(history, 0, "previous");
  assert.equal(historyPrev.mode, "history");
  assert.equal(historyPrev.accepted.tasks[0].name, "Bàn giao");
  assert.deepEqual(historyPrev.proposal.progress.actual_finishes, { T1: "2026-11-21", T2: "2026-11-24" });

  const historyBase = acceptedRecoveryContext(history, 0, "baseline");
  assert.equal(historyBase.mode, "history");
  assert.equal(historyBase.roleLabels.accepted, "Lịch gốc");
});

test("summarizeRecovery produces grounded 1-2 sentence TL;DR from verified facts only", () => {
  const baseResponse = {
    context_ref: "ctx",
    ai_status: "skipped",
    basis: {
      accepted_ref: null, proposal_ref: "p1", selected_role: "proposal",
      comparison: "single_schedule", evaluation_deadline_date: "2026-11-26",
      intent: "overview", highlighted_fact_ids: ["proposal:schedule", "proposal:deadline", "proposal:dependency:T1:T2"],
    },
    facts: [
      { id: "proposal:schedule", kind: "schedule", role: "proposal", task_ids: [],
        data: { final_work_date: "2026-11-29", completion_kind: "scheduled" } },
      { id: "proposal:deadline", kind: "deadline", role: "proposal", task_ids: [],
        data: { target_deadline_date: "2026-11-26", days_late: 3, status: "late" } },
      { id: "proposal:dependency:T1:T2", kind: "dependency", role: "proposal", task_ids: ["T1", "T2"],
        data: { tight: true } },
    ],
    possible_explanations: [], suggestions: [], unknowns: [],
  };
  const lateTldr = summarizeRecovery(baseResponse, (id) => id);
  assert.equal(lateTldr.length, 2);
  assert.equal(lateTldr[0], "Lịch dự kiến kết thúc ngày 29/11/2026, trễ 3 ngày so với hạn 26/11/2026.");
  assert.match(lateTldr[1], /T2 phụ thuộc vào T1/);

  const comparedTldr = summarizeRecovery({
    ...baseResponse,
    basis: { ...baseResponse.basis, accepted_ref: "a1", comparison: "compared" },
    facts: [
      { id: "proposal:schedule", kind: "schedule", role: "proposal", task_ids: [],
        data: { final_work_date: "2026-11-24", completion_kind: "actual" } },
      { id: "proposal:deadline", kind: "deadline", role: "proposal", task_ids: [],
        data: { target_deadline_date: null, days_late: null, status: null } },
      { id: "comparison:schedule_change", kind: "schedule_change", role: null, task_ids: [],
        data: { no_changes: false, finish_delta_days: -2, moved_count: 1 } },
    ],
  }, (id) => id);
  assert.equal(comparedTldr[0], "Dự án đã hoàn thành thực tế ngày 24/11/2026 (chưa đặt hạn mục tiêu).");
  assert.equal(comparedTldr[1], "So với lịch đối chiếu: ngày kết thúc 2 ngày sớm hơn, có 1 công việc đổi khoảng lịch.");
});

test("Recovery client validates the contract and preserves fallback facts", async (t) => {
  const { accepted, proposal } = recoveryContext(propose(initialPlans, original), 0);
  const question = "Công việc nào phụ thuộc nhau?";
  const payload = { context_ref: "current-request", question, accepted, proposal };
  const fact = { id: "proposal:dependency:T1:T2", kind: "dependency", role: "proposal", task_ids: ["T1", "T2"],
    data: { tight: true, scheduled_gap_days: 0 } };
  const answer = {
    context_ref: payload.context_ref, ai_status: "missing_key",
    basis: { accepted_ref: null, proposal_ref: proposal.snapshot_ref, selected_role: "proposal", comparison: "single_schedule",
      intent: "dependencies", evaluation_deadline_date: proposal.calendar.target_deadline_date, highlighted_fact_ids: [fact.id] },
    facts: [fact], possible_explanations: [], suggestions: [], unknowns: [],
  };
  const signal = new AbortController().signal;
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(answer));
  const request = () => explainRecovery("http://localhost:8000", payload, signal);
  assert.deepEqual(await request(), answer);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "http://localhost:8000/api/recovery/explain");
  assert.equal(options.method, "POST");
  assert.equal(options.signal, signal);
  assert.deepEqual(JSON.parse(options.body), payload);

  fetch.mock.mockImplementation(async () => Response.json({ ...answer, context_ref: "stale" }));
  await assert.rejects(request, /không khớp với lịch đang xem/);
  fetch.mock.mockImplementation(async () => Response.json({ ...answer, basis: { ...answer.basis, proposal_ref: "other" } }));
  await assert.rejects(request, /không khớp với lịch đang xem/);
  fetch.mock.mockImplementation(async () => Response.json({ ...answer, unknowns: null }));
  await assert.rejects(request, /dữ liệu không đọc được/);
  fetch.mock.mockImplementation(async () => Response.json({ detail: [] }, { status: 422 }));
  await assert.rejects(request, /dữ liệu lịch gửi lên không hợp lệ/);
  fetch.mock.mockImplementation(async () => { throw new TypeError("offline"); });
  await assert.rejects(request, /Không kết nối được với trợ lý giải thích lịch/);
});
