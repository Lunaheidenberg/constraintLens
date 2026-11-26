import assert from "node:assert/strict";
import { test } from "node:test";
import { browser, command, evaluate, press, withProductionBrowser } from "./browser-harness.mjs";

function prepareBrowserScenario() {
  const calls = [];
  const questionTexts = ["Có giao hàng không?", "Có thanh toán trực tuyến không?", "Ai xử lý đơn?"];
  const source = { kind: "ai" };
  const sources = { name: source, category: source, duration: source, dependencies: source };
  const task = (id, name, duration, dependencies) => ({
    id, name, category: "Thiết kế", duration, dependencies,
    duration_review: duration === null ? "missing" : "suggested",
    dependency_review: dependencies === null ? "missing" : "suggested",
  });
  const draft = {
    project_name: "Trang nhận đơn",
    tasks: [task("T1", "Thiết kế biểu mẫu", 3, []), task("T2", "Kiểm tra biểu mẫu", null, null)],
  };
  let finishCancelledConfirmation;
  let finishGuideConfirmation;
  let finishDraftFailure;
  let finishHelpFallback;
  let confirms = 0;
  const helpQuestions = {
    setup: "Dùng AI giúp lập kế hoạch như thế nào?",
    planning: "OPTIMAL nghĩa là gì?",
    recovery: "Làm sao cập nhật tiến độ công việc?",
  };
  const helpAnswer = "Câu trả lời hướng dẫn đã xác minh.";
  const kanbanAnswer = "Mở tab Tiến độ để xem Bảng Kanban. Kéo thẻ hoặc dùng Di chuyển để cập nhật trạng thái.";
  const combinedAnswer = "Đổi trạng thái trên Kanban giữ nguyên lịch đang áp dụng.\nChọn Đề xuất lịch mới trong Báo cáo tiến độ.";
  const helpFallback = "Chưa thể trả lời chắc chắn câu hỏi này lúc này. Bạn có thể thử diễn đạt lại hoặc xem các hướng dẫn liên quan bên dưới.";
  const fallbackQuestion = "Nếu kéo thẻ trên Kanban thì lịch có đổi liền không?";
  const helpTopics = (workspace) => [
    { topic: workspace, question: helpQuestions[workspace] },
    ...(workspace === "setup" ? [
      { topic: "create-schedule", question: "Làm sao tạo lịch dự án?" },
      { topic: "tasks-and-assignments", question: "Làm sao quản lý và phân công công việc?" },
      { topic: "kanban", question: "Bảng Kanban dùng như thế nào?" },
    ] : []),
    ...(workspace === "recovery" ? [
      { topic: "remaining-duration", question: "Nhập thời lượng còn lại như thế nào?" },
      { topic: "reschedule", question: "Lập lại lịch theo tiến độ hoạt động thế nào?" },
      { topic: "task-moves", question: "Vì sao một công việc đổi lịch khi việc khác thay đổi?" },
    ] : []),
  ];
  const scheduleResult = (tasks, startDay = 0) => {
    let day = startDay;
    return tasks.map((task) => {
      const start = day;
      day += task.duration;
      return { ...task, start_day: start, end_day: day, earliest_ready_day: start, queue_wait_days: 0 };
    });
  };
  const finish = (calendar) => ({
    ...calendar, project_finish_day_exclusive: 6, project_finish_date_exclusive: "2026-11-26",
    final_work_date: "2026-11-25", deadline_status: "on_time", days_late: 0,
  });
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  window.fetch = async (url, options) => {
    const { pathname: path, searchParams } = new URL(url);
    const payload = options?.body && JSON.parse(options.body);
    calls.push({ path, payload });
    if (path === "/api/presets") return json({});
    if (path === "/api/ai/status") return json({ configured: true, model: "gemini-3.6-flash" });
    if (path === "/api/help/topics") return json(helpTopics(searchParams.get("workspace")));
    if (path === "/api/help/ask") {
      if (payload.question === "Lỗi kết nối") return json({}, 503);
      if (payload.question === "Bảng Kanban xài như thế nào?") return json({ topic: "kanban", answer: kanbanAnswer, suggestions: [] });
      if (payload.question === "Khi đổi cột thì xem lịch mới ở đâu?") return json({ topic: "update-progress", answer: combinedAnswer, suggestions: [] });
      if (payload.question === fallbackQuestion) {
        const suggestions = [...helpTopics(payload.workspace)];
        suggestions.unshift(suggestions.pop());
        return new Promise((resolve) => {
          finishHelpFallback = () => resolve(json({ topic: null, answer: helpFallback, suggestions }));
        });
      }
      if (payload.question === "Không có trong hướng dẫn") {
        return json({ topic: null, answer: "Chưa có câu trả lời.", suggestions: helpTopics(payload.workspace) });
      }
      return json({ topic: payload.workspace, answer: helpAnswer, suggestions: [] });
    }
    if (path === "/api/planning/clarify") {
      if (payload.prompt.startsWith("Lỗi")) return json({ detail: "Gemini tạm thời không khả dụng." }, 503);
      return json({
        goal: "Nhận đơn hàng",
        questions: payload.prompt.startsWith("Thử lại")
          ? questionTexts.map((text, index) => ({ id: "Q" + (index + 1), text })) : [],
      });
    }
    if (path === "/api/planning/draft") {
      if (payload.prompt.includes("giữ")) {
        return new Promise((resolve) => {
          finishDraftFailure = () => resolve(json({ detail: "Gemini phản hồi quá thời gian chờ." }, 504));
        });
      }
      return json({
        goal: "Nhận đơn hàng", draft, assumptions: ["Dùng một biểu mẫu."], uncertainties: ["Chưa rõ cách thanh toán."],
        sources: { goal: { kind: "description" }, project_name: source, tasks: { T1: sources, T2: sources } },
      });
    }
    if (path === "/api/parse/confirm") {
      const confirmed = json({
        project_name: payload.project_name, team_capacity: 1, members: [],
        kanban_config: { stages: ["Thiết kế"], wip_limits: {} },
        tasks: payload.tasks.map(({ id, name, duration, dependencies, category }) => ({
          id, name, duration, dependencies, category, kanban_stage: category, status: "To Do", assignee_id: null,
        })),
      });
      if (++confirms === 1) return new Promise((resolve) => { finishCancelledConfirmation = () => resolve(confirmed); });
      return new Promise((resolve) => { finishGuideConfirmation = () => resolve(confirmed); });
    }
    if (path === "/api/validate") return json({ valid: true, errors: [] });
    if (path === "/api/solve") {
      return json({
        calendar: finish(payload.calendar),
        result: { status: "OPTIMAL", scheduling_mode: "member", scheduled_tasks: scheduleResult(payload.ir.tasks), solve_time_ms: 1 },
      });
    }
    if (path === "/api/reschedule") {
      return json({
        ...finish(payload.calendar), status: "OPTIMAL", solve_time_ms: 1, errors: [],
        progress_as_of_date: "2026-11-22", replanning_start_day: 3, replanning_start_date: "2026-11-23",
        remaining_horizon_days: 3, scheduled_tasks: scheduleResult(payload.ir.tasks.slice(1), 3),
        completed_tasks: [{
          id: "T1", name: payload.ir.tasks[0].name, assignee_id: payload.ir.tasks[0].assignee_id,
          actual_finish_date: "2026-11-22", actual_end_day_exclusive: 3, actual_end_date_exclusive: "2026-11-23",
        }],
      });
    }
    throw new Error("Unexpected API call " + path);
  };

  const visible = (element) => element && !element.closest("[hidden], dialog:not([open])");
  const button = (name) => [...document.querySelectorAll("button")].find((element) =>
    visible(element) && element.textContent.trim() === name);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  async function waitFor(find, message) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const value = find();
      if (value) return value;
      await pause();
    }
    throw new Error(message);
  }
  const workspaces = { "Thiết lập": "setup", "Kế hoạch": "planning", "Tiến độ": "recovery" };
  const click = async (name) => (await waitFor(() => {
    const control = button(name) ?? find(`.workspace-link[aria-controls="workspace-${workspaces[name]}"]`);
    return control && !control.disabled && control;
  }, "Missing enabled button " + name)).click();
  const find = (selector) => document.querySelector(selector);
  const change = (element, value) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  const describe = async (text) => {
    change(await waitFor(() => find("#planning-description"), "Missing project description"), text);
    await pause();
    await click("AI giúp lập kế hoạch");
  };

  const completeMissingTask = async () => {
    find('button[aria-label="Sửa bản nháp T2"]').click();
    const duration = await waitFor(() => find("dialog[open] input[name=duration]"), "Missing draft task editor");
    change(duration, "2");
    find("dialog[open] input[type=checkbox]").click();
    await click("Lưu công việc");
  };
  const answerInputs = () => [...document.querySelectorAll("fieldset[aria-describedby=clarification-help] textarea")];

  async function openHelp(workspace, selector = ".project-bar .guide-trigger") {
    const opener = find(selector);
    const unrelatedCalls = calls.filter(({ path }) => !path.startsWith("/api/help/")).length;
    opener.click();
    const panel = await waitFor(() => find("#application-guide[open]"), "Help did not open");
    const input = find("#application-guide-question");
    check(document.activeElement === input, "Opening help did not focus the question field");
    await waitFor(() => panel.querySelector(".guide-question")?.textContent === helpQuestions[workspace], "Wrong suggestions for " + workspace);
    return { panel, input, close: async () => {
      panel.querySelector('button[aria-label="Đóng trợ giúp"]').click();
      await waitFor(() => !find("#application-guide") && document.activeElement === opener, "Help did not restore focus");
      check(calls.filter(({ path }) => !path.startsWith("/api/help/")).length === unrelatedCalls, "Help called a project endpoint");
    } };
  }

  async function askHelp(guide, question, expected) {
    change(guide.input, question);
    await click("Hỏi");
    await waitFor(() => guide.panel.textContent.includes(expected), "Help did not display " + expected);
  }

  return async () => {
    const member = await waitFor(() => find('input[aria-label="Tên thành viên mới"]'), "Missing member form");
    change(member, "Minh");
    change(find(".setup-calendar-fields input"), "20/11/2026");
    await click("Thêm");
    await describe("Tạo trang nhận đơn cho cửa hàng.");
    await waitFor(() => button("Tạo bản nháp"), "Zero questions did not lead to generation");
    check(!find("#clarification-help"), "Zero questions showed an answer form");
    await click("Tạo bản nháp");
    await waitFor(() => find("#draft-heading"), "Draft did not appear");
    check(!find("#planning-description") && !find("#clarification-heading"), "Multiple AI stages are rendered");
    check(find("#project-draft").textContent.includes("Chưa biết") &&
      find("#project-draft").textContent.includes("Không có việc tiên quyết"), "Empty and missing dependencies are not distinct");
    const draftBeforeHelp = find("#project-draft").textContent;
    const guide = await openHelp("setup");
    await askHelp(guide, "Bảng Kanban xài như thế nào?", kanbanAnswer);
    await askHelp(guide, "Khi đổi cột thì xem lịch mới ở đâu?", combinedAnswer);
    check(getComputedStyle(guide.panel.querySelector(".guide-answer")).whiteSpace === "pre-line", "Grounded answer lost its line breaks");
    change(guide.input, fallbackQuestion);
    await click("Hỏi");
    await waitFor(() => finishHelpFallback && guide.panel.textContent.includes("Đang đối chiếu với hướng dẫn"), "Slow help has no pending feedback");
    check(guide.panel.querySelector('[type="submit"]').getAttribute("aria-disabled") === "true", "Pending help permits duplicate submissions");
    finishHelpFallback();
    await waitFor(() => guide.panel.textContent.includes(helpFallback), "Help fallback did not appear");
    check(guide.input.value === fallbackQuestion, "Fallback discarded the question");
    const fallbackSuggestions = guide.panel.querySelectorAll(".guide-question");
    check(fallbackSuggestions.length === 4 && fallbackSuggestions[0].textContent.includes("Kanban"), "Fallback lost related suggestions");
    await askHelp(guide, "Không có trong hướng dẫn", "Chưa có câu trả lời.");
    await askHelp(guide, "Lỗi kết nối", "Không tải được câu trả lời.");
    guide.panel.querySelector(".guide-question").click();
    await waitFor(() => guide.panel.textContent.includes(helpAnswer), "A suggested FAQ did not return an answer");
    await guide.close();
    check(find("#project-draft").textContent === draftBeforeHelp, "Help changed the draft being reviewed");
    await click("Xác nhận các gợi ý");
    check(button("Áp dụng bản nháp").disabled, "Missing fields did not block application");
    await completeMissingTask();
    await waitFor(() => button("Áp dụng bản nháp")?.disabled === false, "Explicit review did not unlock application");
    await click("Đóng bản nháp");

    await describe("Thử lại khi cần giữ bản nháp.");
    await waitFor(() => answerInputs().length === 3, "Three questions were not displayed");
    change(answerInputs()[0], "Có giao hàng nội thành.");
    await click("Tạo bản nháp");
    await waitFor(() => finishDraftFailure && button("Đang tạo bản nháp…")?.disabled, "Draft was not pending");
    check(button("Bỏ qua tất cả").disabled && answerInputs()[0].matches(":disabled"), "Pending draft accepted edits or skip");
    check(answerInputs()[0].value === "Có giao hàng nội thành.", "Pending draft cleared the answer");
    check(find(".setup-description").textContent.includes("có thể gửi lại yêu cầu một lần"), "Pending message did not explain a possible retry");
    const draftCalls = calls.filter(({ path }) => path === "/api/planning/draft").length;
    const form = find(".setup-description");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await pause();
    check(calls.filter(({ path }) => path === "/api/planning/draft").length === draftCalls, "Pending retry submitted a duplicate draft");
    check(confirms === 0 && find("#project-heading").textContent === "Dự án mới", "Pending draft changed the active project");
    finishDraftFailure();
    finishDraftFailure = undefined;
    await waitFor(() => find('[role="alert"]')?.textContent.includes("quá thời gian"), "Draft generation error was not shown");
    check(answerInputs()[0].value === "Có giao hàng nội thành.", "A failed draft cleared the answer");
    await click("Mở lại bản nháp");
    await click("Quay lại yêu cầu");
    await waitFor(() => answerInputs()[0]?.value === "Có giao hàng nội thành.", "Reopening a previous draft cleared new answers");
    await click("Mở lại bản nháp");
    await click("Áp dụng bản nháp");
    await click("Dừng xác nhận");
    finishCancelledConfirmation();
    await pause();
    check(find("#project-heading").textContent === "Dự án mới", "Cancelled confirmation wrote the active project");
    await click("Áp dụng bản nháp");
    await waitFor(() => finishGuideConfirmation, "Draft confirmation did not start");
    const confirmingGuide = await openHelp("setup");
    await askHelp(confirmingGuide, "Cách dùng AI Planning Assistant?", helpAnswer);
    await confirmingGuide.close();
    finishGuideConfirmation();
    await waitFor(() => find("#project-heading").textContent === "Trang nhận đơn", "Validated draft was not applied");
    check(calls.filter(({ path }) => path === "/api/parse/confirm")[1].payload.tasks[1].duration === 2,
      "Reopening the draft lost the manual edit");
    check(find(".setup-calendar-fields input").value === "20/11/2026" && find(".member-list").textContent.includes("Minh"),
      "Applying a draft discarded the calendar or member roster");

    await click("Thiết lập");
    await describe("Lỗi nhà cung cấp");
    await waitFor(() => find('[role="alert"]')?.textContent.includes("Gemini tạm thời"), "Provider error was not shown");
    check(find("#planning-description").value === "Lỗi nhà cung cấp", "Provider error cleared the description");
    const callsBeforeManual = calls.length;
    await click("Thêm thủ công");
    const name = await waitFor(() => find("dialog[open] input[name=name]"), "Manual editor did not open");
    change(name, "Việc tạo thủ công");
    const editingGuide = await openHelp("setup", ".task-dialog[open] .guide-trigger");
    await askHelp(editingGuide, "Tạo lịch dự án?", helpAnswer);
    await editingGuide.close();
    check(name.closest("dialog").open && name.value === "Việc tạo thủ công", "Help reset or closed the task being edited");
    await click("Lưu công việc");
    await click("Kế hoạch");
    await waitFor(() => find("#workspace-planning").textContent.includes("Việc tạo thủ công"), "Manual task was not saved");
    check(calls.slice(callsBeforeManual).every(({ path }) => path.startsWith("/api/help/")), "Manual entry depended on Gemini");

    await click("Thiết lập");
    await waitFor(() => find("#planning-apply-blocked")?.textContent.includes("chưa có công việc"), "Early apply-blocked notice missing");
    check(find(".ai-status-btn")?.textContent.includes("Gemini: Sẵn sàng"), "Gemini status badge missing");
    await describe("Thử lại khi cần giữ dự án hiện tại.");
    await click("Bỏ qua tất cả");
    await waitFor(() => finishDraftFailure && button("Đang tạo bản nháp…")?.disabled, "Request against active project was not pending");
    finishDraftFailure();
    await waitFor(() => find('[role="alert"]')?.textContent.includes("quá thời gian"), "Active project request did not show failure");
    check(confirms === 2 && find("#project-heading").textContent === "Trang nhận đơn", "Failed generation replaced the active project");
    await click("Kế hoạch");
    await waitFor(() => find("#workspace-planning").textContent.includes("Việc tạo thủ công"), "Failed generation removed an existing task");
    await click("Thiết lập");
    await click("Sửa mô tả");
    await describe("Thử lại với dự án mới.");
    await click("Bỏ qua tất cả");
    await waitFor(() => find("#draft-blocked"), "No active project protection message");
    await click("Xác nhận các gợi ý");
    await completeMissingTask();
    await waitFor(() => find("#draft-readiness")?.textContent === "Bản nháp đã được duyệt.", "Draft was not fully reviewed");
    check(button("Áp dụng bản nháp").disabled, "Active project was not protected");
    check(confirms === 2 && find("#project-heading").textContent === "Trang nhận đơn", "Preview modified the active project");

    change(find('.setup-calendar-fields .date-field:nth-child(2) input'), "30/11/2026");
    await click("Kế hoạch");
    for (const select of document.querySelectorAll('#workspace-planning select[aria-label^="Người phụ trách"]')) {
      change(select, select.options[1].value);
      await pause();
    }
    await click("Tính lịch ban đầu");
    await click("Chấp nhận lịch");
    const accepted = await waitFor(() => find('[aria-labelledby="accepted-heading"]'), "Missing accepted schedule");
    const initialSchedule = accepted.textContent;
    const planningGuide = await openHelp("planning");
    await askHelp(planningGuide, "OPTIMAL?", helpAnswer);
    await planningGuide.close();
    check(accepted.textContent === initialSchedule && !find("#schedule-proposal"), "Help invalidated the accepted schedule");

    await click("Tiến độ");
    change(find('select[aria-label^="Di chuyển T1:"]'), "Done");
    await pause();
    change(find('select[aria-label^="Di chuyển T2:"]'), "Doing");
    change(find(".progress-dates input"), "22/11/2026");
    await pause();
    change(find('input[aria-label="Số ngày thực tế còn lại của T2"]'), "2");
    const finishLabel = [...find("#progress-heading").parentElement.querySelectorAll("label")]
      .find((label) => label.textContent === "Ngày hoàn thành thực tế của T1");
    change(document.getElementById(finishLabel.htmlFor), "22/11/2026");
    await click("Đề xuất lịch mới");
    const proposal = await waitFor(() => find("#schedule-proposal"), "Missing progress proposal");
    const progressBeforeHelp = find('#workspace-recovery [aria-label="Tiến độ công việc"]').textContent;
    check(progressBeforeHelp.includes("Đã xác nhận · 22/11/2026"), "The report did not confirm actual progress");
    const recoveryGuide = await openHelp("recovery");
    await askHelp(recoveryGuide, "Nhập thời lượng còn lại?", helpAnswer);
    await recoveryGuide.close();
    check(find("#schedule-proposal") === proposal && !button("Chấp nhận lịch").disabled, "Help changed the proposed schedule");
    check(find('#workspace-recovery [aria-label="Tiến độ công việc"]').textContent === progressBeforeHelp &&
      find('input[aria-label="Số ngày thực tế còn lại của T2"]').value === "2", "Help changed progress");
    check(document.querySelector('nav [aria-current="page"]').textContent.startsWith("Tiến độ"), "Help changed the workspace");
    const helpCalls = calls.filter(({ path }) => path === "/api/help/ask");
    check(helpCalls.every(({ payload }) => Object.keys(payload).sort().join() === "question,workspace"), "Help sent project data");
    check(find("#project-heading").textContent === "Trang nhận đơn" && !!find("#project-draft"), "Help reset the project or saved draft");
    await openHelp("recovery");
  };
}

test("React production UI preserves planning, editing, schedules, and progress while using the keyboard-accessible guide",
  { skip: !browser && "Set CONSTRAINTLENS_TEST_BROWSER to run the browser regression" }, async () => {
    await withProductionBrowser(prepareBrowserScenario, async (socket) => {
      const layout = `(() => {
        const panel = document.querySelector('#application-guide');
        const { left, right, top, bottom } = panel.getBoundingClientRect();
        return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight && panel.scrollWidth === panel.clientWidth;
      })()`;
      assert.equal(await evaluate(socket, layout), true, "Help overflows the desktop viewport");
      await command(socket, "Emulation.setDeviceMetricsOverride", { width: 320, height: 320, deviceScaleFactor: 1, mobile: true });
      assert.equal(await evaluate(socket, layout), true, "Help overflows the mobile viewport");
      assert.equal(await evaluate(socket, `(() => {
        const panel = document.querySelector('#application-guide');
        return panel.scrollHeight > panel.clientHeight && getComputedStyle(panel).overflowY === 'auto';
      })()`), true, "The help panel cannot scroll on a short screen");
      await press(socket, "Tab", 9);
      assert.equal(await evaluate(socket, 'document.activeElement.matches(".guide-question")'), true, "Tab skipped the suggested question");
      await press(socket, "Enter", 13);
      assert.equal(await evaluate(socket, `new Promise((resolve) => setTimeout(() =>
        resolve(document.querySelector('#application-guide [role="status"]').textContent), 75))`), "Câu trả lời hướng dẫn đã xác minh.");
      await press(socket, "Tab", 9, 8);
      assert.equal(await evaluate(socket, 'document.activeElement.matches("#application-guide [type=submit]")'), true, "Shift+Tab skipped the submit button");
      await press(socket, "Escape", 27);
      assert.equal(await evaluate(socket, `new Promise((resolve) => setTimeout(() =>
        resolve(!document.querySelector('#application-guide[open]') && document.activeElement.matches('.project-bar .guide-trigger')), 75))`), true,
      "Escape did not close help and restore focus");
    });
  });
