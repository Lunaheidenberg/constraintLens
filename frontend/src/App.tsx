import { useEffect, useRef, useState } from "react";
import { CalendarDays, CircleHelp, LayoutGrid, ListTodo, LoaderCircle, Play } from "lucide-react";
import { Kanban, Members, TaskDialog, TaskTable, taskCategory } from "./ProjectEditor";
import { Schedule } from "./Schedule";
import type { PresetsMap, ScheduleResult, SchedulingIR, SolveRequest, SolveResponse, Task, ValidateResponse } from "./types";

const API_BASE = "http://localhost:8000";

const EMPTY_PROJECT: SchedulingIR = {
  project_name: "Dự án mới",
  team_capacity: 1,
  kanban_config: { stages: ["Coding"], wip_limits: {} },
  members: [],
  tasks: [],
};

interface ProjectState {
  ir: SchedulingIR;
  instance: number;
  scheduleRevision: number;
  dirty: boolean;
}

interface Feedback {
  revision: number;
  message: string;
  errors: string[];
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
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [pendingDraft, setPendingDraft] = useState<SchedulingIR | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [phase, setPhase] = useState<"validating" | "solving" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [schedule, setSchedule] = useState<{ revision: number; result: ScheduleResult } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const editVersion = useRef(0);
  const nextMemberId = useRef(1);

  const localErrors = schedulingErrors(ir);
  const result = schedule?.revision === scheduleRevision ? schedule.result : null;
  const outdated = schedule !== null && result === null;
  const currentFeedback = feedback?.revision === scheduleRevision ? feedback : null;
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

  function changeProject(update: (current: SchedulingIR) => SchedulingIR, affectsSchedule = true) {
    editVersion.current += 1;
    if (affectsSchedule) cancelScheduling();
    setProject((current) => ({
      ...current,
      ir: update(current.ir),
      scheduleRevision: current.scheduleRevision + Number(affectsSchedule),
      dirty: true,
    }));
  }

  function loadProject(draft: SchedulingIR, preset = "") {
    editVersion.current += 1;
    cancelScheduling();
    setProject((current) => ({
      ir: draft,
      instance: current.instance + 1,
      scheduleRevision: current.scheduleRevision + 1,
      dirty: false,
    }));
    setSelectedPreset(preset);
    setSchedule(null);
    setFeedback(null);
    setEditing(null);
    setDeadline(null);
    setPendingDraft(null);
    setParseError("");
  }

  function confirmReplace() {
    return !dirty || window.confirm("Thay thế dự án hiện tại và bỏ các thay đổi đang chỉnh sửa?");
  }

  async function parseProject() {
    if (isParsing || !prompt.trim() || !confirmReplace()) return;
    const version = editVersion.current;
    setIsParsing(true);
    setParseError("");
    setPendingDraft(null);
    try {
      const draft = await post<SchedulingIR>("/api/parse", { prompt: prompt.trim() });
      if (editVersion.current === version) loadProject(draft);
      else setPendingDraft(draft);
    } catch (error) {
      setParseError(errorMessage(error));
    } finally {
      setIsParsing(false);
    }
  }

  async function validateProject(solve: boolean) {
    if (activeRequest.current || localErrors.length) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    setPhase("validating");
    setFeedback(null);
    const report = (message: string, errors: string[] = []) => setFeedback({ revision: scheduleRevision, message, errors });
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
      const body: SolveRequest = { ir, scheduling_mode: "member" };
      const { result: solved } = await post<SolveResponse>("/api/solve", body, signal);
      if (signal.aborted) return;
      if (solved.scheduling_mode !== "member") {
        report("Không thể hiển thị lịch", ["API cần trả về lịch theo thành viên. Kiểm tra phiên bản máy chủ."]);
      } else if (!["OPTIMAL", "FEASIBLE"].includes(solved.status) || !solved.scheduled_tasks.length) {
        report(`Không thể lập lịch (${solved.status})`, solved.errors.length ? solved.errors : ["Kiểm tra dự án và thử lại."]);
      } else {
        setSchedule({ revision: scheduleRevision, result: solved });
        report("Đã lập lịch theo thành viên.");
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

  function addMember(name: string) {
    let id: string;
    do {
      id = `member-${nextMemberId.current++}`;
    } while (members.some((member) => member.id === id));
    changeProject((current) => ({ ...current, members: [...(current.members ?? []), { id, name }] }));
  }

  function updateTask(index: number, patch: Partial<Task>, affectsSchedule = true) {
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
    const affectsSchedule = updated.id !== original.id || updated.name !== original.name ||
      updated.duration !== original.duration || taskCategory(updated) !== taskCategory(original) ||
      (updated.assignee_id ?? null) !== (original.assignee_id ?? null) ||
      JSON.stringify(updated.dependencies) !== JSON.stringify(original.dependencies);
    if (!affectsSchedule && (updated.status ?? "To Do") === (original.status ?? "To Do")) return;

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
    editVersion.current += 1;
    setEditing(selection);
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
                <textarea className="control min-h-20 w-full resize-y leading-relaxed" value={prompt}
                  placeholder="Ví dụ: Thiết kế giao diện trong 3 ngày, sau đó lập trình chức năng đăng nhập."
                  onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void parseProject();
                    }
                  }} />
              </label>
              <button className="button w-full" disabled={isParsing || !prompt.trim()}>
                {isParsing && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
                {isParsing ? "Đang tạo bản nháp…" : "Tạo bản nháp với Gemini"}
              </button>
              {parseError && <p className="notice text-rose-300" role="alert">{parseError}</p>}
              {pendingDraft && (
                <div className="notice">
                  <p>Bản nháp đã sẵn sàng. Dự án hiện tại đã thay đổi trong lúc Gemini xử lý.</p>
                  <button type="button" className="button mt-2"
                    onClick={() => { if (confirmReplace()) loadProject(pendingDraft); }}>Nạp bản nháp</button>
                </div>
              )}
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
            <label className="field">Hạn chót mục tiêu (ngày)
              <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" className="control w-full"
                placeholder="Tùy chọn" onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  setDeadline(Number.isSafeInteger(value) && value > 0 ? value : null);
                }} key={instance} />
            </label>
            <div className="grid grid-cols-[auto_1fr] gap-2">
              <button className="button" disabled={!!phase || localErrors.length > 0} onClick={() => void validateProject(false)}>Kiểm tra</button>
              <button className="button primary" disabled={!!phase || localErrors.length > 0} onClick={() => void validateProject(true)}>
                {phase ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                Tính lịch
              </button>
            </div>
            {phase && <p className="text-xs text-zinc-400" role="status">{phase === "validating" ? "Đang kiểm tra dự án…" : "CP-SAT đang tính lịch…"}</p>}
            {localErrors.length > 0 && (
              <ul className="notice list-disc space-y-1 pl-6 text-amber-200" aria-label="Điều kiện lập lịch">
                {localErrors.map((error, index) => <li key={index}>{error}</li>)}
              </ul>
            )}
            {currentFeedback && (
              <div className={`notice ${currentFeedback.errors.length ? "text-rose-300" : "text-emerald-300"}`}
                role={currentFeedback.errors.length ? "alert" : "status"}>
                <p className="font-medium">{currentFeedback.message}</p>
                {currentFeedback.errors.length > 0 && (
                  <ul className="mt-1 list-disc space-y-1 whitespace-pre-line pl-4">
                    {currentFeedback.errors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                )}
              </div>
            )}
            {result && (
              <a href="#schedule-heading" className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-indigo-300 hover:underline">
                <CalendarDays size={14} aria-hidden="true" /> Xem biểu đồ Gantt
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
          <section aria-labelledby="tasks-heading">
            <SectionTitle id="tasks-heading" icon={ListTodo}>Công việc</SectionTitle>
            <TaskTable tasks={ir.tasks} members={members} onEdit={openTaskEditor} onAdd={() => openTaskEditor("new")}
              onAssign={(index, assignee_id) => updateTask(index, { assignee_id })} />
          </section>
          <section aria-labelledby="kanban-heading">
            <SectionTitle id="kanban-heading" icon={LayoutGrid}>Kanban · Tiến độ thực tế</SectionTitle>
            <Kanban key={instance} tasks={ir.tasks} members={members} onEdit={openTaskEditor}
              onMove={(index, status) => updateTask(index, { status }, false)} />
          </section>
          <section aria-labelledby="schedule-heading">
            <SectionTitle id="schedule-heading" icon={CalendarDays}>Gantt · Lịch dự kiến</SectionTitle>
            {result ? <Schedule result={result} tasks={ir.tasks} members={members} deadline={deadline} /> : (
              <div className={`panel flex items-start gap-2.5 p-3 text-xs ${outdated ? "text-amber-200" : "text-zinc-400"}`} role="status">
                <CircleHelp size={15} className="shrink-0" aria-hidden="true" />
                {outdated ? "Lịch cũ đã lỗi thời. Chọn Tính lịch để cập nhật theo dữ liệu hiện tại." : "Phân công công việc rồi chọn Tính lịch để xem lịch dự kiến."}
              </div>
            )}
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
