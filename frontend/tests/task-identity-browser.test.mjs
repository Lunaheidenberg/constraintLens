import { test } from "node:test";
import { browser, withProductionBrowser } from "./browser-harness.mjs";

function prepareTaskIdentityScenario() {
  const start = Date.parse("2026-11-01");
  const dateAt = (day) => new Date(start + day * 86400000).toISOString().slice(0, 10);
  const task = (id, name, dependencies = []) => ({
    id, name, duration: 1, dependencies, status: "To Do", assignee_id: "M1", category: "Coding", kanban_stage: "Coding",
  });
  const preset = {
    project_name: "Bookstore", team_capacity: 2, kanban_config: { stages: ["Coding"], wip_limits: {} },
    members: [{ id: "M1", name: "Mai" }, { id: "M2", name: "An" }],
    tasks: Array.from({ length: 8 }, (_, index) => task(`T${index + 1}`,
      index === 7 ? "Seed books" : `Task ${index + 1}`, index === 1 || index === 2 ? [`T${index}`] : [])),
  };
  const json = (body) => new Response(JSON.stringify(body));
  const solved = [];
  const recoveries = [];
  const provided = { kind: "description" };
  window.confirm = () => true;
  window.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options?.body && JSON.parse(options.body);
    if (path === "/api/presets") return json({
      Bookstore: preset, Other: { ...preset, project_name: "Other" }, Empty: { ...preset, project_name: "Empty", tasks: [] },
    });
    if (path === "/api/validate") return json({ valid: true, errors: [] });
    if (path === "/api/solve") {
      solved.push(body);
      let end = 0;
      const tasks = new Map();
      const scheduled_tasks = body.ir.tasks.map((item) => {
        const start_day = end;
        const earliest_ready_day = Math.max(0, ...item.dependencies.map((id) => tasks.get(id)));
        end += item.duration;
        tasks.set(item.id, end);
        return { ...item, start_day, end_day: end, earliest_ready_day, queue_wait_days: start_day - earliest_ready_day };
      });
      return json({ result: { status: "FEASIBLE", scheduling_mode: "member", scheduled_tasks, solve_time_ms: 1, errors: [] },
        calendar: { ...body.calendar, final_work_date: dateAt(end - 1), project_finish_day_exclusive: end,
          project_finish_date_exclusive: dateAt(end), deadline_status: "on_time", days_late: 0 } });
    }
    if (path === "/api/recovery/explain") {
      recoveries.push(body);
      return json({
        context_ref: body.context_ref,
        basis: { accepted_ref: body.accepted.snapshot_ref, proposal_ref: body.proposal.snapshot_ref,
          selected_role: "proposal", comparison: "compared", evaluation_deadline_date: body.proposal.calendar.target_deadline_date,
          intent: "changes", highlighted_fact_ids: [] },
        facts: [], possible_explanations: [], suggestions: [], unknowns: [], ai_status: "skipped",
      });
    }
    if (path === "/api/planning/clarify") return json({ goal: "Plan tasks", questions: [] });
    if (path === "/api/planning/draft") return json({
      goal: "Plan tasks", assumptions: [], uncertainties: [],
      draft: { project_name: "AI project", tasks: [["T1", "AI task", []], ["T2", "Follow-up", ["T1"]]].map(
        ([id, name, dependencies]) => ({ id, name, category: "Coding", duration: 1, dependencies,
          duration_review: "provided", dependency_review: "provided" }),
      ) },
      sources: { goal: provided, project_name: provided, tasks: Object.fromEntries(["T1", "T2"].map((id) =>
        [id, { name: provided, duration: provided, category: provided, dependencies: provided }])) },
    });
    if (path === "/api/parse/confirm") return json({
      ...preset, project_name: body.project_name,
      tasks: body.tasks.map(({ id, name, dependencies }) => ({ ...task(id, name, dependencies), assignee_id: null })),
    });
    throw Error(`Unexpected endpoint ${path}`);
  };

  const find = (selector) => document.querySelector(selector);
  const button = (title) => [...document.querySelectorAll("button")].find((node) =>
    !node.closest("[hidden], dialog:not([open])") && node.textContent.trim() === title);
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  async function waitFor(get, message) {
    for (let attempt = 0; attempt < 125; attempt++) {
      const value = get();
      if (value) return value;
      await pause();
    }
    throw Error(message);
  }
  async function click(title) {
    const control = await waitFor(() => {
      const candidate = button(title);
      return candidate && !candidate.disabled && candidate;
    }, `Missing enabled button ${title}`);
    control.click();
    await pause();
  }
  async function change(element, value) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    await pause();
  }
  const field = (name) => find(`dialog[open] input[name="${name}"]`);
  const proposal = () => find("#schedule-proposal");
  const acceptedGantt = () => find('[aria-labelledby="accepted-heading"] [aria-label="Biểu đồ Gantt"]');
  const edit = async (id) => {
    find(`button[aria-label^="Chỉnh sửa ${id}:"]`).click();
    await waitFor(() => field("id"), `Could not edit ${id}`);
  };
  const remove = async (id) => {
    await edit(id);
    await click("Xóa công việc");
    await click("Xác nhận xóa công việc");
    await waitFor(() => !field("id"), "Delete did not close editor");
  };
  const save = async () => {
    await click("Lưu công việc");
    await waitFor(() => !field("id"), "Task was not saved");
  };
  const togglePrerequisite = async (id) => {
    const label = [...find("dialog[open]").querySelectorAll("label")].find((item) =>
      item.querySelector('input[type="checkbox"]') && item.textContent.trim().startsWith(`${id} `));
    label.querySelector("input").click();
    await pause();
  };
  const load = async (name) => {
    await change(find(".setup-source select"), name);
    await waitFor(() => find("#project-heading").textContent === name, `Preset ${name} did not load`);
  };

  return async () => {
    await waitFor(() => find(".setup-source select")?.options.length === 4, "Presets did not load");
    await load("Bookstore");
    await change(find(".setup-calendar-fields input"), "01/11/2026");
    await change(find(".setup-calendar-fields .date-field:nth-child(2) input"), "30/11/2026");
    await click("Kế hoạch");
    await click("Tính lịch ban đầu");
    await click("Chấp nhận lịch");
    const initial = acceptedGantt().textContent;
    await edit("T3");
    await togglePrerequisite("T1");
    await save();
    await click("Lập lịch lại");
    await waitFor(proposal, "Missing proposal after dependency edit");
    await click("Có thay đổi");
    const dependencyRow = find('[aria-label="Bảng thay đổi công việc"] tbody tr');
    check(dependencyRow?.textContent.includes("T3Task 3") && dependencyRow.textContent.includes("Đổi tiên quyết") &&
      dependencyRow.textContent.includes("Giữ nguyên ngày dự kiến"), "Changed-task filter missed a dependency-only change");
    await click("Hủy đề xuất");
    await edit("T3");
    await togglePrerequisite("T1");
    await save();
    await remove("T8");
    await click("Thêm công việc");
    const newId = field("id").value;
    check(newId !== "T8", "A new task reused historical T8");
    await change(field("name"), "Database backup");
    await change(field("id"), " T8 ");
    await click("Lưu công việc");
    check(field("id")?.getAttribute("aria-invalid") === "true" && find("#task-field-error"), "Manual entry silently reused T8");
    await change(field("id"), newId);
    await change(find('dialog[open] select[aria-label^="Người phụ trách"]'), "M1");
    await save();

    await click("Lập lịch lại");
    await waitFor(proposal, "Replacement proposal did not appear");
    await click("Có thay đổi");
    const rows = find('[aria-label="Bảng thay đổi công việc"]').textContent;
    check(rows.includes("T8Seed books") && rows.includes("Đã bỏ") &&
      rows.includes(`${newId}Database backup`) && rows.includes("Mới thêm"), "Comparison merged distinct tasks");
    check(acceptedGantt().textContent === initial, "Edits changed the accepted dates, names or assignments");
    await click("Giải thích thay đổi");
    await click("Công việc nào đang bị ảnh hưởng?");
    const { accepted, proposal: revised } = await waitFor(() => recoveries.at(-1), "Recovery request missing");
    check(accepted.tasks.some(({ id, name }) => id === "T8" && name === "Seed books") &&
      !accepted.tasks.some(({ id }) => id === newId) && !revised.tasks.some(({ id }) => id === "T8") &&
      revised.tasks.some(({ id, name }) => id === newId && name === "Database backup"), "Recovery merged task identities");
    await click("Chấp nhận lịch");

    await edit("T1");
    await change(field("name"), "Renamed task");
    await change(field("duration"), "2");
    await change(find('dialog[open] select[aria-label^="Người phụ trách"]'), "M2");
    await save();
    check(find('button[aria-label="Chỉnh sửa T1: Renamed task"]'), "Property edits changed the ID");
    await edit("T1");
    await change(field("id"), "T8");
    await click("Lưu công việc");
    check(field("id")?.getAttribute("aria-invalid") === "true", "ID edits reused T8");
    await change(field("id"), "PREP");
    await save();
    await click("Lập lịch lại");
    await waitFor(proposal, "Renamed predecessor was not scheduled");
    check(solved.at(-1).ir.tasks.find(({ id }) => id === "T2").dependencies.join() === "PREP", "Renaming broke dependency references");
    await click("Chấp nhận lịch");
    await click("Tiến độ");
    await change(find("#schedule-comparison select"), "baseline");
    check(find('#schedule-comparison [aria-label="Bảng thay đổi công việc"]').textContent.includes("T8Seed books"), "Baseline lost T8");

    await click("Kế hoạch");
    await remove("PREP");
    await remove("T2");
    await click("Thêm công việc");
    const identicalTaskId = field("id").value;
    check(!["T1", "T2", "T8", newId, "PREP"].includes(identicalTaskId), "Deletion made a used ID available");
    await change(field("name"), "Seed books");
    await change(find('dialog[open] select[aria-label^="Người phụ trách"]'), "M1");
    await save();
    check(find(`button[aria-label="Chỉnh sửa ${identicalTaskId}: Seed books"]`), "Matching task properties reused historical identity");
    await click("Thiết lập");
    await load("Other");
    await click("Thêm thủ công");
    await change(field("id"), "PREP");
    await change(field("name"), "A task in another project");
    await save();

    await load("Empty");
    await click("Thêm thủ công");
    await change(field("name"), "Temporary");
    await save();
    await click("Kế hoạch");
    await remove("T1");
    await click("Thiết lập");
    await change(find("#planning-description"), "Plan tasks");
    await click("AI giúp lập kế hoạch");
    await click("Tạo bản nháp");
    await waitFor(() => find("#project-draft"), "AI draft was not generated");
    check(!button("Áp dụng bản nháp")?.disabled, `Initial draft blocked: ${find("#project-draft").textContent}`);
    await click("Áp dụng bản nháp");
    await waitFor(() => find("#project-draft [role='alert']")?.textContent.includes("T1"), "AI application reused an ID after deletion");
    find('button[aria-label="Sửa bản nháp T1"]').click();
    await waitFor(() => field("id"), "AI task editor did not open");
    await change(field("id"), "AI-FIRST");
    await save();
    await waitFor(() => find("#project-draft").textContent.includes("AI-FIRST"), "Draft ID edit was not saved");
    check(!button("Áp dụng bản nháp")?.disabled, `Edited draft blocked: ${find("#project-draft").textContent}`);
    await click("Áp dụng bản nháp");
    await waitFor(() => find("#project-heading").textContent === "AI project", "Corrected AI draft could not be applied");
    check(find('[aria-label="Công việc tiên quyết của T2"]').textContent === "AI-FIRST", "AI rename did not update the dependency");
  };
}

test("Project task IDs distinguish history, replacements and new projects in the production UI",
  { skip: !browser && "Set CONSTRAINTLENS_TEST_BROWSER to run the browser regression" }, async () => {
    await withProductionBrowser(prepareTaskIdentityScenario, async () => {});
  });
