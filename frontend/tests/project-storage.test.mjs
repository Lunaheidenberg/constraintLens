import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDateInput } from "../src/calendar.ts";
import { readyDemoPresets } from "../src/demoPresets.ts";
import { initialPlans, planReducer } from "../src/plans.ts";
import {
  exportFileName, loadQuickStartCollapsed, loadStoredWorkspace, parseWorkspaceJson,
  saveQuickStartCollapsed, saveStoredWorkspace, serializeWorkspace, clearStoredWorkspace,
} from "../src/projectStorage.ts";

test("exportFileName normalizes Vietnamese project titles to safe filenames", () => {
  assert.equal(exportFileName("Đồ án Web E-Commerce"), "do-an-web-e-commerce.constraintlens.json");
  assert.equal(exportFileName("   "), "du-an.constraintlens.json");
});

test("readyDemoPresets returns complete, assigned, acyclic projects with valid dates", () => {
  const demos = readyDemoPresets("2026-11-26");
  assert.equal(demos.length, 2);
  for (const demo of demos) {
    const startIso = parseDateInput(demo.dateInputs.start);
    const deadlineIso = parseDateInput(demo.dateInputs.deadline);
    assert.ok(startIso, `${demo.id} missing valid start`);
    assert.ok(deadlineIso && deadlineIso >= startIso, `${demo.id} deadline before start`);
    const memberIds = new Set((demo.ir.members ?? []).map((member) => member.id));
    assert.ok(memberIds.size >= 3, `${demo.id} needs members`);
    const taskIds = new Set(demo.ir.tasks.map((task) => task.id));
    for (const task of demo.ir.tasks) {
      assert.ok(task.assignee_id && memberIds.has(task.assignee_id), `${demo.id}:${task.id} missing valid assignee`);
      assert.ok(Number.isSafeInteger(task.duration) && task.duration >= 1);
      for (const dep of task.dependencies) {
        assert.ok(taskIds.has(dep) && dep !== task.id, `${demo.id}:${task.id} invalid dependency ${dep}`);
      }
    }
  }
});

test("serializeWorkspace and parseWorkspaceJson round-trip safely and strip transient proposals", () => {
  const [demo] = readyDemoPresets("2026-11-26");
  const acceptedPlan = {
    calendar: {
      project_start_date: "2026-11-26",
      target_deadline_date: "2026-12-07",
      project_finish_day_exclusive: 12,
      project_finish_date_exclusive: "2026-12-08",
      final_work_date: "2026-12-07",
      deadline_status: "on_time",
      days_late: 0,
    },
    status: "OPTIMAL",
    scheduledTasks: [],
    solveTimeMs: 4.2,
    scheduleRevision: 1,
    tasks: demo.ir.tasks,
    members: demo.ir.members ?? [],
    recovery: null,
  };
  let plans = planReducer(initialPlans, { type: "propose", revision: 0, plan: acceptedPlan });
  plans = planReducer(plans, { type: "accept" });
  plans = planReducer(plans, { type: "inputsChanged" });
  plans = planReducer(plans, { type: "propose", revision: plans.revision, plan: acceptedPlan });
  assert.ok(plans.proposal);

  const raw = serializeWorkspace({
    version: 1,
    ir: demo.ir,
    usedTaskIds: ["T1", "T2", "T99"],
    dateInputs: demo.dateInputs,
    asOfInput: "28/11/2026",
    entries: [["T1", "28/11/2026"]],
    plans,
  });

  const parsed = parseWorkspaceJson(raw);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.ir.project_name, demo.ir.project_name);
    assert.deepEqual(parsed.data.dateInputs, demo.dateInputs);
    assert.equal(parsed.data.asOfInput, "28/11/2026");
    assert.deepEqual(parsed.data.entries, [["T1", "28/11/2026"]]);
    assert.ok(parsed.data.usedTaskIds.includes("T99"));
    assert.equal(parsed.data.plans.accepted?.status, "OPTIMAL");
    assert.equal(parsed.data.plans.proposal, null);
    assert.equal(parsed.data.plans.stale, false);
  }
});

test("parseWorkspaceJson rejects malformed or invalid project payloads", () => {
  assert.equal(parseWorkspaceJson("{bad json").ok, false);
  assert.equal(parseWorkspaceJson(JSON.stringify({ version: 2 })).ok, false);
  assert.equal(parseWorkspaceJson(JSON.stringify({
    version: 1,
    ir: { project_name: "", team_capacity: 1, kanban_config: { stages: [], wip_limits: {} }, tasks: [] },
    dateInputs: { start: "", deadline: "" },
  })).ok, false);
  assert.equal(parseWorkspaceJson(JSON.stringify({
    version: 1,
    ir: {
      project_name: "Bad task",
      team_capacity: 1,
      kanban_config: { stages: ["Coding"], wip_limits: {} },
      tasks: [{ id: "T1", name: "Broken", duration: 0, dependencies: [], kanban_stage: "Coding" }],
    },
    dateInputs: { start: "", deadline: "" },
  })).ok, false);
});

test("storage helpers fail silently when localStorage is unavailable or throws", () => {
  const original = globalThis.localStorage;
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    assert.equal(loadStoredWorkspace(), null);
    assert.equal(loadQuickStartCollapsed(), false);
    assert.doesNotThrow(() => saveQuickStartCollapsed(true));
    assert.doesNotThrow(() => clearStoredWorkspace());
    const [demo] = readyDemoPresets("2026-11-26");
    assert.doesNotThrow(() => saveStoredWorkspace({
      version: 1,
      ir: demo.ir,
      usedTaskIds: [],
      dateInputs: demo.dateInputs,
      asOfInput: "",
      entries: [],
      plans: initialPlans,
    }));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});
