import assert from "node:assert/strict";
import { test } from "node:test";
import { draftReady, draftTaskForEditor, generateProjectDraft, removeDraftTask, saveDraftTask } from "../src/draft.ts";

const design = Object.freeze({
  id: "T1", name: "Thiết kế giao diện", category: "Thiết kế", duration: 3, dependencies: [],
  duration_review: "provided", dependency_review: "provided",
});
const build = Object.freeze({
  id: "T2", name: "Lập trình đăng nhập", category: "Backend", duration: null, dependencies: ["T1"],
  duration_review: "missing", dependency_review: "suggested",
});
const draft = Object.freeze({ project_name: "Đăng nhập", tasks: Object.freeze([design, build]) });

test("G6/G9: concurrent generation is ignored, failure preserves data, and retry works", async ({ mock }) => {
  const request = { current: null };
  const previousDraft = { ...draft, project_name: "Bản nháp đã chỉnh sửa" };
  const project = Object.freeze({ project_name: "Dự án đang thực hiện" });
  const schedule = Object.freeze({ makespan: 7 });
  const form = { description: "Thiết kế và lập trình đăng nhập", draft: previousDraft, project, schedule };
  const updates = {
    pending: mock.fn(),
    ready: mock.fn((nextDraft) => { form.draft = nextDraft; }),
    failed: mock.fn(),
  };
  const failedRequest = Promise.withResolvers();
  const generate = mock.fn(() => failedRequest.promise);
  const first = generateProjectDraft(request, generate, updates);
  await generateProjectDraft(request, generate, updates);
  assert.equal(generate.mock.callCount(), 1);
  assert.deepEqual(updates.pending.mock.calls.map(({ arguments: args }) => args[0]), [true]);

  const error = new Error("Gemini phản hồi quá thời gian chờ. Hãy thử lại.");
  failedRequest.reject(error);
  await first;
  assert.deepEqual(updates.failed.mock.calls[0].arguments, [error]);
  assert.equal(updates.ready.mock.callCount(), 0);
  assert.equal(form.draft, previousDraft);
  assert.equal(form.project, project);
  assert.equal(form.schedule, schedule);
  assert.equal(form.description, "Thiết kế và lập trình đăng nhập");
  assert.equal(request.current, null);

  generate.mock.mockImplementation(async () => draft);
  await generateProjectDraft(request, generate, updates);
  assert.equal(form.draft, draft);
  assert.equal(generate.mock.callCount(), 2);
  assert.deepEqual(updates.pending.mock.calls.map(({ arguments: args }) => args[0]), [true, false, true, false]);
});

test("a response arriving after leaving generation is ignored", async ({ mock }) => {
  const request = { current: null };
  const updates = { pending: mock.fn(), ready: mock.fn(), failed: mock.fn() };
  const canceled = Promise.withResolvers();
  const first = generateProjectDraft(request, () => canceled.promise, updates);
  request.current.abort();
  request.current = null;
  await generateProjectDraft(request, async () => draft, updates);
  canceled.resolve(draft);
  await first;
  assert.equal(updates.ready.mock.callCount(), 1);
  assert.equal(updates.failed.mock.callCount(), 0);
  assert.deepEqual(updates.pending.mock.calls.map(({ arguments: args }) => args[0]), [true, true, false]);
});
const noReview = { duration: false, dependencies: false };

test("G9: correcting a duration preserves confirmed facts and a pending prerequisite review", () => {
  const corrected = saveDraftTask(draft, build, { ...draftTaskForEditor(build), duration: 4 }, noReview);
  assert.equal(corrected.tasks[0], design);
  assert.equal(corrected.tasks[1].duration_review, "confirmed");
  assert.deepEqual(corrected.tasks[1].dependencies, ["T1"]);
  assert.equal(corrected.tasks[1].dependency_review, "suggested");
  assert.equal(draftReady(corrected), false);
  assert.equal(build.duration, null);

  const reviewed = saveDraftTask(corrected, corrected.tasks[1], draftTaskForEditor(corrected.tasks[1]),
    { ...noReview, dependencies: true });
  assert.equal(draftReady(reviewed), true);
  assert.equal(reviewed.tasks[1].duration, 4);
});

test("G10: missing prerequisites and explicitly confirmed independence remain distinct", () => {
  const unknown = { ...design, dependencies: null, dependency_review: "missing" };
  const single = { ...draft, tasks: [unknown] };
  const editorTask = draftTaskForEditor(unknown);
  const renamed = saveDraftTask(single, unknown, { ...editorTask, name: "Thiết kế" }, noReview);
  assert.equal(renamed.tasks[0].dependencies, null);
  assert.equal(draftReady(renamed), false);

  const independent = saveDraftTask(single, unknown, editorTask, { ...noReview, dependencies: true });
  assert.deepEqual(independent.tasks[0].dependencies, []);
  assert.equal(draftReady(independent), true);
});

test("G10: an unchanged suggested duration requires review and an empty duration blocks confirmation", () => {
  const suggestion = { ...design, duration_review: "suggested" };
  const single = { ...draft, tasks: [suggestion] };
  const editorTask = draftTaskForEditor(suggestion);
  assert.equal(draftReady(saveDraftTask(single, suggestion, editorTask, noReview)), false);
  assert.equal(draftReady(saveDraftTask(single, suggestion, editorTask, { ...noReview, duration: true })), true);
  assert.equal(draftReady(saveDraftTask(single, suggestion, { ...editorTask, duration: null },
    { ...noReview, duration: true })), false);
});

test("Renaming a draft task updates references and removing it reopens affected reviews", () => {
  const renamed = saveDraftTask(draft, design, { ...draftTaskForEditor(design), id: "UI" }, noReview);
  assert.deepEqual(renamed.tasks[1].dependencies, ["UI"]);
  assert.equal(renamed.tasks[1].dependency_review, "suggested");
  const remaining = removeDraftTask(renamed, renamed.tasks[0]);
  assert.deepEqual(remaining.tasks[0].dependencies, []);
  assert.equal(remaining.tasks[0].dependency_review, "suggested");
  assert.equal(draftReady(remaining), false);
});
