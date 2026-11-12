import assert from "node:assert/strict";
import { test } from "node:test";
import { draftReady, draftTaskForEditor, removeDraftTask, saveDraftTask } from "../src/draft.ts";

const design = Object.freeze({
  id: "T1", name: "Thiết kế giao diện", category: "Thiết kế", duration: 3, dependencies: [],
  duration_review: "provided", dependency_review: "provided",
});
const build = Object.freeze({
  id: "T2", name: "Lập trình đăng nhập", category: "Backend", duration: null, dependencies: ["T1"],
  duration_review: "missing", dependency_review: "suggested",
});
const draft = Object.freeze({ project_name: "Đăng nhập", tasks: Object.freeze([design, build]) });
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
