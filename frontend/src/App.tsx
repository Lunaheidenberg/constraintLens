import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ArrowDown, ArrowRight, CalendarDays, ChartGantt, CircleHelp, Info, Layers3, LayoutGrid, ListTodo, LoaderCircle, Play, Plus, Settings2, UsersRound } from "lucide-react";
import { ApplicationGuide, HelpButton, type HelpApi } from "./ApplicationGuide";
import { formatDate, isCalendarDate, parseDateInput } from "./calendar";
import { DateField } from "./DateField";
import { DeadlineWarning } from "./DeadlineWarning";
import { DraftEditor } from "./DraftEditor";
import { PlanComparison } from "./PlanComparison";
import { PlanningInput, usePlanningAssistant } from "./PlanningAssistant";
import { planningApplyBlock } from "./planning";
import { assessDeadline, canAcceptProposal, hasSolution, initialPlans, planReducer } from "./plans";
import { ProgressEditor } from "./ProgressEditor";
import { collectTaskProgress, hasProgressReportEdits, matchesReportedStatuses, parseRemainingDuration, progressFromPlan } from "./progressReport";
import { hasUnscheduledStatusChanges, todoTasksDueForReview } from "./progressReview";
import { RecoveryAssistant } from "./RecoveryAssistant";
import { recoveryContext } from "./recoveryContext";
import { prepareScheduleResult } from "./schedulingFeedback";
import { Kanban, Members, TaskDialog, TaskTable, taskCategory } from "./ProjectEditor";
import { Schedule } from "./Schedule";
import type { PresetsMap, ProgressSnapshot, ProjectCalendar, RescheduleRequest, RescheduleResult, SchedulingIR, SolveRequest, SolveResponse, Task, ValidateResponse, Workspace } from "./types";

const API_BASE = "http://localhost:8000";

const EMPTY_PROJECT: SchedulingIR = {
  project_name: "Dự án mới",
  team_capacity: 1,
  kanban_config: { stages: ["Coding"], wip_limits: {} },
  members: [],
  tasks: [],
};
const EMPTY_DATES = { start: "", deadline: "" };

interface ProjectState {
  ir: SchedulingIR;
  usedTaskIds: ReadonlySet<string>;
  instance: number;
  scheduleRevision: number;
  dirty: boolean;
}

interface Feedback {
  message: string;
  errors: string[];
}

function schedulingFeedback(message: string, errors: string[], retainedProposal: boolean): Feedback {
  return { message, errors: retainedProposal && errors.length ? [...errors, "Đề xuất từ lần tính trước vẫn được giữ."] : errors };
}

function calendarErrors(calendar: ProjectCalendar, deadlineInput: string) {
  const { project_start_date: start, target_deadline_date: deadline } = calendar;
  if (!start) return ["Nhập ngày bắt đầu dự án theo định dạng DD/MM/YYYY."];
  if (deadlineInput.trim() && !deadline) return ["Nhập hạn chót theo định dạng DD/MM/YYYY hoặc để trống."];
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

const helpApi: HelpApi = {
  topics: (workspace, signal) => request(`/api/help/topics?workspace=${workspace}`, { signal }),
  ask: (workspace, question, signal) => post("/api/help/ask", { workspace, question }, signal),
};

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

function newTask(ir: SchedulingIR, usedTaskIds: ReadonlySet<string>): Task {
  let number = ir.tasks.length + 1;
  while (usedTaskIds.has(`T${number}`)) number += 1;
  const category = ir.kanban_config.stages[0] ?? "Coding";
  return { id: `T${number}`, name: "", duration: 1, dependencies: [], kanban_stage: category, category, status: "To Do", assignee_id: null };
}

const WORKSPACES = [
  { id: "setup", label: "Thiết lập", icon: Settings2 },
  { id: "planning", label: "Kế hoạch", icon: CalendarDays },
  { id: "recovery", label: "Tiến độ", icon: LayoutGrid },
] as const;

const REQUEST_STATUS = {
  validating: "Đang kiểm tra dự án…",
  validatingSchedule: "Đang kiểm tra dự án…",
  solving: "Đang tính lịch…",
  preparingSchedule: "Đang hiển thị kết quả…",
  checkingProgress: "Đang kiểm tra tiến độ…",
  rescheduling: "Đang tính lịch mới…",
  preparingRecovery: "Đang hiển thị kết quả…",
};

type SchedulePhase = keyof typeof REQUEST_STATUS;

function SectionTitle({ id, icon: Icon, children }: {
  id: string;
  icon: typeof LayoutGrid;
  children: React.ReactNode;
}) {
  return (
    <h3 id={id} tabIndex={-1} className="section-title">
      <Icon size={15} aria-hidden="true" className="section-icon" /> {children}
    </h3>
  );
}

export default function App() {
  const [project, setProject] = useState<ProjectState>({
    ir: EMPTY_PROJECT, usedTaskIds: new Set(), instance: 0, scheduleRevision: 0, dirty: false,
  });
  const { ir, usedTaskIds, instance, scheduleRevision, dirty } = project;
  const members = ir.members ?? [];
  const [presets, setPresets] = useState<PresetsMap>({});
  const [presetError, setPresetError] = useState("");
  const [presetRequest, setPresetRequest] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [hasPlanningResult, setHasPlanningResult] = useState(false);
  const [dateInputs, setDateInputs] = useState(EMPTY_DATES);
  const [asOfInput, setAsOfInput] = useState("");
  const calendar: ProjectCalendar = {
    project_start_date: parseDateInput(dateInputs.start) ?? "",
    target_deadline_date: parseDateInput(dateInputs.deadline),
  };
  const asOf = parseDateInput(asOfInput) ?? "";
  const [entries, setEntries] = useState<ReadonlyMap<string, string>>(new Map());
  const [plans, dispatchPlan] = useReducer(planReducer, initialPlans);
  const [phase, setPhase] = useState<SchedulePhase | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [progressFeedback, setProgressFeedback] = useState<Feedback | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>("setup");
  const focusTarget = useRef<string | null>(null);
  const editVersion = useRef(0);
  const applyBlocked = planningApplyBlock(ir.tasks.length, plans, !!asOfInput || entries.size > 0, !!phase || editing !== null);
  const latestApplyBlock = useRef(applyBlocked);
  useLayoutEffect(() => { latestApplyBlock.current = applyBlocked; }, [applyBlocked]);
  const assistant = usePlanningAssistant(post, () => ({
    version: editVersion.current,
    blocked: latestApplyBlock.current || (activeRequest.current
      ? "Hãy hoàn tất thao tác dự án đang chạy trước khi áp dụng bản nháp." : ""),
  }), (confirmed) => {
    const conflict = confirmed.tasks.find(({ id }) => usedTaskIds.has(id));
    if (conflict) throw new Error(`Mã ${conflict.id} đã từng được dùng trong dự án. Hãy đổi mã trong bản nháp rồi áp dụng lại.`);
    changeProject((current) => ({ ...confirmed, members: current.members }));
    setSelectedPreset("");
    setHasPlanningResult(false);
    setFeedback({ message: "Đã áp dụng bản nháp. Chọn người phụ trách cho từng công việc.", errors: [] });
    goTo("planning");
  });
  const previousAssistantStep = useRef(assistant.step);

  function goTo(view: Workspace, target = `${view}-heading`) {
    if (view === workspace) {
      focusSection(target);
    } else {
      if (workspace === "setup") assistant.cancelRequest();
      focusTarget.current = target;
      setWorkspace(view);
    }
  }

  function focusSection(id: string) {
    const target = document.getElementById(id);
    target?.focus({ preventScroll: true });
    if (WORKSPACES.some((view) => id === `${view.id}-heading`)) window.scrollTo(0, 0);
    else target?.scrollIntoView({ block: "start" });
  }

  useEffect(() => {
    if (focusTarget.current) {
      focusSection(focusTarget.current);
      focusTarget.current = null;
    }
  }, [workspace]);
  useEffect(() => {
    if (previousAssistantStep.current !== assistant.step && workspace === "setup") {
      focusSection(assistant.step === "review" ? "draft-heading"
        : assistant.step === "clarify" ? "clarification-heading" : "planning-description");
    }
    previousAssistantStep.current = assistant.step;
  }, [assistant.step, workspace]);
  const nextMemberId = useRef(1);

  const dateErrors = calendarErrors(calendar, dateInputs.deadline);
  const localErrors = [...dateErrors, ...schedulingErrors(ir)];
  const { accepted, proposal, confirmedProgress } = plans;
  const planningProgress = plans.confirmedProgress?.snapshot ?? progressFromPlan(accepted);
  const acceptedDeadline = dateErrors.length ? accepted?.calendar.target_deadline_date : calendar.target_deadline_date;
  const acceptedAssessment = accepted ? assessDeadline(accepted, acceptedDeadline) : null;
  const outdated = accepted !== null && (accepted.scheduleRevision !== scheduleRevision ||
    accepted.calendar.project_start_date !== calendar.project_start_date);
  const statusChanges = hasUnscheduledStatusChanges(accepted, ir.tasks);
  const completed = new Map((confirmedProgress?.completedTasks ?? accepted?.recovery?.completed_tasks ?? []).map((task) => [task.id, task]));
  const lockedTasks = new Set(completed.keys());
  const confirmedAsOf = planningProgress?.progress_as_of_date ?? "";
  const minimumAsOf = confirmedAsOf > calendar.project_start_date ? confirmedAsOf : calendar.project_start_date;
  const validReportingDate = !!asOf && asOf >= minimumAsOf && asOf < "9999-12-31";
  const todoReview = todoTasksDueForReview(accepted, ir.tasks, validReportingDate ? asOf : "");
  const reviewedTodoTaskIds = asOf === confirmedAsOf ? confirmedProgress?.reviewedTodoTaskIds ?? [] : [];
  const todoWasConfirmed = todoReview.length > 0 && todoReview.every(({ id }) => reviewedTodoTaskIds.includes(id));
  const todoConfirmed = todoReview.length > 0 && (plans.todoConfirmed ?? todoWasConfirmed);
  const draftProgress = collectTaskProgress(ir.tasks, entries, completed);
  const planningNeedsReport = accepted !== null && (
    !matchesReportedStatuses(ir.tasks, planningProgress) ||
    hasProgressReportEdits(asOfInput, draftProgress, planningProgress) ||
    todoConfirmed !== todoWasConfirmed
  );
  const hasCurrentProposal = proposal?.revision === plans.revision && !planningNeedsReport;
  const progressPhase = phase === "checkingProgress" || phase === "rescheduling" || phase === "preparingRecovery" ? phase : null;
  const planningPhase = progressPhase ? null : phase;
  const editedTask = editing === "new" ? newTask(ir, usedTaskIds) : editing === null ? null : ir.tasks[editing];

  useEffect(() => {
    const controller = new AbortController();
    request<PresetsMap>("/api/presets", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPresets(data); })
      .catch((error) => { if (!controller.signal.aborted) setPresetError(errorMessage(error)); });
    return () => controller.abort();
  }, [presetRequest]);

  useEffect(() => () => {
    activeRequest.current?.abort();
  }, []);

  function cancelScheduling() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPhase(null);
  }

  function invalidateProposal(todoConfirmed: boolean | null = null) {
    cancelScheduling();
    dispatchPlan({ type: "inputsChanged", todoConfirmed });
    setFeedback(null);
    setProgressFeedback(null);
  }

  function changeProject(update: (current: SchedulingIR) => SchedulingIR, affectsSchedule = true) {
    editVersion.current += 1;
    invalidateProposal();
    setProject((current) => {
      const next = update(current.ir);
      // Giữ mã đã dùng kể cả khi công việc không còn trong danh sách hiện tại.
      const newIds = next.tasks.map(({ id }) => id).filter((id) => !current.usedTaskIds.has(id));
      return {
        ...current,
        ir: next,
        usedTaskIds: newIds.length ? new Set([...current.usedTaskIds, ...newIds]) : current.usedTaskIds,
        scheduleRevision: current.scheduleRevision + Number(affectsSchedule),
        dirty: true,
      };
    });
  }

  function changeCalendar(field: keyof typeof EMPTY_DATES, value: string) {
    if (dateInputs[field] === value) return;
    changeProject((current) => current, false);
    setDateInputs((current) => ({ ...current, [field]: value }));
  }

  function loadProject(next: SchedulingIR, preset: string) {
    editVersion.current += 1;
    cancelScheduling();
    setProject((current) => ({
      ir: next,
      usedTaskIds: new Set(next.tasks.map(({ id }) => id)),
      instance: current.instance + 1,
      scheduleRevision: current.scheduleRevision + 1,
      dirty: false,
    }));
    setSelectedPreset(preset);
    setHasPlanningResult(false);
    dispatchPlan({ type: "reset" });
    setFeedback(null);
    setProgressFeedback(null);
    setEditing(null);
    setDateInputs(EMPTY_DATES);
    setAsOfInput("");
    setEntries(new Map());
  }

  function confirmReplace() {
    return !dirty || window.confirm("Thay thế dự án hiện tại và bỏ các thay đổi đang chỉnh sửa?");
  }

  async function validateProject(solve: boolean) {
    if (activeRequest.current || localErrors.length || (solve && planningNeedsReport)) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    const startedAt = performance.now();
    setPhase(solve ? "validatingSchedule" : "validating");
    setFeedback(null);
    if (solve) setProgressFeedback(null);
    const report = (message: string, errors: string[] = []) =>
      setFeedback(schedulingFeedback(message, errors, solve && hasCurrentProposal));
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
      if (planningProgress) {
        await solveFromProgress(planningProgress, "planning", startedAt, signal, report);
        return;
      }
      const body: SolveRequest = { ir, scheduling_mode: "member", calendar };
      const { result: solved, calendar: solvedCalendar } = await post<SolveResponse>("/api/solve", body, signal);
      if (signal.aborted) return;
      if (solved.scheduling_mode !== "member") {
        report("Không thể hiển thị lịch", ["API cần trả về lịch theo thành viên. Kiểm tra phiên bản máy chủ."]);
      } else if (!hasSolution(solved.status)) {
        report(`Không thể lập lịch (${solved.status})`, solved.errors.length ? solved.errors : ["Kiểm tra dự án và thử lại."]);
      } else if (!solvedCalendar?.final_work_date || !isCalendarDate(solvedCalendar.final_work_date) || !solved.scheduled_tasks.length) {
        report("Không thể hiển thị lịch", ["API chưa trả về lịch theo ngày. Kiểm tra phiên bản máy chủ."]);
      } else {
        if (!(await prepareScheduleResult(startedAt, signal, () => setPhase("preparingSchedule")))) return;
        dispatchPlan({ type: "propose", revision: plans.revision, plan: {
          calendar: solvedCalendar, status: solved.status, scheduledTasks: solved.scheduled_tasks,
          solveTimeMs: solved.solve_time_ms, tasks: ir.tasks, members, scheduleRevision, recovery: null,
        } });
        setHasPlanningResult(true);
        report("Đã tính xong lịch đề xuất.");
      }
    } catch (error) {
      if (!signal.aborted) report("Yêu cầu lập lịch chưa hoàn tất", [errorMessage(error)]);
    } finally {
      if (!signal.aborted && activeRequest.current === controller) {
        activeRequest.current = null;
        setPhase(null);
      }
    }
  }

  async function solveFromProgress(snapshot: ProgressSnapshot, source: "planning" | "progress", startedAt: number,
    signal: AbortSignal, report: (message: string, errors?: string[]) => void) {
    const revised = await post<RescheduleResult>("/api/reschedule", { ir, calendar, progress: snapshot }, signal);
    if (signal.aborted) return;
    if (!hasSolution(revised.status)) {
      const message = revised.status === "INVALID_INPUT" ? (source === "planning" ? "Kế hoạch không phù hợp với tiến độ đã xác nhận" : "Sửa thông tin tiến độ")
        : revised.status === "INFEASIBLE" ? "Không có lịch khả thi với các ràng buộc hiện tại (INFEASIBLE)"
        : `Chưa tìm được lịch đề xuất (${revised.status})`;
      report(message, [...revised.errors, "Lịch đang áp dụng vẫn được giữ."]);
      return;
    }
    if (!revised.final_work_date || !isCalendarDate(revised.final_work_date)) {
      report("Không thể hiển thị lịch", ["API chưa trả về ngày hoàn thành hợp lệ. Hãy thử lại."]);
      return;
    }
    if (revised.progress_as_of_date !== snapshot.progress_as_of_date ||
      (!revised.scheduled_tasks.length && !revised.completed_tasks.length)) {
      report("Không thể hiển thị lịch", ["Kết quả lập lịch không khớp với báo cáo đã gửi. Hãy thử lại."]);
      return;
    }
    const preparing = source === "planning" ? "preparingSchedule" : "preparingRecovery";
    if (!(await prepareScheduleResult(startedAt, signal, () => setPhase(preparing)))) return;
    const { status, scheduled_tasks, solve_time_ms, errors: _errors, ...rest } = revised;
    const { progress_as_of_date, replanning_start_day, replanning_start_date, remaining_horizon_days, completed_tasks, ...finish } = rest;
    const confirmation = source === "progress" ? {
      snapshot, completedTasks: completed_tasks, reviewedTodoTaskIds: todoReview.map(({ id }) => id),
    } : undefined;
    dispatchPlan({ type: "propose", revision: plans.revision, confirmation, plan: {
      calendar: finish, status, scheduledTasks: scheduled_tasks, solveTimeMs: solve_time_ms,
      tasks: ir.tasks, members, scheduleRevision,
      recovery: { progress_as_of_date, replanning_start_day, replanning_start_date, remaining_horizon_days, completed_tasks },
    } });
    if (source === "planning") setHasPlanningResult(true);
    report("Đã tính xong lịch đề xuất.");
  }

  async function requestRecovery(solve: boolean) {
    if (activeRequest.current || !accepted || localErrors.length || !validReportingDate) return;
    if (solve && todoReview.length > 0 && !todoConfirmed) return;
    const { taskProgress, errors } = draftProgress;
    const report = (message: string, errors: string[] = []) =>
      setProgressFeedback(schedulingFeedback(message, errors, solve && hasCurrentProposal));
    if (errors.length) {
      report("Sửa thông tin tiến độ", errors);
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    const startedAt = performance.now();
    setPhase(solve ? "rescheduling" : "checkingProgress");
    setProgressFeedback(null);
    if (solve) setFeedback(null);
    const payload: RescheduleRequest = { ir, calendar, progress: { progress_as_of_date: asOf, task_progress: taskProgress } };
    try {
      if (!solve) {
        const validation = await post<ValidateResponse>("/api/reschedule/validate", payload, signal);
        if (!signal.aborted) report(validation.valid ? "Tiến độ hợp lệ." : "Sửa thông tin tiến độ", validation.errors);
        return;
      }
      await solveFromProgress(payload.progress, "progress", startedAt, signal, report);
    } catch (error) {
      if (!signal.aborted) report("Yêu cầu lập lại lịch chưa hoàn tất", [errorMessage(error)]);
    } finally {
      if (!signal.aborted && activeRequest.current === controller) {
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

  function protectTaskIdentity(task: Task) {
    return (task.status ?? "To Do") !== "To Do" ||
      Object.prototype.hasOwnProperty.call(planningProgress?.task_progress ?? {}, task.id);
  }

  function saveTask(updated: Task) {
    if (editing === null) return;
    const original = editing === "new" ? null : ir.tasks[editing];
    if (updated.id !== original?.id && usedTaskIds.has(updated.id)) {
      return `Mã ${updated.id} đã từng được dùng trong dự án. Hãy chọn mã khác.`;
    }
    if (editing === "new") {
      changeProject((current) => ({ ...current, tasks: [...current.tasks, updated] }));
      return;
    }
    if (!original || completed.has(original.id) || (updated.id !== original.id && protectTaskIdentity(original))) return;
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
    if (completed.has(task.id) || protectTaskIdentity(task)) return;
    setEditing(null);
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
    if (selection === "new") assistant.cancelRequest();
    editVersion.current += 1;
    setEditing(selection);
  }

  function revisePlan() {
    goTo("planning", "tasks-heading");
    const firstEditable = ir.tasks.findIndex((task) => !lockedTasks.has(task.id));
    if (firstEditable !== -1) openTaskEditor(firstEditable);
  }

  function changeProgress(update: () => void, todoConfirmed: boolean | null = null) {
    editVersion.current += 1;
    invalidateProposal(todoConfirmed);
    setProject((current) => ({ ...current, dirty: true }));
    update();
  }

  function changeProgressDate(value: string) {
    if (value.trim() === asOfInput.trim()) setAsOfInput(value);
    else changeProgress(() => setAsOfInput(value));
  }

  function changeProgressEntry(id: string, value: string) {
    const previous = entries.get(id) ?? "";
    if (previous === value) return;
    const parseEntry = ir.tasks.find((task) => task.id === id)?.status === "Doing" ? parseRemainingDuration : parseDateInput;
    const update = () => setEntries((current) => new Map(current).set(id, value));
    if ((parseEntry(previous) ?? previous.trim()) === (parseEntry(value) ?? value.trim())) update();
    else changeProgress(update, plans.todoConfirmed);
  }

  function renderProposal() {
    if (!proposal) return null;
    const fromProgress = proposal.source === "progress";
    const assessment = assessDeadline(proposal.plan);
    const late = !!assessment?.daysLate;
    const deadlineAllowsAcceptance = canAcceptProposal(plans);
    const canAccept = !planningNeedsReport && deadlineAllowsAcceptance;
    const recalculating = phase && phase !== "validating" && phase !== "checkingProgress";
    const context = recoveryContext(plans, instance);
    const explain = context ? (
      workspace === (fromProgress ? "recovery" : "planning") &&
      <RecoveryAssistant key={context.key} context={context} baseUrl={API_BASE} />
    ) : <p className="helper">Cần có dữ liệu lịch đầy đủ để giải thích đề xuất. Hãy tính lại lịch.</p>;
    return (
      <section id="schedule-proposal" tabIndex={-1} className="panel proposal grid-cols-[minmax(0,1fr)] result-enter" aria-labelledby="proposal-heading">
        <div className="section-bar">
          <div>
            <span className={`badge ${canAccept ? "badge-accent" : "badge-warning"}`}>{canAccept ? "Chờ chấp nhận" : "Chưa thể chấp nhận"}</span>
            <h4 id="proposal-heading" className="mt-2 text-base font-semibold">{accepted ? "Lịch mới đề xuất" : "Lịch ban đầu đề xuất"}</h4>
            {accepted && <p className="helper mt-1">Lịch đang áp dụng được giữ đến khi bạn chấp nhận lịch mới.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="button" onClick={() => {
              cancelScheduling();
              dispatchPlan({ type: "cancel" });
              setFeedback(null);
              setProgressFeedback(null);
              focusSection(fromProgress ? "progress-heading" : "schedule-heading");
            }}>Hủy đề xuất</button>
            <button className="button primary" disabled={!!phase || !canAccept} onClick={() => {
              if (activeRequest.current || !canAccept) return;
              dispatchPlan({ type: "accept" });
              editVersion.current += 1;
              const message = { message: "Đã chấp nhận lịch.", errors: [] };
              setFeedback(fromProgress ? null : message);
              setProgressFeedback(fromProgress ? message : null);
              focusSection(fromProgress ? "recovery-comparison-heading" : "schedule-heading");
            }}>Chấp nhận lịch</button>
          </div>
        </div>
        {recalculating && <p className="notice notice-info" role="status">Đang tính lại. Bạn đang xem đề xuất từ lần tính trước.</p>}
        {late && assessment && <DeadlineWarning assessment={assessment} onRevise={revisePlan} />}
        {!late && !deadlineAllowsAcceptance && <p className="notice warning" role="status">Chưa xác định được lịch có đáp ứng hạn chót. Hãy lập lịch lại.</p>}
        {accepted ? <PlanComparison plans={plans} proposalExplanation={explain} /> : <>
          {explain}
          <Schedule plan={proposal.plan} members={members} deadline={proposal.plan.calendar.target_deadline_date} />
        </>}
      </section>
    );
  }

  const unassigned = ir.tasks.filter((task) => task.assignee_id == null).length;
  const currentFeedback = workspace === "planning" ? feedback : workspace === "recovery" ? progressFeedback : null;
  const announcement = workspace === "setup" && assistant.pendingMessage ? assistant.pendingMessage
    : phase ? REQUEST_STATUS[phase] : currentFeedback && !currentFeedback.errors.length ? currentFeedback.message : "";
  const progressNotice = statusChanges && (
    <div className="notice notice-info">
      <Info size={16} aria-hidden="true" />
      <p role="status">Tiến độ đã thay đổi. Lịch hiện tại chưa phản ánh những cập nhật mới nhất.</p>
      <button type="button" className="text-link" onClick={() => goTo("recovery", "progress-heading")}>
        Đến báo cáo tiến độ <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
  const projectView = (
    <div className="app-shell" onChangeCapture={(event) => {
      if (!(event.target instanceof Element && event.target.closest("[data-recovery-assistant]"))) editVersion.current += 1;
    }}>
      <a className="skip-link" href="#project-heading">Đến nội dung dự án</a>
      <p role="status" className="sr-only">{announcement}</p>
      <aside className="app-rail">
        <div className="brand">
          <span className="brand-mark"><Layers3 size={18} aria-hidden="true" /></span>
          <span className="font-semibold">ConstraintLens</span>
        </div>
        <nav aria-label="Không gian dự án" className="workspace-nav">
          {WORKSPACES.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-current={workspace === id ? "page" : undefined}
              aria-controls={`workspace-${id}`} className="workspace-link" onClick={() => goTo(id)}>
              <Icon size={17} aria-hidden="true" />
              {label}
              {(id === "setup" && assistant.draft || id === "planning" && proposal && !proposal.plan.recovery ||
                id === "recovery" && proposal?.plan.recovery) &&
                <span className="nav-indicator"><span className="sr-only">Có bản xem trước</span></span>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0">
        <header className="project-bar">
          <div className="project-bar-inner">
            <h1 id="project-heading" tabIndex={-1} className="min-w-0 break-words text-sm font-semibold">{ir.project_name}</h1>
            <div className="project-bar-actions">
              <div className="project-counts">
                <span><ListTodo size={14} aria-hidden="true" /> {ir.tasks.length} công việc</span>
                <span><UsersRound size={14} aria-hidden="true" /> {members.length} thành viên</span>
              </div>
              <HelpButton />
            </div>
          </div>
        </header>

        <div className="workspace">
          <section id="workspace-setup" aria-labelledby="setup-heading" hidden={workspace !== "setup"} className="workspace-view setup-view">
            <div className="page-heading">
              <div>
                <h2 id="setup-heading" tabIndex={-1}>Thiết lập dự án</h2>
                <p>Chọn điểm bắt đầu, thiết lập ngày và thêm người phụ trách.</p>
              </div>
              <button className="button primary" onClick={() => goTo("planning")}>Đến kế hoạch <ArrowRight size={15} aria-hidden="true" /></button>
            </div>
            <div className="setup-grid">
              <section className="setup-source" aria-labelledby="source-heading">
                <div className="section-bar">
                  <SectionTitle id="source-heading" icon={ListTodo}>Khởi tạo công việc</SectionTitle>
                  <button className="button" aria-label="Thêm công việc thủ công" onClick={() => openTaskEditor("new")}>
                    <Plus size={15} aria-hidden="true" /> Thêm thủ công
                  </button>
                </div>
                <label className="field">Kịch bản mẫu
                  <select className="control w-full" value={selectedPreset} onChange={(event) => {
                    const key = event.target.value;
                    if (confirmReplace()) {
                      assistant.cancelRequest();
                      loadProject(presets[key], key);
                    }
                  }}>
                    <option value="" disabled>Chọn kịch bản mẫu</option>
                    {Object.keys(presets).map((name) => <option key={name}>{name}</option>)}
                  </select>
                </label>
                {presetError && (
                  <div role="alert" className="notice error">
                    <p>{presetError}</p>
                    <button className="button mt-2" onClick={() => {
                      setPresetError("");
                      setPresetRequest((number) => number + 1);
                    }}>Tải lại kịch bản</button>
                  </div>
                )}
                {assistant.step !== "review" && <PlanningInput assistant={assistant} />}
              </section>
              <div className="setup-details">
                <section aria-labelledby="calendar-heading">
                  <SectionTitle id="calendar-heading" icon={CalendarDays}>Lịch dự án</SectionTitle>
                  <div className="setup-calendar-fields">
                    <DateField label="Ngày bắt đầu dự án" value={dateInputs.start} required
                      onChange={(value) => changeCalendar("start", value)} />
                    <DateField label="Hạn chót (tùy chọn)" value={dateInputs.deadline} min={calendar.project_start_date || undefined}
                      onChange={(value) => changeCalendar("deadline", value)} />
                  </div>
                  <p className="helper mt-2">Lịch tính theo ngày dương lịch, kể cả cuối tuần.</p>
                </section>
                <div className="section-rule">
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
              </div>
            </div>
            {assistant.step === "review" && assistant.draft && (
              <DraftEditor result={assistant.draft} confirming={assistant.phase === "confirming"} error={assistant.error}
                blocked={applyBlocked} onChange={assistant.changeDraft} onConfirm={() => void assistant.confirm()}
                onClose={assistant.describe} onBack={assistant.revisitQuestions} onStop={assistant.cancelRequest} />
            )}
          </section>

          <section id="workspace-planning" aria-labelledby="planning-heading" hidden={workspace !== "planning"} className="workspace-view">
            <div className="page-heading">
              <div>
                <h2 id="planning-heading" tabIndex={-1}>Kế hoạch</h2>
                <p>Phân công công việc và xem lịch dự kiến của nhóm.</p>
              </div>
              <button className="button" onClick={() => openTaskEditor("new")}><Plus size={16} aria-hidden="true" /> Thêm công việc</button>
            </div>
            <section className="panel section-pad space-y-3" aria-labelledby="solve-heading">
              <div className="section-bar">
                <div>
                  <SectionTitle id="solve-heading" icon={ChartGantt}>Lập lịch</SectionTitle>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <p className="helper">Bắt đầu: {calendar.project_start_date ? formatDate(calendar.project_start_date) : "Chưa chọn"} · Hạn: {calendar.target_deadline_date ? formatDate(calendar.target_deadline_date) : "Chưa đặt"}</p>
                    <button className="text-link" onClick={() => goTo("setup", "calendar-heading")}>Chỉnh ngày</button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="button" disabled={!!phase || localErrors.length > 0}
                    aria-describedby={localErrors.length ? "solve-requirements" : undefined} onClick={() => void validateProject(false)}>Kiểm tra</button>
                  <button className="button primary schedule-action" disabled={!!phase || localErrors.length > 0 || planningNeedsReport}
                    aria-describedby={planningNeedsReport ? "planning-progress-required" : localErrors.length ? "solve-requirements" : undefined}
                    onClick={() => void validateProject(true)}>
                    {planningPhase && planningPhase !== "validating" ? <LoaderCircle size={15} className="busy-icon" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                    {planningPhase && planningPhase !== "validating" ? REQUEST_STATUS[planningPhase]
                      : accepted || hasPlanningResult ? "Lập lịch lại" : "Tính lịch ban đầu"}
                  </button>
                </div>
              </div>
              {planningPhase === "validating" && <p className="helper">{REQUEST_STATUS.validating}</p>}
              {confirmedAsOf && <p className="helper">Báo cáo dùng để lập lại lịch: đã xác nhận đến hết <time dateTime={confirmedAsOf}>{formatDate(confirmedAsOf)}</time>.</p>}
              {planningNeedsReport && <div id="planning-progress-required" className="notice warning">
                <p role="status">Báo cáo tiến độ có thay đổi chưa được áp dụng.</p>
                <button className="text-link underline" onClick={() => goTo("recovery", "progress-heading")}>
                  Đến báo cáo tiến độ
                </button>
              </div>}
              {localErrors.length > 0 && (
                <div id="solve-requirements" className="notice warning">
                  <p className="font-semibold">Cần hoàn tất trước khi lập lịch</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4" aria-label="Điều kiện lập lịch">
                    {localErrors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                </div>
              )}
              {feedback && (
                <div className={`notice ${feedback.errors.length ? "error" : "success"}`}
                  role={feedback.errors.length ? "alert" : undefined}>
                  <p className="font-medium">{feedback.message}</p>
                  {feedback.errors.length > 0 && (
                    <ul className="mt-1 list-disc space-y-1 whitespace-pre-line pl-4">
                      {feedback.errors.map((error, index) => <li key={index}>{error}</li>)}
                    </ul>
                  )}
                  {(accepted || proposal) && !feedback.errors.length && (
                    <a href={proposal?.source === "planning" ? "#schedule-proposal" : "#schedule-heading"} className="text-link mt-1 inline-flex items-center gap-1">
                      Xem lịch <ArrowDown size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </section>
            <section aria-labelledby="tasks-heading" className="space-y-2">
              <div className="section-bar">
                <SectionTitle id="tasks-heading" icon={ListTodo}>Công việc</SectionTitle>
                {unassigned > 0 && <span className="badge badge-warning">{unassigned} chưa phân công</span>}
              </div>
              <TaskTable tasks={ir.tasks} members={members} lockedTasks={lockedTasks} onEdit={openTaskEditor} onAdd={() => openTaskEditor("new")}
                onAssign={(index, assignee_id) => updateTask(index, { assignee_id })} />
            </section>
            <section aria-labelledby="schedule-heading" className="space-y-3">
              <SectionTitle id="schedule-heading" icon={ChartGantt}>Gantt · Lịch dự kiến</SectionTitle>
              {plans.stale && <p className="notice warning" role="status">Đã bỏ đề xuất vì dữ liệu thay đổi. Hãy lập lịch lại.</p>}
              {proposal?.source === "planning" && renderProposal()}
              {accepted ? (
                <section className="panel section-pad space-y-3" aria-labelledby="accepted-heading">
                  <div className="section-bar">
                    <h4 id="accepted-heading" className="text-sm font-semibold">Lịch đang áp dụng</h4>
                    <span className={`badge ${outdated || acceptedAssessment?.daysLate ? "badge-warning" : "badge-success"}`}>{outdated ? "Cần cập nhật" : "Đã chấp nhận"}</span>
                  </div>
                  {!!acceptedAssessment?.daysLate && <DeadlineWarning assessment={acceptedAssessment} accepted onRevise={revisePlan} />}
                  {outdated && <p className="notice warning">Dữ liệu dự án đã thay đổi. Chọn Lập lịch lại để xem lịch cập nhật.</p>}
                  {progressNotice}
                  <Schedule plan={accepted} members={members} deadline={acceptedDeadline ?? null} />
                </section>
              ) : !proposal && (
                <div className="empty-state" role="status">
                  <CircleHelp size={18} aria-hidden="true" />
                  <div><p className="font-medium text-zinc-100">Chưa có lịch dự kiến</p><p>Chọn ngày bắt đầu, phân công công việc rồi tính lịch ban đầu.</p></div>
                </div>
              )}
            </section>
          </section>

          <section id="workspace-recovery" aria-labelledby="recovery-heading" hidden={workspace !== "recovery"} className="workspace-view">
            <div className="page-heading">
              <div>
                <h2 id="recovery-heading" tabIndex={-1}>Tiến độ và lập lại lịch</h2>
                <p>Cập nhật công việc thực tế và xem tác động đến lịch dự án.</p>
              </div>
              {accepted && <a className="button" href="#progress-heading">Báo cáo tiến độ <ArrowDown size={15} aria-hidden="true" /></a>}
            </div>
            <section aria-labelledby="kanban-heading" className="space-y-3">
              <div className="section-bar">
                <SectionTitle id="kanban-heading" icon={LayoutGrid}>Bảng Kanban</SectionTitle>
                <p className="helper">Kéo thẻ hoặc chọn Di chuyển để cập nhật trạng thái.</p>
              </div>
              {progressNotice}
              <Kanban key={instance} tasks={ir.tasks} members={members} lockedTasks={lockedTasks} onEdit={openTaskEditor}
                onMove={(index, status) => updateTask(index, { status }, false)} />
            </section>
            <ProgressEditor key={instance} calendar={calendar} tasks={ir.tasks} asOf={asOf} asOfInput={asOfInput} entries={entries} completed={completed}
              acceptedPlan={accepted} minimumAsOf={minimumAsOf} canRequest={!phase && !localErrors.length && validReportingDate}
              projectNeedsCorrections={localErrors.length > 0} onOpenPlanning={() => goTo("planning", "solve-heading")}
              phase={progressPhase} pendingMessage={progressPhase ? REQUEST_STATUS[progressPhase] : ""}
              feedback={progressFeedback} hasProposal={proposal?.source === "progress"}
              hasPendingEdits={planningNeedsReport} confirmedAsOf={confirmedAsOf}
              todoReview={todoReview} todoConfirmed={todoConfirmed} onOpenKanban={() => goTo("recovery", "kanban-heading")}
              onConfirmTodo={invalidateProposal}
              onDateChange={changeProgressDate}
              onEntryChange={changeProgressEntry}
              onRequest={(solve) => void requestRecovery(solve)} />
            <section aria-labelledby="recovery-comparison-heading" className="space-y-3">
              <div className="section-bar">
                <SectionTitle id="recovery-comparison-heading" icon={ChartGantt}>So sánh kế hoạch</SectionTitle>
                {accepted && <button className="text-link" onClick={() => goTo("planning", "schedule-heading")}>Xem lịch đang áp dụng</button>}
              </div>
              {plans.stale && accepted && <p className="notice warning" role="status">Đã bỏ đề xuất vì dữ liệu thay đổi. Hãy tính lại lịch.</p>}
              {proposal?.source === "progress" ? renderProposal() : <PlanComparison plans={{ ...plans, proposal: null }} />}
            </section>
          </section>
        </div>
      </main>
      {editedTask && (
        <TaskDialog task={editedTask} tasks={ir.tasks} members={members} onSave={saveTask} planningOnly={workspace !== "recovery"}
          lockId={typeof editing === "number" && protectTaskIdentity(editedTask)}
          onRemove={typeof editing === "number" && !protectTaskIdentity(editedTask) ? () => removeTask(editing) : undefined}
          onClose={() => setEditing(null)} />
      )}
    </div>
  );
  // Help fields are siblings of the project edit-capture boundary, even when launched from a task dialog.
  return <ApplicationGuide workspace={workspace} api={helpApi}>{projectView}</ApplicationGuide>;
}
