import { initialPlans, type ConfirmedProgress, type Plan, type PlanState } from "./plans.ts";
import type { KanbanStatus, ProjectMember, SchedulingIR, Task } from "./types.ts";

export const STORAGE_KEY = "constraintlens.workspace.v1";
export const QUICKSTART_STORAGE_KEY = "constraintlens.quickstart.collapsed";

export interface StoredWorkspace {
  version: 1;
  ir: SchedulingIR;
  usedTaskIds: string[];
  dateInputs: { start: string; deadline: string };
  asOfInput: string;
  entries: [string, string][];
  plans: PlanState;
}

const VALID_STATUSES = new Set<KanbanStatus>(["To Do", "Doing", "Done"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sanitizeTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.name !== "string") return null;
  if (typeof value.duration !== "number" || !Number.isSafeInteger(value.duration) || value.duration < 1) return null;
  if (!isStringArray(value.dependencies)) return null;
  if (typeof value.kanban_stage !== "string") return null;
  if (value.category !== undefined && typeof value.category !== "string") return null;
  if (value.status !== undefined && (typeof value.status !== "string" || !VALID_STATUSES.has(value.status as KanbanStatus))) {
    return null;
  }
  if (value.assignee_id !== undefined && value.assignee_id !== null && typeof value.assignee_id !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    duration: value.duration,
    dependencies: [...value.dependencies],
    kanban_stage: value.kanban_stage,
    category: value.category,
    status: value.status as KanbanStatus | undefined,
    assignee_id: value.assignee_id ?? null,
  };
}

function sanitizeMember(value: unknown): ProjectMember | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

function sanitizeIR(value: unknown): SchedulingIR | null {
  if (!isRecord(value)) return null;
  if (typeof value.project_name !== "string" || !value.project_name.trim()) return null;
  if (typeof value.team_capacity !== "number" || !Number.isSafeInteger(value.team_capacity) || value.team_capacity < 1) {
    return null;
  }
  if (!isRecord(value.kanban_config) || !isStringArray(value.kanban_config.stages) || !isRecord(value.kanban_config.wip_limits)) {
    return null;
  }
  const wipLimits: Record<string, number> = {};
  for (const [key, limit] of Object.entries(value.kanban_config.wip_limits)) {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return null;
    wipLimits[key] = limit;
  }
  if (!Array.isArray(value.tasks)) return null;
  const tasks: Task[] = [];
  for (const item of value.tasks) {
    const task = sanitizeTask(item);
    if (!task) return null;
    tasks.push(task);
  }
  let members: ProjectMember[] = [];
  if (value.members !== undefined) {
    if (!Array.isArray(value.members)) return null;
    for (const item of value.members) {
      const member = sanitizeMember(item);
      if (!member) return null;
      members.push(member);
    }
  }
  return {
    project_name: value.project_name,
    team_capacity: value.team_capacity,
    kanban_config: { stages: [...value.kanban_config.stages], wip_limits: wipLimits },
    tasks,
    members,
  };
}

function sanitizePlan(value: unknown): Plan | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== "string" || !isRecord(value.calendar)) return null;
  if (typeof value.calendar.project_start_date !== "string") return null;
  if (!Array.isArray(value.scheduledTasks) || !Array.isArray(value.tasks) || !Array.isArray(value.members)) return null;
  if (typeof value.solveTimeMs !== "number" || typeof value.scheduleRevision !== "number") return null;
  return value as unknown as Plan;
}

function sanitizePlans(value: unknown): PlanState {
  if (!isRecord(value)) return initialPlans;
  const revision = typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision : 0;
  const baseline = sanitizePlan(value.baseline);
  const previous = sanitizePlan(value.previous);
  const accepted = sanitizePlan(value.accepted);
  const acceptedRevision = typeof value.acceptedRevision === "number" && Number.isSafeInteger(value.acceptedRevision)
    ? value.acceptedRevision : null;
  const todoConfirmed = typeof value.todoConfirmed === "boolean" ? value.todoConfirmed : null;
  const confirmedProgress = isRecord(value.confirmedProgress) && isRecord(value.confirmedProgress.snapshot)
    && Array.isArray(value.confirmedProgress.completedTasks) && isStringArray(value.confirmedProgress.reviewedTodoTaskIds)
    ? (value.confirmedProgress as unknown as ConfirmedProgress)
    : null;
  // Không khôi phục proposal chưa được chấp nhận qua phiên tải lại trang.
  return {
    revision,
    baseline,
    previous,
    accepted,
    acceptedRevision,
    todoConfirmed,
    confirmedProgress,
    proposal: null,
    stale: false,
  };
}

export function serializeWorkspace(data: StoredWorkspace): string {
  const safePlans: PlanState = { ...data.plans, proposal: null, stale: false };
  const payload: StoredWorkspace = {
    version: 1,
    ir: data.ir,
    usedTaskIds: [...new Set([...data.usedTaskIds, ...data.ir.tasks.map((task) => task.id)])],
    dateInputs: { start: data.dateInputs.start, deadline: data.dateInputs.deadline },
    asOfInput: data.asOfInput,
    entries: data.entries.map(([id, val]) => [id, val]),
    plans: safePlans,
  };
  return JSON.stringify(payload, null, 2);
}

export function parseWorkspaceJson(
  raw: string,
): { ok: true; data: StoredWorkspace } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Tệp JSON không hợp lệ hoặc bị hỏng." };
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return { ok: false, error: "Định dạng dự án không tương thích (cần version = 1)." };
  }
  const ir = sanitizeIR(parsed.ir);
  if (!ir) {
    return { ok: false, error: "Dữ liệu dự án (tasks, thành viên hoặc cấu hình) không hợp lệ." };
  }
  if (!isRecord(parsed.dateInputs) || typeof parsed.dateInputs.start !== "string" || typeof parsed.dateInputs.deadline !== "string") {
    return { ok: false, error: "Thông tin ngày dự án không hợp lệ." };
  }
  const usedTaskIds = isStringArray(parsed.usedTaskIds)
    ? [...new Set([...parsed.usedTaskIds, ...ir.tasks.map((task) => task.id)])]
    : ir.tasks.map((task) => task.id);
  const asOfInput = typeof parsed.asOfInput === "string" ? parsed.asOfInput : "";
  const entries: [string, string][] = Array.isArray(parsed.entries)
    ? parsed.entries.filter((pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")
    : [];

  return {
    ok: true,
    data: {
      version: 1,
      ir,
      usedTaskIds,
      dateInputs: { start: parsed.dateInputs.start, deadline: parsed.dateInputs.deadline },
      asOfInput,
      entries,
      plans: sanitizePlans(parsed.plans),
    },
  };
}

export function loadStoredWorkspace(): StoredWorkspace | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseWorkspaceJson(raw);
    return parsed.ok ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveStoredWorkspace(data: StoredWorkspace): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, serializeWorkspace(data));
  } catch {
    // Bỏ qua trong ngữ cảnh hạn chế lưu trữ như file:// hoặc chế độ ẩn danh chặt.
  }
}

export function clearStoredWorkspace(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Bỏ qua lỗi lưu trữ trình duyệt.
  }
}

export function loadQuickStartCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(QUICKSTART_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveQuickStartCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(QUICKSTART_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Bỏ qua lỗi lưu trữ trình duyệt.
  }
}

export function exportFileName(projectName: string): string {
  const normalized = projectName
    .normalize("NFD")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalized || "du-an"}.constraintlens.json`;
}
