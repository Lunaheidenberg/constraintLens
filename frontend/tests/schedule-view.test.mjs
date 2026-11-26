import assert from "node:assert/strict";
import { test } from "node:test";
import { durationDeadlineWarnings, groupTasksByMember, memberColorIndex, splitDeadlineInterval } from "../src/scheduleView.ts";

test("durationDeadlineWarnings flags single tasks longer than the deadline window without blocking total sum", () => {
  const calendar = { project_start_date: "2026-11-20", target_deadline_date: "2026-11-24" }; // 5 days inclusive
  const tasks = [
    { id: "T1", name: "Short A", duration: 4 },
    { id: "T2", name: "Short B", duration: 5 }, // sum = 9 > 5, should NOT warn individually
    { id: "T3", name: "Too Long", duration: 6 },
  ];
  const warnings = durationDeadlineWarnings(tasks, calendar);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("T3"));
  assert.ok(warnings[0].includes("6 ngày"));
  assert.ok(warnings[0].includes("5 ngày"));
});

test("durationDeadlineWarnings returns empty when deadline is missing or invalid", () => {
  const tasks = [{ id: "T1", name: "A", duration: 10 }];
  assert.deepEqual(durationDeadlineWarnings(tasks, { project_start_date: "2026-11-20", target_deadline_date: null }), []);
  assert.deepEqual(durationDeadlineWarnings(tasks, { project_start_date: "", target_deadline_date: "2026-11-25" }), []);
  assert.deepEqual(durationDeadlineWarnings(tasks, { project_start_date: "2026-11-25", target_deadline_date: "2026-11-20" }), []);
});

test("splitDeadlineInterval splits bars cleanly at the exclusive deadline boundary", () => {
  assert.deepEqual(splitDeadlineInterval(0, 4, null), {
    onTime: { start: 0, width: 4 },
    overdue: null,
    overdueDays: 0,
  });
  assert.deepEqual(splitDeadlineInterval(0, 4, 4), {
    onTime: { start: 0, width: 4 },
    overdue: null,
    overdueDays: 0,
  });
  assert.deepEqual(splitDeadlineInterval(2, 7, 4), {
    onTime: { start: 2, width: 2 },
    overdue: { start: 4, width: 3 },
    overdueDays: 3,
  });
  assert.deepEqual(splitDeadlineInterval(5, 8, 4), {
    onTime: null,
    overdue: { start: 5, width: 3 },
    overdueDays: 3,
  });
});

test("memberColorIndex and groupTasksByMember organize swimlanes and summarize workload", () => {
  const members = [{ id: "M1", name: "An" }, { id: "M2", name: "Bình" }, { id: "M3", name: "Chi" }];
  assert.equal(memberColorIndex("M1", members), 0);
  assert.equal(memberColorIndex("M2", members), 1);
  assert.equal(memberColorIndex("M3", members), 2);

  const scheduled = [
    { id: "T2", name: "Task 2", kanban_stage: "Coding", duration: 3, dependencies: ["T1"], start_day: 4, end_day: 7, assignee_id: "M1", earliest_ready_day: 2, queue_wait_days: 2 },
    { id: "T1", name: "Task 1", kanban_stage: "Design", duration: 2, dependencies: [], start_day: 0, end_day: 2, assignee_id: "M1", earliest_ready_day: 0, queue_wait_days: 0 },
    { id: "T3", name: "Task 3", kanban_stage: "Coding", duration: 2, dependencies: [], start_day: 0, end_day: 2, assignee_id: "M2", earliest_ready_day: 0, queue_wait_days: 0 },
  ];
  const lanes = groupTasksByMember(scheduled, [], members, 5);
  assert.equal(lanes.length, 2); // M3 has 0 tasks so omitted
  assert.equal(lanes[0].memberId, "M1");
  assert.deepEqual(lanes[0].scheduled.map((t) => t.id), ["T1", "T2"]);
  assert.equal(lanes[0].totalDays, 5);
  assert.equal(lanes[0].totalWaitDays, 2);
  assert.equal(lanes[0].overdueTaskCount, 1);
  assert.equal(lanes[1].memberId, "M2");
  assert.equal(lanes[1].overdueTaskCount, 0);
});
