import assert from "node:assert/strict";
import { test } from "node:test";
import { draftReady, draftTaskForEditor, generateProjectDraft } from "../src/draft.ts";
import {
  cancelPlanningRequest, confirmDraftSuggestions, confirmPlanningDraft, editPlanningTask,
  hasDraftSuggestions, mergeConfirmedMembers, planningApi, planningApplyBlock, removePlanningTask,
  updateDraftMembers,
} from "../src/planning.ts";
import { initialPlans } from "../src/plans.ts";

const prompt = "Làm một trang web nhận đơn hàng cho cửa hàng nhỏ.";
const questions = [
  { id: "Q1", text: "Cần thanh toán trực tuyến không?" },
  { id: "Q2", text: "Có giao hàng không?" },
  { id: "Q3", text: "Có cần xác nhận qua email không?" },
];
const session = { prompt, goal: "Nhận đơn hàng", questions, answers: { Q2: " Có giao hàng nội thành. " } };
const ai = { kind: "ai" };
const fromAnswer = { kind: "answer", question_id: "Q2" };
const source = { name: ai, category: ai, duration: ai, dependencies: ai };
const estimatedTask = {
  id: "T1", name: "Thiết kế biểu mẫu", category: "Thiết kế", duration: 3, dependencies: [],
  duration_review: "suggested", dependency_review: "suggested",
};
const followUpTask = {
  id: "T2", name: "Hỗ trợ giao hàng", category: "Backend", duration: 4, dependencies: ["T1"],
  duration_review: "provided", dependency_review: "suggested",
};
const missingTask = {
  id: "T3", name: "Kiểm thử", category: "QA", duration: null, dependencies: null,
  duration_review: "missing", dependency_review: "missing",
};
const result = {
  goal: session.goal, draft: { project_name: "Trang nhận đơn", tasks: [estimatedTask, followUpTask, missingTask] },
  assumptions: ["Một cửa hàng sử dụng hệ thống."], uncertainties: ["Chưa rõ cổng thanh toán."],
  sources: {
    goal: { kind: "description" }, project_name: ai,
    tasks: { T1: source, T2: { ...source, duration: fromAnswer }, T3: { ...source, dependencies: { kind: "unknown" } } },
  },
};
const fullyReviewed = confirmDraftSuggestions({ ...result.draft, tasks: [estimatedTask, followUpTask] });
const confirmedProject = {
  project_name: "Trang nhận đơn",
  team_capacity: 1,
  kanban_config: { stages: ["Thiết kế", "Backend"], wip_limits: {} },
  members: [],
  tasks: fullyReviewed.tasks.map(({ id, name, category, duration, dependencies }) => ({
    id, name, category, duration, dependencies, kanban_stage: category, status: "To Do", assignee_id: null,
  })),
};

test("zero questions go straight to generation with the original description", async ({ mock }) => {
  const clarification = { goal: session.goal, questions: [] };
  const post = mock.fn(async (path) => path.endsWith("/clarify") ? clarification : result);
  const api = planningApi(post);
  const { signal } = new AbortController();
  const response = await api.clarify(prompt, signal);
  assert.equal(response.questions.length, 0);
  const planned = await api.draft({ ...response, prompt, answers: {} }, false, signal);
  assert.equal(planned, result);
  assert.deepEqual(post.mock.calls.map((call) => call.arguments), [
    ["/api/planning/clarify", { prompt }, signal],
    ["/api/planning/draft", { prompt, clarifications: [] }, signal],
  ]);
});

test("three questions allow partial answers and skipping all without erasing answers", async ({ mock }) => {
  const post = mock.fn(async (path) => path.endsWith("/clarify") ? { goal: session.goal, questions } : result);
  const api = planningApi(post);
  const { signal } = new AbortController();
  const clarification = await api.clarify(prompt, signal);
  assert.deepEqual(clarification.questions, questions);
  await api.draft({ ...session, ...clarification }, false, signal);
  await api.draft({ ...session, ...clarification }, true, signal);
  const [, partial, skipped] = post.mock.calls.map((call) => call.arguments[1]);
  assert.deepEqual(partial.clarifications, questions.map(({ id, text }) => ({
    id, question: text, answer: id === "Q2" ? "Có giao hàng nội thành." : null,
  })));
  assert.deepEqual(skipped.clarifications.map(({ answer }) => answer), [null, null, null]);
  assert.equal(session.answers.Q2, " Có giao hàng nội thành. ");
});

test("bulk review accepts suggested durations and both forms of proposed dependencies, excluding missing fields", () => {
  assert.equal(hasDraftSuggestions(result.draft), true);
  const reviewed = confirmDraftSuggestions(result.draft);
  assert.deepEqual(reviewed.tasks.map((task) => [task.duration, task.duration_review, task.dependencies, task.dependency_review]), [
    [3, "confirmed", [], "confirmed"],
    [4, "provided", ["T1"], "confirmed"],
    [null, "missing", null, "missing"],
  ]);
  assert.equal(hasDraftSuggestions(reviewed), false);
  assert.equal(draftReady(reviewed), false);
  assert.equal(estimatedTask.dependency_review, "suggested");

  const working = { ...result, draft: reviewed };
  const edited = { ...draftTaskForEditor(reviewed.tasks[2]), duration: 2 };
  const noDependencyDecision = editPlanningTask(working, reviewed.tasks[2], edited, { duration: false, dependencies: false });
  assert.equal(noDependencyDecision.draft.tasks[2].dependencies, null);
  assert.equal(draftReady(noDependencyDecision.draft), false);
  const explicit = editPlanningTask(working, reviewed.tasks[2], edited, { duration: false, dependencies: true });
  assert.deepEqual(explicit.draft.tasks[2].dependencies, []);
  assert.equal(explicit.sources.tasks.T3.dependencies.kind, "edited");
  assert.equal(draftReady(explicit.draft), true);
});

test("editing keeps provenance for unchanged suggestions, and task removal reopens dependencies", () => {
  const renamed = editPlanningTask(result, estimatedTask, { ...draftTaskForEditor(estimatedTask), id: "UI", name: "Thiết kế" },
    { duration: true, dependencies: false });
  assert.equal(renamed.sources.tasks.T1, undefined);
  assert.equal(renamed.sources.tasks.UI.name.kind, "edited");
  assert.equal(renamed.sources.tasks.UI.duration.kind, "ai");
  assert.deepEqual(renamed.draft.tasks[1].dependencies, ["UI"]);
  assert.equal(renamed.sources.tasks.T2.duration, fromAnswer);
  const removed = removePlanningTask(renamed, renamed.draft.tasks[0]);
  assert.equal(removed.draft.tasks[0].dependencies, null);
  assert.equal(removed.draft.tasks[0].dependency_review, "missing");
  assert.equal(removed.sources.tasks.T2.dependencies.kind, "unknown");
});

test("provider error and duplicate submission preserve the inputs and edited draft for retry", async ({ mock }) => {
  const request = { current: null };
  const deferred = Promise.withResolvers();
  const post = mock.fn(() => deferred.promise);
  const api = planningApi(post);
  const oldDraft = { ...result, draft: { ...result.draft, project_name: "Tên đã chỉnh" } };
  let saved = oldDraft;
  const updates = { pending: mock.fn(), ready: mock.fn((draft) => { saved = draft; }), failed: mock.fn() };
  const first = generateProjectDraft(request, (signal) => api.draft(session, false, signal), updates);
  await generateProjectDraft(request, (signal) => api.draft(session, false, signal), updates);
  assert.equal(post.mock.callCount(), 1);
  deferred.reject(new Error("Gemini phản hồi quá thời gian chờ. Hãy thử lại."));
  await first;
  assert.equal(saved, oldDraft);
  assert.equal(updates.failed.mock.callCount(), 1);
  assert.equal(session.prompt, prompt);
  assert.equal(session.answers.Q2, " Có giao hàng nội thành. ");

  post.mock.mockImplementation(async () => result);
  await generateProjectDraft(request, (signal) => api.draft(session, false, signal), updates);
  assert.equal(saved, result);
  assert.equal(request.current, null);
});

test("changing the description or cancelling generation ignores the stale response", async ({ mock }) => {
  const request = { current: null };
  const deferred = Promise.withResolvers();
  const old = { goal: "Mục tiêu cũ", questions: [] };
  const latest = { goal: "Mục tiêu mới", questions: [] };
  const post = mock.fn((_, body) => body.prompt === prompt ? deferred.promise : Promise.resolve(latest));
  const api = planningApi(post);
  const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
  const first = generateProjectDraft(request, (signal) => api.clarify(prompt, signal), updates);
  cancelPlanningRequest(request);
  assert.equal(post.mock.calls[0].arguments[2].aborted, true);
  await generateProjectDraft(request, (signal) => api.clarify("Mô tả mới", signal), updates);
  deferred.resolve(old);
  await first;
  assert.deepEqual(updates.ready.mock.calls.map((call) => call.arguments[0]), [latest]);
  assert.deepEqual(updates.pending.mock.calls.map((call) => call.arguments[0]), [true, true, false]);
});

test("confirmation sends only the reviewed draft and applies only the successful Validator response", async ({ mock }) => {
  const request = { current: null };
  const getTarget = () => ({ version: 1, blocked: "" });
  const post = mock.fn(async () => { throw new Error("Công việc bị phụ thuộc vòng tròn."); });
  const api = planningApi(post);
  const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
  await confirmPlanningDraft(request, result.draft, getTarget, api.confirm, updates);
  assert.equal(post.mock.callCount(), 0);
  await confirmPlanningDraft(request, fullyReviewed, getTarget, api.confirm, updates);
  assert.equal(updates.ready.mock.callCount(), 0);
  assert.equal(updates.failed.mock.callCount(), 1);
  post.mock.mockImplementation(async () => confirmedProject);
  await confirmPlanningDraft(request, fullyReviewed, getTarget, api.confirm, updates);
  assert.equal(post.mock.calls[1].arguments[0], "/api/parse/confirm");
  assert.equal(post.mock.calls[1].arguments[1], fullyReviewed);
  assert.deepEqual(updates.ready.mock.calls[0].arguments, [confirmedProject]);
});

test("cancelled confirmation retains the draft and never applies a late validated result", async ({ mock }) => {
  const request = { current: null };
  const response = Promise.withResolvers();
  const post = mock.fn(() => response.promise);
  const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
  const first = confirmPlanningDraft(request, fullyReviewed, () => ({ version: 1, blocked: "" }), planningApi(post).confirm, updates);
  cancelPlanningRequest(request);
  response.resolve(confirmedProject);
  await first;
  assert.equal(updates.ready.mock.callCount(), 0);
  assert.equal(updates.failed.mock.callCount(), 0);
  assert.equal(draftReady(fullyReviewed), true);
});

test("existing tasks, each retained schedule, progress and active scheduling block application", async ({ mock }) => {
  const post = mock.fn();
  const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
  const request = { current: null };
  const cases = [
    [1, initialPlans, false, false],
    ...["baseline", "previous", "accepted", "proposal", "confirmedProgress", "todoConfirmed"].map((key) =>
      [0, { ...initialPlans, [key]: true }, false, false]),
    [0, initialPlans, true, false],
    [0, initialPlans, false, true],
  ];
  for (const entry of cases) {
    const blocked = planningApplyBlock(...entry);
    assert.ok(blocked);
    await confirmPlanningDraft(request, fullyReviewed, () => ({ version: 1, blocked }), planningApi(post).confirm, updates);
  }
  assert.equal(post.mock.callCount(), 0);
  assert.equal(updates.failed.mock.callCount(), cases.length);
  assert.equal(planningApplyBlock(0, initialPlans, false, false), "");
});

test("a project edit or new progress arriving during validation prevents application", async ({ mock }) => {
  for (const changed of [
    { version: 2, blocked: "" },
    { version: 1, blocked: planningApplyBlock(0, initialPlans, true, false) },
  ]) {
    const request = { current: null };
    let target = { version: 1, blocked: "" };
    const response = Promise.withResolvers();
    const post = mock.fn(() => response.promise);
    const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
    const first = confirmPlanningDraft(request, fullyReviewed, () => target, planningApi(post).confirm, updates);
    await confirmPlanningDraft(request, fullyReviewed, () => target, planningApi(post).confirm, updates);
    assert.equal(post.mock.callCount(), 1);
    target = changed;
    response.resolve(confirmedProject);
    await first;
    assert.equal(updates.ready.mock.callCount(), 0);
    assert.equal(updates.failed.mock.callCount(), 1);
  }
});

test("suggested draft members and assignments require confirmation and merge cleanly", () => {
  const memberDraft = {
    goal: "Lập lịch nhóm",
    assumptions: [],
    uncertainties: [],
    draft: {
      project_name: "Web nhóm",
      members: [{ id: "M1", name: "An" }, { id: "M2", name: "Bình" }],
      tasks: [{
        id: "T1", name: "Thiết kế", category: "Design", duration: 2, dependencies: [],
        duration_review: "provided", dependency_review: "provided",
        suggested_assignee_id: "M1", assignee_review: "suggested",
      }],
    },
    sources: {
      goal: { kind: "description" },
      project_name: ai,
      tasks: { T1: { ...source, duration: { kind: "description" }, dependencies: { kind: "description" }, assignee: ai } },
    },
  };
  assert.equal(hasDraftSuggestions(memberDraft.draft), true);
  assert.equal(draftReady(memberDraft.draft), false);

  const reviewed = confirmDraftSuggestions(memberDraft.draft);
  assert.equal(reviewed.tasks[0].assignee_review, "confirmed");
  assert.equal(draftReady(reviewed), true);

  const memberRemoved = updateDraftMembers(memberDraft, [{ id: "M2", name: "Bình" }]);
  assert.equal(memberRemoved.draft.tasks[0].suggested_assignee_id, null);
  assert.equal(memberRemoved.draft.tasks[0].assignee_review, null);
  assert.equal(draftReady(memberRemoved.draft), true);

  const merged = mergeConfirmedMembers(
    [{ id: "member-1", name: "An" }],
    {
      ...confirmedProject,
      members: [{ id: "M1", name: "An" }, { id: "M2", name: "Chi" }],
      tasks: [
        { ...confirmedProject.tasks[0], assignee_id: "M1" },
        { ...confirmedProject.tasks[1], assignee_id: "M2" },
      ],
    },
  );
  assert.deepEqual(merged.members, [{ id: "member-1", name: "An" }, { id: "M2", name: "Chi" }]);
  assert.equal(merged.tasks[0].assignee_id, "member-1");
  assert.equal(merged.tasks[1].assignee_id, "M2");
});
