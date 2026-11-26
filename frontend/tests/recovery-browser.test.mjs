import assert from "node:assert/strict";
import { test } from "node:test";
import { browser, command, evaluate, press, withProductionBrowser } from "./browser-harness.mjs";

function prepareRecoveryScenario() {
  const start = "2026-11-20";
  const preset = {
    project_name: "Dự án kiểm thử Recovery", team_capacity: 1, members: [{ id: "mai", name: "Mai" }],
    kanban_config: { stages: ["Thiết kế"], wip_limits: {} },
    tasks: [["T1", "Thiết kế biểu mẫu", 2, []], ["T2", "Kiểm tra biểu mẫu", 3, ["T1"]]]
      .map(([id, name, duration, dependencies]) => ({ id, name, duration, dependencies, assignee_id: "mai",
        status: "To Do", category: "Thiết kế", kanban_stage: "Thiết kế" })),
  };
  const iso = (offset) => new Date(Date.parse(start) + offset * 86400000).toISOString().slice(0, 10);
  const offset = (date) => (Date.parse(date) - Date.parse(start)) / 86400000;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const schedules = [];
  const recoveries = [];
  let holdSchedule = false;
  const heldSchedules = [];

  function solve({ ir, calendar, progress }) {
    const boundary = progress ? offset(progress.progress_as_of_date) + 1 : 0;
    const scheduled_tasks = [];
    const completed_tasks = [];
    let end = boundary;
    for (const task of ir.tasks) {
      const entry = progress?.task_progress[task.id];
      if (entry?.actual_finish_date) {
        const actualEnd = offset(entry.actual_finish_date) + 1;
        completed_tasks.push({ id: task.id, name: task.name, assignee_id: task.assignee_id,
          actual_finish_date: entry.actual_finish_date, actual_end_day_exclusive: actualEnd,
          actual_end_date_exclusive: iso(actualEnd) });
      } else {
        const duration = entry?.remaining_duration ?? task.duration;
        scheduled_tasks.push({ ...task, duration, start_day: end, end_day: end + duration,
          earliest_ready_day: end, queue_wait_days: 0 });
        end += duration;
      }
    }
    if (!scheduled_tasks.length) end = Math.max(...completed_tasks.map((task) => task.actual_end_day_exclusive));
    const days_late = Math.max(0, end - 1 - offset(calendar.target_deadline_date));
    const finish = { ...calendar, project_finish_day_exclusive: end, project_finish_date_exclusive: iso(end),
      final_work_date: iso(end - 1), deadline_status: days_late ? "late" : "on_time", days_late };
    const result = { status: "OPTIMAL", scheduled_tasks, solve_time_ms: 1, errors: [] };
    return progress ? { ...result, ...finish, completed_tasks, progress_as_of_date: progress.progress_as_of_date,
      replanning_start_day: boundary, replanning_start_date: iso(boundary), remaining_horizon_days: Math.max(0, end - boundary) }
      : { calendar: finish, result: { ...result, scheduling_mode: "member" } };
  }

  function answer(payload, ai_status, options = {}) {
    const { accepted, proposal, intent = "overview", context_ref } = payload;
    const completed = !proposal.scheduled_tasks.length;
    const final = Math.max(...proposal.scheduled_tasks.map((task) => task.end_day - 1),
      ...Object.values(proposal.progress?.actual_finishes ?? {}).map(offset));
    const deadline = proposal.calendar.target_deadline_date;
    const days_late = Math.max(0, final - offset(deadline));
    const facts = [
      { id: "proposal:schedule", kind: "schedule", role: "proposal", task_ids: [],
        data: { final_work_date: iso(final), completion_kind: completed ? "actual" : "scheduled" } },
      { id: "proposal:deadline", kind: "deadline", role: "proposal", task_ids: [],
        data: { target_deadline_date: deadline, days_late, status: days_late ? "late" : "on_time" } },
      { id: "proposal:task:T2", kind: "task", role: "proposal", task_ids: ["T2"],
        data: { actual_finish_date: proposal.progress?.actual_finishes.T2 ?? null,
          start_date: proposal.scheduled_tasks.find((task) => task.task_id === "T2") && iso(final - 2), final_work_date: iso(final) } },
    ];
    if (options.unchanged) facts.push({ id: "comparison:schedule_change", kind: "schedule_change", role: null,
      task_ids: [], data: { no_changes: true } });
    const evidence = { task_ids: ["T2"], fact_ids: ["proposal:task:T2"] };
    return json({
      context_ref: options.mismatch ? "context-from-another-request" : context_ref,
      basis: { accepted_ref: accepted?.snapshot_ref ?? null, proposal_ref: proposal.snapshot_ref, selected_role: "proposal",
        comparison: accepted ? "compared" : "single_schedule", highlighted_fact_ids: facts.map(({ id }) => id),
        evaluation_deadline_date: deadline, intent },
      facts, possible_explanations: [{ ...evidence, id: "explanation", text: options.text ?? "Giải thích từ API về T2." }],
      suggestions: completed || options.unchanged ? [] : [{ ...evidence, id: "suggestion", status: "unverified", text: "Rà soát bàn giao cho T2." }],
      unknowns: [{ code: "unknown", text: "Chưa xác định tác động của phương án thay đổi.", task_ids: [] }], ai_status,
    });
  }

  window.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const payload = options?.body && JSON.parse(options.body);
    if (path === "/api/presets") return json({ Mẫu: preset, Khác: { ...preset, project_name: "Dự án khác" } });
    if (path === "/api/ai/status") return json({ configured: false, model: "gemini-3.6-flash" });
    if (path === "/api/validate" || path === "/api/reschedule/validate") return json({ valid: true, errors: [] });
    if (["/api/solve", "/api/reschedule"].includes(path)) {
      schedules.push(payload);
      const result = solve(payload);
      if (!holdSchedule) return json(result);
      holdSchedule = false;
      // Allow this mock to respond even after the client deliberately cancels the request.
      return new Promise((resolve, reject) => heldSchedules.push({
        signal: options.signal, result, respond: (data) => resolve(json(data)),
        offline: () => reject(new TypeError("Failed to fetch")),
      }));
    }
    if (path === "/api/recovery/explain") {
      // Deliberately ignore abort so a stale request can still resolve or reject.
      return new Promise((resolve, reject) => {
        recoveries.push({ payload, signal: options.signal, respond: (status, settings) => resolve(answer(payload, status, settings)),
          invalid: () => resolve(json({ detail: [{ msg: "Snapshot không nhất quán" }] }, 422)),
          offline: () => reject(new TypeError("Failed to fetch")) });
      });
    }
    throw new Error("Unexpected endpoint " + path);
  };
  window.confirm = () => true;

  const find = (selector) => document.querySelector(selector);
  const button = (label) => [...document.querySelectorAll("button")].find((item) =>
    !item.closest("[hidden], dialog:not([open])") && item.textContent.trim() === label);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  async function waitFor(get, message) {
    for (let attempt = 0; attempt < 125; attempt++) {
      const value = get();
      if (value) return value;
      await pause();
    }
    throw new Error(message);
  }
  async function click(label) {
    const control = await waitFor(() => {
      const item = button(label);
      return item && !item.disabled && item.getAttribute("aria-disabled") !== "true" && item;
    }, "Missing enabled button " + label);
    control.click();
  }
  async function go(id) {
    find(`.workspace-link[aria-controls="workspace-${id}"]`).click();
    await waitFor(() => !find(`#workspace-${id}`).hidden, "Workspace did not change");
  }
  async function holdNextSchedule(label) {
    const index = heldSchedules.length;
    holdSchedule = true;
    await click(label);
    return waitFor(() => heldSchedules[index], "Expected a pending scheduling request");
  }
  function change(element, value) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  }
  const panel = () => find(".recovery-assistant");
  const assistantInput = () => panel()?.querySelector("input");
  const remain = () => find('input[aria-label="Số ngày thực tế còn lại của T2"]');
  const actualFinish = (id) => document.getElementById([...document.querySelectorAll("label")]
    .find((label) => label.textContent === "Ngày hoàn thành thực tế của " + id).htmlFor);
  const proposal = () => find("#schedule-proposal");
  const report = () => find('[aria-label="Tiến độ công việc"]').textContent;
  const launch = async () => {
    await click("Trợ lý phân tích lịch");
    return waitFor(panel, "Recovery did not open");
  };
  const ask = async (text) => {
    const before = recoveries.length;
    if (text) {
      change(assistantInput(), text);
      await click("Hỏi");
    } else await click("Tại sao dự án bị trễ hạn?");
    return waitFor(() => recoveries[before], "Recovery did not send a request");
  };
  const shown = (text) => waitFor(() => panel()?.textContent.includes(text), "Recovery did not display " + text);
  const noOldAnswer = async (request, label) => {
    check(request.signal.aborted, label + " did not abort Recovery");
    request.respond("used", { text: "STALE ANSWER " + label });
    await pause();
    check(!find("#root").textContent.includes("STALE ANSWER"), label + " displayed a stale answer");
  };

  return async () => {
    const presetSelect = await waitFor(() => {
      const select = find(".setup-source select");
      return select?.options.length === 3 && select;
    }, "Preset missing");
    change(presetSelect, "Mẫu");
    await pause();
    change(find(".setup-calendar-fields input"), "20/11/2026");
    change(find(".setup-calendar-fields .date-field:nth-child(2) input"), "26/11/2026");
    await go("recovery");
    check(!button("Trợ lý phân tích lịch"), "Empty project offered Recovery without a schedule");
    await go("planning");
    await click("Tính lịch ban đầu");
    const initial = await launch();
    check(initial.textContent.includes("Chưa có lịch đã chấp nhận để đối chiếu") && !button("Tại sao lịch của tôi thay đổi?"),
      "Initial proposal was presented as a comparison");
    const initialRequest = await ask("T2 phụ thuộc công việc nào?");
    check(initialRequest.payload.accepted === null && initialRequest.payload.proposal.progress === null &&
      initialRequest.payload.intent === undefined, "Initial request fabricated an accepted plan, progress, or custom intent");
    initialRequest.respond("skipped");
    await shown("24/11/2026");
    await click("Chấp nhận lịch");
    const acceptedBefore = find('[aria-labelledby="accepted-heading"]').lastElementChild.textContent;

    await click("Lập lịch lại");
    await waitFor(proposal, "Missing unchanged reschedule proposal");
    await launch();
    const unchanged = await ask();
    check(unchanged.payload.accepted.snapshot_ref === initialRequest.payload.proposal.snapshot_ref &&
      unchanged.payload.accepted.snapshot_ref !== unchanged.payload.proposal.snapshot_ref,
      "Unchanged reschedule has incorrect snapshot identities");
    unchanged.respond("skipped", { unchanged: true });
    await shown("Không có thay đổi về lịch");
    await click("Hủy đề xuất");

    await go("recovery");
    const reportingDate = () => find(".progress-dates input");
    const todoReview = () => find(".review-confirmation input");
    const pending = () => find("#planning-progress-required");
    change(reportingDate(), "20/11/2026");
    (await waitFor(todoReview, "Missing To Do confirmation")).click();
    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Missing proposal based on the To Do report");
    await click("Hủy đề xuất");
    check(todoReview().checked && !pending(), "Cancel did not keep the confirmed To Do review");
    todoReview().click();
    await go("planning");
    check(pending() && button("Lập lịch lại").disabled, "Withdrawing a To Do confirmation did not block planning");
    await go("recovery");
    todoReview().click();
    await waitFor(() => !pending(), "Rechecking the same To Do tasks did not clear the warning");

    change(find('select[aria-label^="Di chuyển T1:"]'), "Done");
    change(find('select[aria-label^="Di chuyển T2:"]'), "Doing");
    change(find(".progress-dates input"), "21/11/2026");
    const firstFinish = await waitFor(() => actualFinish("T1"), "Missing T1 finish");
    change(firstFinish, "20/11/2026");
    await click("Kiểm tra tiến độ");
    await waitFor(() => find("#workspace-recovery").textContent.includes("Tiến độ hợp lệ."), "Progress validation did not finish");
    check(pending() && firstFinish.value === "20/11/2026", "Validation submitted the draft Done date");
    change(firstFinish, "21/11/2026");
    change(remain(), "8");
    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Missing late recovery proposal");
    const latePanel = await launch();
    const lateProposal = proposal();
    const reportBefore = report();
    const editorBefore = find("#workspace-planning [aria-label='Bảng công việc']").textContent;
    const kanbanBefore = find("#kanban-heading").parentElement.parentElement.textContent;
    const schedulesBefore = schedules.length;
    const late = await ask();
    const { accepted, proposal: proposed, intent } = late.payload;
    check(accepted.tasks[0].status === "To Do" && accepted.progress === null && accepted.scheduled_tasks.length === 2,
      "Recovery mixed accepted data with the live editor");
    check(proposed.tasks[1].estimated_duration === 3 && proposed.tasks[1].dependencies[0] === "T1" &&
      proposed.tasks[1].assignee_id === "mai" && proposed.progress.actual_finishes.T1 === "2026-11-21" &&
      proposed.progress.remaining_durations.T2 === 8 && proposed.scheduled_tasks[0].task_id === "T2" &&
      proposed.scheduled_tasks[0].start_day === 2 && proposed.calendar.target_deadline_date === "2026-11-26" && intent === "causes",
      "Recovery sent the wrong progress snapshot or intent");
    latePanel.querySelector('[type="submit"]').click();
    latePanel.querySelector(".guide-question").click();
    check(latePanel.querySelector('[role="status"]').textContent.includes("Đang phân tích lịch") &&
      recoveries.at(-1) === late, "Loading feedback missing or duplicate request allowed");
    const accept = button("Chấp nhận lịch");
    check(accept.disabled, "The late proposal can be accepted while Recovery is loading");
    late.respond("unavailable");
    await shown("Gemini tạm thời không khả dụng");
    await shown("Trễ 3 ngày");
    check(!pending(), "Recovery marked the confirmed report as edited");
    for (const title of ["Dữ kiện đã kiểm tra", "Giải thích có thể", "Gợi ý xử lý", "Chưa thể xác định", "đều chưa được kiểm chứng"]) {
      await shown(title);
    }
    check(accept.disabled && proposal() === lateProposal && report() === reportBefore && schedules.length === schedulesBefore &&
      remain().value === "8" && find("#kanban-heading").parentElement.parentElement.textContent === kanbanBefore &&
      find("#workspace-planning [aria-label='Bảng công việc']").textContent === editorBefore &&
      find('[aria-labelledby="accepted-heading"]').lastElementChild.textContent === acceptedBefore, "Recovery mutated project, plans, or progress");

    const progressRetry = await holdNextSchedule("Đề xuất lịch mới");
    check(proposal() === lateProposal && accept.disabled &&
      proposal().textContent.includes("đề xuất từ lần tính trước"), "Retry discarded or misrepresented the previous progress proposal");
    progressRetry.offline();
    await waitFor(() => find("#workspace-recovery [role='alert']")?.textContent.includes("Đề xuất từ lần tính trước vẫn được giữ"),
      "Progress retry did not report the network error and retained proposal");
    check(proposal() === lateProposal && accept.disabled && report() === reportBefore &&
      find('[aria-labelledby="accepted-heading"]').lastElementChild.textContent === acceptedBefore,
      "Failed progress retry changed the late proposal, confirmed report or accepted schedule");
    const mismatchedReport = await holdNextSchedule("Đề xuất lịch mới");
    mismatchedReport.respond({ ...mismatchedReport.result, progress_as_of_date: "2026-11-22" });
    await waitFor(() => find("#workspace-recovery [role='alert']")?.textContent.includes("không khớp với báo cáo đã gửi"),
      "A returned schedule with the wrong report date was treated as valid");
    check(proposal() === lateProposal && report() === reportBefore, "A mismatched response changed the proposal or report");

    const missingKey = await ask();
    missingKey.respond("missing_key");
    await shown("chưa cấu hình khóa Gemini");
    await shown("Trễ 3 ngày");
    const timedOut = await ask();
    timedOut.respond("timeout");
    await shown("quá thời gian chờ");
    const offline = await ask("Vì sao T2 bị trễ?");
    offline.offline();
    await shown("Không kết nối được với trợ lý giải thích lịch");
    check(assistantInput().value === "Vì sao T2 bị trễ?", "Network failure erased the question");
    const invalid = await ask();
    invalid.invalid();
    await shown("dữ liệu lịch gửi lên không hợp lệ hoặc không khớp");
    const mismatch = await ask();
    mismatch.respond("used", { mismatch: true, text: "WRONG CONTEXT" });
    await shown("Câu trả lời không khớp với lịch đang xem");
    check(!panel().textContent.includes("WRONG CONTEXT"), "Mismatched response rendered as analysis");

    const closed = await ask();
    await click("Đóng trợ lý");
    await launch();
    const reopened = await ask();
    await noOldAnswer(closed, "Closing the panel");
    check(reopened.payload.context_ref !== closed.payload.context_ref && panel().textContent.includes("Đang phân tích lịch"),
      "Canceled request cleared a newer pending request");
    await click("Đề xuất lịch mới");
    await waitFor(() => button("Trợ lý phân tích lịch")?.getAttribute("aria-expanded") === "false",
      "Successful recalculation did not replace the old Recovery context");
    await launch();
    const replacement = await ask();
    check(replacement.payload.accepted.snapshot_ref === reopened.payload.accepted.snapshot_ref &&
      replacement.payload.proposal.snapshot_ref !== reopened.payload.proposal.snapshot_ref &&
      replacement.payload.context_ref !== reopened.payload.context_ref, "Replacement reused proposal identity under the same accepted revision");
    await noOldAnswer(reopened, "Replacing the proposal");
    await click("Hủy đề xuất");
    await noOldAnswer(replacement, "Cancelling the proposal");
    check(report() === reportBefore, "Canceling the proposal removed the confirmed progress report");

    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Proposal missing before task edit test");
    await launch();
    const beforeTaskEdit = await ask();
    find('button[aria-label^="Sửa công việc T2 trên Kanban"]').click();
    change(await waitFor(() => find("dialog[open] input[name=duration]"), "Missing task editor"), "4");
    await click("Lưu công việc");
    await waitFor(() => !proposal(), "Task edit did not remove old proposal");
    await noOldAnswer(beforeTaskEdit, "Editing T2");

    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Proposal missing before progress edit test");
    await launch();
    const beforeProgressEdit = await ask();
    change(remain(), "2");
    await waitFor(() => !proposal(), "Progress edit did not remove old proposal");
    await noOldAnswer(beforeProgressEdit, "Changing the remaining duration");

    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Proposal missing before acceptance test");
    await launch();
    const valid = await ask();
    check(valid.payload.accepted.tasks[1].estimated_duration === 3 && valid.payload.proposal.tasks[1].estimated_duration === 4,
      "Edited task duration overwrote accepted snapshot");
    await click("Chấp nhận lịch");
    await waitFor(() => !proposal() && find("#schedule-comparison")?.textContent.includes("Bạn đang xem lịch sử"), "Historical notice missing");
    await noOldAnswer(valid, "Accepting a valid proposal");
    const historyPanel = await launch();
    const historyReq = await ask("Vì sao lịch trước và hiện tại khác nhau?");
    check(historyReq.payload.accepted?.snapshot_ref && historyReq.payload.proposal?.snapshot_ref &&
      historyReq.payload.accepted.snapshot_ref !== historyReq.payload.proposal.snapshot_ref,
      "Historical Recovery did not send both accepted comparison snapshots");
    historyReq.respond("skipped");
    await shown("Tóm tắt nhanh (TL;DR)");
    check(Boolean(historyPanel.querySelector(".recovery-tldr")), "Historical Recovery missing TL;DR summary");
    await click("Đóng trợ lý");

    await go("planning");
    const acceptedAfterProgress = find('[aria-labelledby="accepted-heading"]').lastElementChild.textContent;
    check(!pending() && !button("Lập lịch lại").disabled, "Accepting a matching report left a progress warning");
    await click("Lập lịch lại");
    await waitFor(proposal, "Matching confirmed report could not be used in Planning");
    await launch();
    const beforePlanningRetry = await ask();
    beforePlanningRetry.respond("skipped");
    await shown("Dữ kiện đã kiểm tra");
    const failedRetry = await holdNextSchedule("Lập lịch lại");
    check(proposal()?.textContent.includes("đề xuất từ lần tính trước") && button("Chấp nhận lịch")?.disabled,
      "Planning retry discarded or misrepresented the previous proposal");
    failedRetry.offline();
    await waitFor(() => find("#workspace-planning [role='alert']")?.textContent.includes("Đề xuất từ lần tính trước vẫn được giữ"),
      "Planning retry failed without a clear message about the prior proposal");
    const afterFailure = await ask();
    check(afterFailure.payload.proposal.snapshot_ref === beforePlanningRetry.payload.proposal.snapshot_ref &&
      !button("Chấp nhận lịch").disabled, "Failed Planning retry replaced or disabled the valid proposal");
    afterFailure.respond("skipped");
    await shown("Dữ kiện đã kiểm tra");

    const canceledRetry = await holdNextSchedule("Lập lịch lại");
    await click("Hủy đề xuất");
    check(canceledRetry.signal.aborted, "Cancel did not abort the calculation");
    await click("Lập lịch lại");
    const matchingProposal = await waitFor(proposal, "Successful retry did not create a replacement");
    await launch();
    const afterReplacement = await ask();
    check(afterReplacement.payload.proposal.snapshot_ref !== afterFailure.payload.proposal.snapshot_ref, "Retry reused the previous proposal");
    const wrongDate = "2026-12-10";
    canceledRetry.respond({ ...canceledRetry.result, final_work_date: wrongDate, project_finish_date_exclusive: "2026-12-11" });
    await pause();
    check(proposal() === matchingProposal && !afterReplacement.signal.aborted && !button("Chấp nhận lịch").disabled,
      "A response from the canceled calculation replaced the current proposal");
    afterReplacement.respond("skipped");
    await go("recovery");
    change(remain(), "02");
    await waitFor(() => remain().value === "02", "Equivalent remaining duration was not entered");
    check(proposal() === matchingProposal && !pending(), "Equivalent formatting invalidated the report or proposal");
    const countBeforeEdit = schedules.length;
    change(remain(), "20");
    await go("planning");
    check(pending() && button("Lập lịch lại").disabled && !button("Chấp nhận lịch"), "Pending progress left a stale schedule actionable");
    button("Lập lịch lại").click();
    await go("recovery");
    check(remain().value === "20" && schedules.length === countBeforeEdit, "Tab switch lost the draft or Planning sent the old report");
    change(remain(), "2");
    await waitFor(() => !pending(), "Reverting the remaining duration did not clear the warning");
    change(reportingDate(), "22/11/2026");
    await waitFor(pending, "A changed reporting date did not block Planning");
    change(reportingDate(), "21/11/2026");
    await waitFor(() => !pending(), "Restoring the reporting date did not clear the warning");
    check(find('[aria-labelledby="accepted-heading"]').lastElementChild.textContent === acceptedAfterProgress, "Draft edits changed the accepted schedule");

    change(find('select[aria-label^="Di chuyển T2:"]'), "Done");
    change(find(".progress-dates input"), "25/11/2026");
    change(await waitFor(() => actualFinish("T2"), "Missing T2 finish"), "25/11/2026");
    await click("Đề xuất lịch mới");
    await waitFor(proposal, "Completed proposal missing");
    await launch();
    const complete = await ask();
    check(complete.payload.proposal.scheduled_tasks.length === 0 && complete.payload.proposal.progress.actual_finishes.T2 === "2026-11-25",
      "Completed project was treated as a missing schedule");
    complete.respond("skipped");
    await shown("Dự án đã hoàn thành. Ngày hoàn thành thực tế 25/11/2026");

    const leaving = await ask();
    await go("setup");
    change(find(".setup-source select"), "Khác");
    await waitFor(() => find("#project-heading").textContent === "Dự án khác", "Project switch failed");
    await noOldAnswer(leaving, "Switching projects");
    await go("recovery");
    check(!button("Trợ lý phân tích lịch"), "New project inherited previous schedule analysis");

    // Leave an initial proposal open for keyboard input and viewport checks via CDP.
    await go("setup");
    change(find(".setup-source select"), "Mẫu");
    await pause();
    change(find(".setup-calendar-fields input"), "20/11/2026");
    change(find(".setup-calendar-fields .date-field:nth-child(2) input"), "26/11/2026");
    await go("planning");
    await click("Tính lịch ban đầu");
    await waitFor(proposal, "Initial desktop proposal missing");
    const ganttOffset = () => find("#schedule-proposal .panel").getBoundingClientRect().top - proposal().getBoundingClientRect().top;
    const ganttBeforeDrawer = ganttOffset();
    await launch();
    const ganttWithDrawer = ganttOffset();
    check(Math.abs(ganttWithDrawer - ganttBeforeDrawer) < 1, "Opening Recovery side drawer pushed Gantt vertically");
    const mobileAnswer = await ask();
    mobileAnswer.respond("unavailable");
    await shown("Dữ kiện đã kiểm tra");
    assistantInput().focus();
  };
}

test("React production UI explains the displayed schedule without applying changes or showing stale Recovery results",
  { skip: !browser && "Set CONSTRAINTLENS_TEST_BROWSER to run the browser regression" }, async () => {
    await withProductionBrowser(prepareRecoveryScenario, async (socket) => {
      const desktopLayout = await evaluate(socket, `(() => {
        const panel = document.querySelector('.recovery-assistant');
        const tldr = panel.querySelector('.recovery-tldr');
        const factsHeading = panel.querySelector('.recovery-results h6');
        const rect = panel.getBoundingClientRect();
        return {
          isRightDrawer: getComputedStyle(panel).position === 'fixed' && rect.left > 0 && rect.right <= innerWidth && rect.width < innerWidth,
          tldrBeforeFacts: Boolean(tldr && factsHeading && (tldr.compareDocumentPosition(factsHeading) & Node.DOCUMENT_POSITION_FOLLOWING)),
          tldrText: tldr?.textContent ?? '',
        };
      })()`);
      assert.ok(desktopLayout.isRightDrawer, `Desktop drawer positioning invalid ${JSON.stringify(desktopLayout)}`);
      assert.ok(desktopLayout.tldrBeforeFacts && desktopLayout.tldrText.includes("Tóm tắt nhanh"),
        `Desktop TL;DR missing or misplaced ${JSON.stringify(desktopLayout)}`);
      const fits = `(() => {
        const panel = document.querySelector('.recovery-assistant');
        const results = panel.querySelector('.recovery-results');
        const rect = panel.getBoundingClientRect();
        return {
          panelFits: rect.left >= 0 && rect.right <= innerWidth && panel.scrollWidth === panel.clientWidth,
          resultsFit: results.scrollWidth === results.clientWidth,
          resultsScroll: results.scrollHeight > results.clientHeight && getComputedStyle(results).overflowY === 'auto',
          widths: [rect.left, rect.right, innerWidth, panel.scrollWidth, panel.clientWidth, results.scrollWidth, results.clientWidth],
          heights: [results.scrollHeight, results.clientHeight],
        };
      })()`;
      await command(socket, "Emulation.setDeviceMetricsOverride", { width: 320, height: 320, deviceScaleFactor: 1, mobile: true });
      const layout = await evaluate(socket, fits);
      assert.ok(layout.panelFits && layout.resultsFit && layout.resultsScroll, `Recovery layout at 320 px ${JSON.stringify(layout)}`);
      assert.equal(await evaluate(socket, 'document.activeElement.matches(".recovery-form-row input")'), true);
      await press(socket, "Tab", 9);
      assert.equal(await evaluate(socket, 'document.activeElement.matches(".recovery-assistant [type=submit]:focus-visible")'), true);
      await press(socket, "Tab", 9);
      assert.equal(await evaluate(socket, 'document.activeElement.matches(".recovery-assistant .guide-question")'), true);
      await press(socket, "Escape", 27);
      assert.equal(await evaluate(socket, 'document.activeElement.matches("[data-recovery-assistant] button[aria-expanded=false]")'), true);
      await press(socket, "Enter", 13);
      assert.equal(await evaluate(socket, 'document.activeElement.matches(".recovery-form-row input")'), true);
      await press(socket, "Tab", 9);
      await press(socket, "Tab", 9);
      await press(socket, "Enter", 13);
      assert.equal(await evaluate(socket, `document.querySelector('.recovery-assistant [role="status"]').textContent.trim()`), "Đang phân tích lịch…");
      await press(socket, "Escape", 27);
    });
  });
