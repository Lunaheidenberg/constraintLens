import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BYOK_MODEL_PRESETS,
  byokClarify,
  byokGenerateDraft,
  DEFAULT_BYOK_MODEL,
  normalizeModelId,
  verifyByokKey,
} from "../src/byokGemini.ts";

const USER_KEY = "AIza-user-byok-secret-test";

test("normalizeModelId strips models/ prefix and validates safe gemini IDs", () => {
  assert.equal(normalizeModelId("models/gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(normalizeModelId("  GEMINI-3.5-FLASH  "), "gemini-3.5-flash");
  assert.equal(normalizeModelId("invalid model!"), DEFAULT_BYOK_MODEL);
  assert.ok(BYOK_MODEL_PRESETS.length >= 4);
  assert.equal(
    BYOK_MODEL_PRESETS.some((preset) => preset.id.startsWith("gemini-1.") || preset.id.startsWith("gemini-2.")),
    false,
  );
});

test("verifyByokKey, byokClarify, and byokGenerateDraft call Google directly with x-goog-api-key", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models/gemini-3.8-flash")) {
      return Response.json({ name: "models/gemini-3.8-flash" });
    }
    if (url.includes("/models?pageSize=50")) {
      return Response.json({
        models: [
          { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    }
    if (url.endsWith("/models/gemini-3.8-flash:generateContent")) {
      const body = JSON.parse(options.body);
      if (body.generationConfig.responseSchema.required.includes("questions")) {
        return Response.json({
          candidates: [{
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify({ goal: "Bán sách", questions: ["Ai tham gia dự án?", "ai tham gia dự án?"] }) }] },
          }],
        });
      }
      return Response.json({
        candidates: [{
          finishReason: "STOP",
          content: {
            parts: [{
              text: JSON.stringify({
                goal: "Bán sách",
                project_name: "Bookstore BYOK",
                members: [{ id: "M1", name: "An" }],
                tasks: [
                  {
                    id: "T1", name: "Thiết kế UI", category: "Design",
                    duration: 2, dependencies: [], suggested_assignee_id: "M1",
                  },
                  {
                    id: "T2", name: "Code API", category: "Backend",
                    duration: null, dependencies: null, suggested_assignee_id: "UNKNOWN",
                  },
                ],
                assumptions: ["Nháp thử nghiệm"],
                uncertainties: [],
              }),
            }],
          },
        }],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  });

  const verified = await verifyByokKey(USER_KEY, "models/gemini-3.8-flash");
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.availableModels, ["gemini-3.6-flash", "gemini-3.8-flash"]);

  const signal = new AbortController().signal;
  const clarified = await byokClarify("Làm web bán sách", USER_KEY, "gemini-3.8-flash", signal);
  assert.equal(clarified.goal, "Bán sách");
  assert.deepEqual(clarified.questions, [{ id: "Q1", text: "Ai tham gia dự án?" }]);

  const planned = await byokGenerateDraft(
    { ...clarified, prompt: "Làm web bán sách", answers: { Q1: "An phụ trách thiết kế" } },
    false,
    USER_KEY,
    "gemini-3.8-flash",
    signal,
  );
  assert.equal(planned.draft.project_name, "Bookstore BYOK");
  assert.deepEqual(planned.draft.members, [{ id: "M1", name: "An" }]);
  // Mọi gợi ý từ chế độ BYOK đều phải ở trạng thái chờ duyệt/thiếu, không tự xác nhận ngầm.
  assert.equal(planned.draft.tasks[0].duration_review, "suggested");
  assert.equal(planned.draft.tasks[0].dependency_review, "suggested");
  assert.equal(planned.draft.tasks[0].assignee_review, "suggested");
  assert.equal(planned.draft.tasks[1].duration_review, "missing");
  assert.equal(planned.draft.tasks[1].dependency_review, "missing");
  assert.equal(planned.draft.tasks[1].suggested_assignee_id, null);

  for (const call of calls) {
    assert.ok(call.url.startsWith("https://generativelanguage.googleapis.com/v1beta/"), call.url);
    assert.equal(call.options.headers["x-goog-api-key"], USER_KEY);
  }
});

test("byokGenerateDraft rejects cyclic dependencies and sanitizes HTTP errors without leaking key", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    candidates: [{
      finishReason: "STOP",
      content: {
        parts: [{
          text: JSON.stringify({
            goal: "Test",
            project_name: "Cycle",
            members: [],
            tasks: [
              { id: "T1", name: "A", category: "Dev", duration: 1, dependencies: ["T2"], suggested_assignee_id: null },
              { id: "T2", name: "B", category: "Dev", duration: 1, dependencies: ["T1"], suggested_assignee_id: null },
            ],
            assumptions: [],
            uncertainties: [],
          }),
        }],
      },
    }],
  }));

  await assert.rejects(
    () => byokGenerateDraft({ goal: "Test", prompt: "Cycle", questions: [], answers: {} }, true, USER_KEY, DEFAULT_BYOK_MODEL, new AbortController().signal),
    /vòng tròn/,
  );

  for (const [status, pattern] of [
    [401, /không hợp lệ/],
    [429, /hạn mức/],
    [404, /model/],
    [503, /quá tải/],
  ]) {
    fetch.mock.mockImplementation(async () => new Response(`bad error ${USER_KEY}`, { status }));
    await assert.rejects(
      async () => byokClarify("Test", USER_KEY, DEFAULT_BYOK_MODEL, new AbortController().signal),
      (err) => {
        assert.match(err.message, pattern);
        assert.ok(!err.message.includes(USER_KEY));
        return true;
      },
    );
  }
});
