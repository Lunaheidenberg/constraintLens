import { useEffect, useReducer, useRef, useState } from "react";
import { CalendarDays, CircleHelp, LayoutGrid, ListTodo, LoaderCircle, Play } from "lucide-react";
import { isCalendarDate } from "./calendar";
import { draftReady } from "./draft";
import { DraftEditor } from "./DraftEditor";
import { PlanComparison } from "./PlanComparison";
import { hasSolution, initialPlans, planReducer } from "./plans";
import { ProgressEditor } from "./ProgressEditor";
import { Kanban, Members, TaskDialog, TaskTable, taskCategory } from "./ProjectEditor";
import { Schedule } from "./Schedule";
import type { ParseRequest, PresetsMap, ProjectCalendar, ProjectDraft, ProgressSnapshot, RescheduleRequest, RescheduleResult, SchedulingIR, SolveRequest, SolveResponse, Task, ValidateResponse } from "./types";

const API_BASE = "http://localhost:8000";

const EMPTY_PROJECT: SchedulingIR = {
  project_name: "Dự án mới",
  team_capacity: 1,
  kanban_config: { stages: ["Coding"], wip_limits: {} },
  members: [],
  tasks: [],
};
const EMPTY_CALENDAR: ProjectCalendar = { project_start_date: "", target_deadline_date: null };

interface ProjectState {
  ir: SchedulingIR;
  instance: number;
  scheduleRevision: number;
  dirty: boolean;
}

interface Feedback {
  message: string;
  errors: string[];
}

function calendarErrors(calendar: ProjectCalendar) {
  const { project_start_date: start, target_deadline_date: deadline } = calendar;
  if (!isCalendarDate(start)) return ["Chọn ngày bắt đầu dự án hợp lệ."];
  if (deadline && !isCalendarDate(deadline)) return ["Chọn hạn chót hợp lệ hoặc để trống."];
  if (deadline && deadline < start) return ["Hạn chót mục tiêu không được trước ngày bắt đầu dự án."];
  return [];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, options);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error("Không kết nối được API. Kiểm tra máy chủ tại cổng 8000 rồi thử lại.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const detail = data?.detail;
    if (typeof detail === "string") throw new Error(detail);
    if (Array.isArray(detail)) {
      throw new Error(detail.map((item) => [item.loc?.slice(1).join("."), item.msg].filter(Boolean).join(" · ")).join("\n"));
    }
    throw new Error(`API trả về lỗi HTTP ${response.status}. Hãy thử lại.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("API trả về dữ liệu không đọc được. Hãy thử lại.");
  }
}

function post<T>(path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function schedulingErrors(ir: SchedulingIR) {
  const errors: string[] = [];
  const memberIds = new Set(ir.members?.map((member) => member.id));
  if (!ir.tasks.length) errors.push("Thêm ít nhất một công việc.");
  if (!memberIds.size) errors.push("Thêm ít nhất một thành viên.");
  const unassigned = ir.tasks.filter((task) => task.assignee_id == null);
  if (unassigned.length) errors.push(`Chọn người phụ trách cho ${unassigned.map((task) => task.id).join(", ")}.`);
  for (const task of ir.tasks) {
    if (task.assignee_id != null && !memberIds.has(task.assignee_id)) {
      errors.push(`Chọn thành viên hiện có cho ${task.id}.`);
    }
    if (!Number.isSafeInteger(task.duration) || task.duration < 1) {
      errors.push(`Sửa thời lượng của ${task.id} thành số nguyên dương.`);
    }
  }
  return errors;
}

function newTask(ir: SchedulingIR): Task {
  const ids = new Set(ir.tasks.map((task) => task.id));
  let number = ir.tasks.length + 1;
  while (ids.has(`T${number}`)) number += 1;
  const category = ir.kanban_config.stages[0] ?? "Coding";
  return { id: `T${number}`, name: "", duration: 1, dependencies: [], kanban_stage: category, category, status: "To Do", assignee_id: null };
}

function SectionTitle({ id, icon: Icon, children }: {
  id: string;
  icon: typeof LayoutGrid;
  children: React.ReactNode;
}) {
  return (
    <h2 id={id} tabIndex={-1} className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
      <Icon size={15} aria-hidden="true" className="text-zinc-400" /> {children}
    </h2>
  );
}

export default function App() {
  const [project, setProject] = useState<ProjectState>({ ir: EMPTY_PROJECT, instance: 0, scheduleRevision: 0, dirty: false });
  const { ir, instance, scheduleRevision, dirty } = project;
  const members = ir.members ?? [];
  const [presets, setPresets] = useState<PresetsMap>({});
  const [presetError, setPresetError] = useState("");
  const [presetRequest, setPresetRequest] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [prompt, setPrompt] = useState("");
  const [draftPhase, setDraftPhase] = useState<"generating" | "confirming" | null>(null);
  const [parseError, setParseError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [pendingDraft, setPendingDraft] = useState<ProjectDraft | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [calendar, setCalendar] = useState(EMPTY_CALENDAR);
  const [asOf, setAsOf] = useState("");
  const [entries, setEntries] = useState<ReadonlyMap<string, string>>(new Map());
  const [plans, dispatchPlan] = useReducer(planReducer, initialPlans);
  const [phase, setPhase] = useState<"validating" | "solving" | "checkingProgress" | "rescheduling" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [progressFeedback, setProgressFeedback] = useState<Feedback | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const progressPanel = useRef<HTMLDetailsElement>(null);
  const editVersion = useRef(0);
  const nextMemberId = useRef(1);

  const dateErrors = calendarErrors(calendar);
  const localErrors = [...dateErrors, ...schedulingErrors(ir)];
  const { accepted, proposal } = plans;
  const outdated = accepted !== null && accepted.scheduleRevision !== scheduleRevision;
  const completed = new Map((accepted?.recovery?.completed_tasks ?? []).map((task) => [task.id, task]));
  const lockedTasks = new Set(completed.keys());
  const acceptedAsOf = accepted?.recovery?.progress_as_of_date ?? "";
  const minimumAsOf = acceptedAsOf > calendar.project_start_date ? acceptedAsOf : calendar.project_start_date;
  const progressPhase = phase === "checkingProgress" || phase === "rescheduling" ? phase : null;
  const editedTask = editing === "new" ? newTask(ir) : editing === null ? null : ir.tasks[editing];

  useEffect(() => {
    const controller = new AbortController();
    request<PresetsMap>("/api/presets", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPresets(data); })
      .catch((error) => { if (!controller.signal.aborted) setPresetError(errorMessage(error)); });
    return () => controller.abort();
  }, [presetRequest]);

  function cancelScheduling() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPhase(null);
  }

  function invalidateProposal() {
    cancelScheduling();
    dispatchPlan({ type: "inputsChanged" });
    setFeedback(null);
    setProgressFeedback(null);
  }

  function changeProject(update: (current: SchedulingIR) => SchedulingIR, affectsSchedule = true) {
    editVersion.current += 1;
    invalidateProposal();
    setProject((current) => ({
      ...current,
      ir: update(current.ir),
      scheduleRevision: current.scheduleRevision + Number(affectsSchedule),
      dirty: true,
    }));
  }

  function changeCalendar(next: ProjectCalendar) {
    if (next.project_start_date === calendar.project_start_date && next.target_deadline_date === calendar.target_deadline_date) return;
    changeProject((current) => current, next.project_start_date !== calendar.project_start_date);
    setCalendar(next);
  }

  function loadProject(next: SchedulingIR, preset?: string) {
    editVersion.current += 1;
    cancelScheduling();
    setProject((current) => ({
      ir: preset === undefined ? { ...next, members: current.ir.members } : next,
      instance: current.instance + 1,
      scheduleRevision: current.scheduleRevision + 1,
      dirty: false,
    }));
    setSelectedPreset(preset ?? "");
    dispatchPlan({ type: "reset" });
    setFeedback(null);
    setProgressFeedback(null);
    setEditing(null);
    if (preset !== undefined) setCalendar(EMPTY_CALENDAR);
    setAsOf("");
    setEntries(new Map());
  }

  function confirmReplace() {
    return !dirty || window.confirm("Thay thế dự án hiện tại và bỏ các thay đổi đang chỉnh sửa?");
  }

  async function parseProject() {
    if (draftPhase || !prompt.trim()) return;
    setDraftPhase("generating");
    setParseError("");
    try {
      const payload: ParseRequest = { prompt: prompt.trim() };
      const draft = await post<ProjectDraft>("/api/parse/draft", payload);
      setPendingDraft(draft);
      setDraftError("");
    } catch (error) {
      setParseError(errorMessage(error));
    } finally {
      setDraftPhase(null);
    }
  }

  async function confirmDraft() {
    if (draftPhase || !pendingDraft || !draftReady(pendingDraft)) return;
    const version = editVersion.current;
    setDraftPhase("confirming");
    setDraftError("");
    try {
      const confirmed = await post<SchedulingIR>("/api/parse/confirm", pendingDraft);
      if (editVersion.current !== version) {
        setDraftError("Dự án đã thay đổi trong lúc kiểm tra. Hãy xem lại rồi xác nhận bản nháp lần nữa.");
        return;
      }
      loadProject(confirmed);
      setPendingDraft(null);
      setParseError("");
      setFeedback({ message: "Đã áp dụng bản nháp. Chọn người phụ trách cho từng công việc.", errors: [] });
    } catch (error) {
      setDraftError(errorMessage(error));
    } finally {
      setDraftPhase(null);
    }
  }

  async function validateProject(solve: boolean) {
    if (activeRequest.current || localErrors.length || (solve && accepted)) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    setPhase("validating");
    setFeedback(null);
    const report = (message: string, errors: string[] = []) => setFeedback({ message, errors });
    try {
      const validation = await post<ValidateResponse>("/api/validate?require_assignments=true", ir, signal);
      if (signal.aborted) return;
      if (!validation.valid) {
        report("Sửa dữ liệu dự án", validation.errors);
        return;
      }
      if (!solve) {
        report("Dự án hợp lệ và có thể lập lịch.");
        return;
      }

      setPhase("solving");
      const body: SolveRequest = { ir, scheduling_mode: "member", calendar };
      const { result: solved, calendar: solvedCalendar } = await post<SolveResponse>("/api/solve", body, signal);
      if (signal.aborted) return;
      if (solved.scheduling_mode !== "member") {
        report("Không thể hiển thị lịch", ["API cần trả về lịch theo thành viên. Kiểm tra phiên bản máy chủ."]);
      } else if (!hasSolution(solved.status)) {
        report(`Không thể lập lịch (${solved.status})`, solved.errors.length ? solved.errors : ["Kiểm tra dự án và thử lại."]);
      } else if (!solvedCalendar?.final_work_date || !solved.scheduled_tasks.length) {
        report("Không thể hiển thị lịch", ["API chưa trả về lịch theo ngày. Kiểm tra phiên bản máy chủ."]);
      } else {
        dispatchPlan({ type: "propose", revision: plans.revision, plan: {
          calendar: solvedCalendar, status: solved.status, scheduledTasks: solved.scheduled_tasks,
          solveTimeMs: solved.solve_time_ms, tasks: ir.tasks, members, scheduleRevision, recovery: null,
        } });
        report("Lịch ban đầu đã sẵn sàng để xem và chấp nhận.");
      }
    } catch (error) {
      if (!signal.aborted) report("Yêu cầu lập lịch chưa hoàn tất", [errorMessage(error)]);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPhase(null);
      }
    }
  }

  async function requestRecovery(solve: boolean) {
    if (activeRequest.current || !accepted || localErrors.length || !isCalendarDate(asOf) || asOf < minimumAsOf || asOf === "9999-12-31") return;
    const taskProgress: [string, ProgressSnapshot["task_progress"][string]][] = [];
    const errors: string[] = [];
    for (const task of ir.tasks) {
      const value = entries.get(task.id);
      if (task.status === "Doing" && value) {
        const duration = Number(value);
        if (!Number.isSafeInteger(duration) || duration < 1) errors.push(`Nhập số ngày còn lại là số nguyên dương cho '${task.id}'.`);
        else taskProgress.push([task.id, { remaining_duration: duration }]);
      } else if (task.status === "Done") {
        const finish = completed.get(task.id)?.actual_finish_date ?? value;
        if (finish) taskProgress.push([task.id, { actual_finish_date: finish }]);
      }
    }
    const report = (message: string, errors: string[] = []) => setProgressFeedback({ message, errors });
    if (errors.length) {
      report("Sửa thông tin tiến độ", errors);
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    setPhase(solve ? "rescheduling" : "checkingProgress");
    setProgressFeedback(null);
    if (solve && proposal) dispatchPlan({ type: "cancel" });
    const payload: RescheduleRequest = { ir, calendar, progress: { progress_as_of_date: asOf, task_progress: Object.fromEntries(taskProgress) } };
    try {
      if (!solve) {
        const validation = await post<ValidateResponse>("/api/reschedule/validate", payload, signal);
        if (!signal.aborted) report(validation.valid ? "Tiến độ hợp lệ." : "Sửa thông tin tiến độ", validation.errors);
        return;
      }
      const revised = await post<RescheduleResult>("/api/reschedule", payload, signal);
      if (signal.aborted) return;
      if (!hasSolution(revised.status)) {
        const message = revised.status === "INVALID_INPUT" ? "Sửa thông tin tiến độ"
          : revised.status === "INFEASIBLE" ? "Không có lịch khả thi với các ràng buộc hiện tại (INFEASIBLE)"
          : `Chưa tìm được lịch đề xuất (${revised.status})`;
        report(message, [...revised.errors, "Lịch đang áp dụng vẫn được giữ."]);
        return;
      }
      const { status, scheduled_tasks, solve_time_ms, errors: _errors, ...rest } = revised;
      const { progress_as_of_date, replanning_start_day, replanning_start_date, remaining_horizon_days, completed_tasks, ...finish } = rest;
      dispatchPlan({ type: "propose", revision: plans.revision, plan: {
        calendar: finish, status, scheduledTasks: scheduled_tasks, solveTimeMs: solve_time_ms,
        tasks: ir.tasks, members, scheduleRevision,
        recovery: { progress_as_of_date, replanning_start_day, replanning_start_date, remaining_horizon_days, completed_tasks },
      } });
      report("Lịch mới đã sẵn sàng để xem và chấp nhận.");
    } catch (error) {
      if (!signal.aborted) report("Yêu cầu lập lại lịch chưa hoàn tất", [errorMessage(error)]);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPhase(null);
      }
    }
  }

  function addMember(name: string) {
    let id: string;
    do {
      id = `member-${nextMemberId.current++}`;
    } while (members.some((member) => member.id === id));
    changeProject((current) => ({ ...current, members: [...(current.members ?? []), { id, name }] }));
  }

  function updateTask(index: number, patch: Partial<Task>, affectsSchedule = true) {
    const task = ir.tasks[index];
    if (completed.has(task.id)) return;
    if (patch.status && patch.status !== (task.status ?? "To Do")) {
      setEntries((current) => { const next = new Map(current); next.delete(task.id); return next; });
    }
    changeProject((current) => ({
      ...current,
      tasks: current.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task),
    }), affectsSchedule);
  }

  function saveTask(updated: Task) {
    if (editing === "new") {
      changeProject((current) => ({ ...current, tasks: [...current.tasks, updated] }));
      return;
    }
    if (editing === null) return;
    const original = ir.tasks[editing];
    if (completed.has(original.id)) return;
    const affectsSchedule = updated.id !== original.id || updated.name !== original.name ||
      updated.duration !== original.duration || taskCategory(updated) !== taskCategory(original) ||
      (updated.assignee_id ?? null) !== (original.assignee_id ?? null) ||
      JSON.stringify(updated.dependencies) !== JSON.stringify(original.dependencies);
    if (!affectsSchedule && (updated.status ?? "To Do") === (original.status ?? "To Do")) return;

    const sameStatus = (updated.status ?? "To Do") === (original.status ?? "To Do");
    if (!sameStatus || original.id !== updated.id) setEntries((current) => {
      const next = new Map(current);
      const previous = next.get(original.id);
      next.delete(original.id);
      if (previous !== undefined && sameStatus) next.set(updated.id, previous);
      return next;
    });
    changeProject((current) => {
      const renamed = original.id !== updated.id && !current.tasks.some((task, index) => index !== editing && task.id === original.id);
      const tasks = current.tasks.map((task, index) => {
        const next = index === editing ? updated : task;
        if (!renamed || !next.dependencies.includes(original.id)) return next;
        return { ...next, dependencies: next.dependencies.map((id) => id === original.id ? updated.id : id) };
      });
      return { ...current, tasks };
    }, affectsSchedule);
  }

  function removeTask(index: number) {
    const task = ir.tasks[index];
    if (completed.has(task.id)) return;
    setEntries((current) => { const next = new Map(current); next.delete(task.id); return next; });
    changeProject((current) => {
      const id = current.tasks[index].id;
      const remaining = current.tasks.filter((_, taskIndex) => taskIndex !== index);
      const tasks = remaining.some((task) => task.id === id) ? remaining : remaining.map((task) => ({
        ...task,
        dependencies: task.dependencies.filter((dependency) => dependency !== id),
      }));
      return { ...current, tasks };
    });
  }

  function openTaskEditor(selection: number | "new") {
    if (selection !== "new" && completed.has(ir.tasks[selection].id)) return;
    editVersion.current += 1;
    setEditing(selection);
  }

  function changeProgress(update: () => void) {
    editVersion.current += 1;
    invalidateProposal();
    setProject((current) => ({ ...current, dirty: true }));
    update();
  }

  return (
    <div className="flex min-h-screen flex-col text-zinc-200 lg:h-screen lg:flex-row lg:overflow-hidden"
      onChangeCapture={() => { editVersion.current += 1; }}>
      <aside className="shrink-0 border-b border-zinc-800 bg-[#0d0d10] lg:w-[320px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <header className="flex items-center gap-2.5 border-b border-zinc-800 px-5 py-4">
          <div className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-white">
            <LayoutGrid size={17} aria-hidden="true" />
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-100">ConstraintLens</div>
            <p className="text-xs text-zinc-400">Lập kế hoạch dự án</p>
          </div>
        </header>
        <div className="space-y-5 p-5">
          <div className="space-y-3">
            <label className="field">Kịch bản mẫu
              <select className="control w-full" value={selectedPreset} onChange={(event) => {
                const key = event.target.value;
                if (confirmReplace()) loadProject(presets[key], key);
              }}>
                <option value="" disabled>Chọn kịch bản mẫu</option>
                {Object.keys(presets).map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
            {presetError && (
              <div role="alert" className="notice text-rose-300">
                <p>{presetError}</p>
                <button className="button mt-2" onClick={() => {
                  setPresetError("");
                  setPresetRequest((number) => number + 1);
                }}>Tải lại kịch bản</button>
              </div>
            )}
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void parseProject(); }}>
              <label className="field">Mô tả dự án
                <textarea className="control min-h-20 w-full resize-y leading-relaxed" value={prompt} maxLength={12000}
                  aria-describedby="description-help"
                  placeholder="Ví dụ: Thiết kế giao diện trong 3 ngày, sau đó lập trình chức năng đăng nhập."
                  onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void parseProject();
                    }
                  }} />
              </label>
              <p id="description-help" className="text-xs text-zinc-400">Viết bằng tiếng Việt hoặc tiếng Anh. Nếu biết, hãy ghi số ngày và việc cần hoàn thành trước.</p>
              <button className="button w-full" disabled={!!draftPhase || !prompt.trim()}>
                {draftPhase === "generating" && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
                {draftPhase === "generating" ? "Đang tạo bản nháp…" : pendingDraft ? "Tạo lại bản nháp với Gemini" : "Tạo bản nháp với Gemini"}
              </button>
              {parseError && (
                <div className="notice">
                  <p className="text-rose-300" role="alert">{parseError}</p>
                  <button type="button" className="button mt-2" onClick={() => openTaskEditor("new")}>Thêm công việc thủ công</button>
                </div>
              )}
              {pendingDraft && <a href="#project-draft" className="block text-xs text-indigo-300 hover:underline">Xem bản nháp</a>}
            </form>
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <Members key={instance} members={members} tasks={ir.tasks} onAdd={addMember}
              onRename={(id, name) => {
                if (members.find((member) => member.id === id)?.name === name) return;
                changeProject((current) => ({
                  ...current,
                  members: current.members?.map((member) => member.id === id ? { ...member, name } : member),
                }), false);
              }}
              onRemove={(id) => {
                if (ir.tasks.some((task) => task.assignee_id === id)) return;
                changeProject((current) => ({ ...current, members: current.members?.filter((member) => member.id !== id) }));
              }} />
          </div>

          <section aria-labelledby="planning-heading" className="space-y-2.5 border-t border-zinc-800 pt-4">
            <h2 id="planning-heading" className="text-sm font-semibold">Lập lịch</h2>
            <label className="field">Ngày bắt đầu dự án
              <input type="date" required className="control w-full" value={calendar.project_start_date}
                onChange={(event) => changeCalendar({ ...calendar, project_start_date: event.target.value })} />
            </label>
            <label className="field">Hạn chót mục tiêu (tùy chọn)
              <input type="date" className="control w-full" min={calendar.project_start_date || undefined}
                value={calendar.target_deadline_date ?? ""}
                onChange={(event) => changeCalendar({ ...calendar, target_deadline_date: event.target.value || null })} />
            </label>
            <div className="grid grid-cols-[auto_1fr] gap-2">
              <button className="button" disabled={!!phase || localErrors.length > 0} onClick={() => void validateProject(false)}>Kiểm tra</button>
              {accepted ? <a href="#progress-heading" className="button justify-center" onClick={() => {
                if (progressPanel.current) progressPanel.current.open = true;
              }}>Cập nhật tiến độ</a> : (
                <button className="button primary" disabled={!!phase || localErrors.length > 0} onClick={() => void validateProject(true)}>
                  {phase ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                  Tính lịch ban đầu
                </button>
              )}
            </div>
            {(phase === "validating" || phase === "solving") && <p className="text-xs text-zinc-400" role="status">{phase === "validating" ? "Đang kiểm tra dự án…" : "CP-SAT đang tính lịch…"}</p>}
            {localErrors.length > 0 && (
              <ul className="notice list-disc space-y-1 pl-6 text-amber-200" aria-label="Điều kiện lập lịch">
                {localErrors.map((error, index) => <li key={index}>{error}</li>)}
              </ul>
            )}
            {feedback && (
              <div className={`notice ${feedback.errors.length ? "text-rose-300" : "text-emerald-300"}`}
                role={feedback.errors.length ? "alert" : "status"}>
                <p className="font-medium">{feedback.message}</p>
                {feedback.errors.length > 0 && (
                  <ul className="mt-1 list-disc space-y-1 whitespace-pre-line pl-4">
                    {feedback.errors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                )}
              </div>
            )}
            {(accepted || proposal) && (
              <a href={proposal ? "#schedule-proposal" : plans.previous ? "#schedule-comparison" : "#schedule-heading"}
                className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-indigo-300 hover:underline">
                <CalendarDays size={14} aria-hidden="true" /> {accepted && (proposal || plans.previous) ? "Xem so sánh lịch" : "Xem biểu đồ Gantt"}
              </a>
            )}
          </section>
        </div>
      </aside>

      <main className="min-w-0 flex-1 lg:overflow-y-auto">
        <header className="border-b border-zinc-800 px-4 py-4 sm:px-6">
          <h1 className="break-words text-lg font-semibold tracking-tight text-zinc-100">{ir.project_name}</h1>
          <p className="mt-1 text-xs text-zinc-400">{ir.tasks.length} công việc · {members.length} thành viên</p>
        </header>
        <div className="space-y-6 p-4 sm:p-6">
          {pendingDraft && (
            <DraftEditor draft={pendingDraft} busy={!!draftPhase} confirming={draftPhase === "confirming"} error={draftError}
              replacing={ir.tasks.length > 0} onChange={(draft) => { setPendingDraft(draft); setDraftError(""); }}
              onConfirm={() => void confirmDraft()} onCancel={() => { setPendingDraft(null); setDraftError(""); }} />
          )}
          <section aria-labelledby="tasks-heading">
            <SectionTitle id="tasks-heading" icon={ListTodo}>Công việc</SectionTitle>
            <TaskTable tasks={ir.tasks} members={members} lockedTasks={lockedTasks} onEdit={openTaskEditor} onAdd={() => openTaskEditor("new")}
              onAssign={(index, assignee_id) => updateTask(index, { assignee_id })} />
          </section>
          <section aria-labelledby="kanban-heading">
            <SectionTitle id="kanban-heading" icon={LayoutGrid}>Kanban · Tiến độ thực tế</SectionTitle>
            <Kanban key={instance} tasks={ir.tasks} members={members} lockedTasks={lockedTasks} onEdit={openTaskEditor}
              onMove={(index, status) => updateTask(index, { status }, false)} />
          </section>
          <ProgressEditor key={instance} panelRef={progressPanel} calendar={calendar} tasks={ir.tasks} asOf={asOf} entries={entries} completed={completed}
            hasAcceptedPlan={!!accepted} minimumAsOf={minimumAsOf} canRequest={!phase && !localErrors.length}
            projectNeedsCorrections={localErrors.length > 0}
            phase={progressPhase} feedback={progressFeedback} hasProposal={!!proposal?.plan.recovery}
            onDateChange={(value) => changeProgress(() => setAsOf(value))}
            onEntryChange={(id, value) => changeProgress(() => setEntries((current) => new Map(current).set(id, value)))}
            onRequest={(solve) => void requestRecovery(solve)} />
          <section aria-labelledby="schedule-heading">
            <SectionTitle id="schedule-heading" icon={CalendarDays}>Gantt · Lịch dự kiến</SectionTitle>
            <div className="space-y-4">
              {plans.stale && <p className="notice text-amber-200" role="status">Đã bỏ đề xuất vì dữ liệu thay đổi. Hãy tính lại lịch.</p>}
              {proposal && (
                <section id="schedule-proposal" className="space-y-3 rounded-lg border border-indigo-500/60 p-3" aria-labelledby="proposal-heading">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="proposal-heading" className="text-sm font-semibold text-indigo-200">{proposal.plan.recovery ? "Lịch mới đề xuất" : "Lịch ban đầu đề xuất"}</h3>
                    <div className="flex gap-2">
                      <button className="button" onClick={() => {
                        cancelScheduling();
                        dispatchPlan({ type: "cancel" });
                        setFeedback(null);
                        setProgressFeedback(null);
                      }}>Hủy đề xuất</button>
                      <button className="button primary" disabled={!!phase} onClick={() => {
                        dispatchPlan({ type: "accept" });
                        editVersion.current += 1;
                        setFeedback(null);
                        setProgressFeedback(null);
                      }}>Chấp nhận lịch</button>
                    </div>
                  </div>
                  {accepted ? <PlanComparison plans={plans} />
                    : <Schedule plan={proposal.plan} members={members} deadline={proposal.plan.calendar.target_deadline_date} />}
                </section>
              )}
              {accepted && !proposal && <PlanComparison plans={plans} />}
              {accepted ? (
                <section className="space-y-3" aria-labelledby="accepted-heading">
                  <h3 id="accepted-heading" className="text-sm font-semibold text-emerald-300">Lịch đang áp dụng</h3>
                  {outdated && <p className="notice text-amber-200" role="status">Lịch đang áp dụng đã lỗi thời. Lập lại lịch theo dữ liệu hiện tại để cập nhật.</p>}
                  <Schedule plan={accepted} members={members} deadline={accepted.calendar.project_start_date !== calendar.project_start_date
                    ? accepted.calendar.target_deadline_date : dateErrors.length ? null : calendar.target_deadline_date} />
                </section>
              ) : !proposal && (
                <div className="panel flex items-start gap-2.5 p-3 text-xs text-zinc-400" role="status">
                  <CircleHelp size={15} className="shrink-0" aria-hidden="true" />
                  Chọn ngày bắt đầu, phân công công việc rồi tính lịch ban đầu.
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
      {editedTask && (
        <TaskDialog task={editedTask} tasks={ir.tasks} members={members} onSave={saveTask}
          onRemove={typeof editing === "number" ? () => removeTask(editing) : undefined}
          onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
