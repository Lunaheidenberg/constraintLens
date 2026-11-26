import type { KanbanStatus, ProjectCalendar } from "./types";

const INTENTS = ["overview", "changes", "deadline", "dependencies", "progress", "attention", "causes", "actions"] as const;
const FACT_KINDS = ["solver_status", "schedule", "deadline", "task", "dependency", "wait", "shared_assignee",
  "parallel", "progress", "task_change", "schedule_change", "attention"] as const;
const AI_STATUSES = ["skipped", "used", "missing_key", "unavailable", "timeout", "invalid_output"] as const;

export type RecoveryIntent = typeof INTENTS[number];
type Role = "accepted" | "proposal";
type FactValue = string | number | boolean | null | string[];

export interface RecoverySnapshot {
  project_ref: string;
  snapshot_ref: string;
  calendar: ProjectCalendar;
  status: "OPTIMAL" | "FEASIBLE";
  tasks: {
    id: string;
    name: string;
    estimated_duration: number;
    dependencies: string[];
    assignee_id: string | null;
    status?: KanbanStatus;
  }[];
  scheduled_tasks: {
    task_id: string;
    start_day: number;
    end_day: number;
    earliest_ready_day: number;
    queue_wait_days: number;
  }[];
  progress: {
    progress_as_of_date: string;
    actual_finishes: Record<string, string>;
    remaining_durations: Record<string, number>;
  } | null;
}

export interface RecoveryRequest {
  context_ref: string;
  question: string;
  intent?: RecoveryIntent;
  focus_task_ids?: string[];
  accepted: RecoverySnapshot | null;
  proposal: RecoverySnapshot;
}

export interface RecoveryFact {
  id: string;
  kind: typeof FACT_KINDS[number];
  role: Role | null;
  task_ids: string[];
  data: Record<string, FactValue>;
}

export interface RecoveryExplanation {
  id: string;
  text: string;
  fact_ids: string[];
  task_ids: string[];
}

interface RecoveryUnknown {
  code: string;
  text: string;
  task_ids: string[];
}

export interface RecoveryResponse {
  context_ref: string;
  basis: {
    accepted_ref: string | null;
    proposal_ref: string | null;
    selected_role: Role | null;
    comparison: "compared" | "single_schedule" | "no_schedule";
    evaluation_deadline_date: string | null;
    intent: RecoveryIntent;
    highlighted_fact_ids: string[];
  };
  facts: RecoveryFact[];
  possible_explanations: RecoveryExplanation[];
  suggestions: (RecoveryExplanation & { status: "unverified" })[];
  unknowns: RecoveryUnknown[];
  ai_status: typeof AI_STATUSES[number];
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isList = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const strings = (value: unknown) => isList(value, isString);
const nullableString = (value: unknown) => value === null || isString(value);
const role = (value: unknown) => value === null || value === "accepted" || value === "proposal";
const oneOf = (value: unknown, choices: readonly string[]) => isString(value) && choices.includes(value);

function isExplanation(value: unknown): value is RecoveryExplanation & Record<string, unknown> {
  return isRecord(value) && isString(value.id) && isString(value.text) && strings(value.fact_ids) && strings(value.task_ids);
}

function isFact(value: unknown) {
  return isRecord(value) && isString(value.id) && oneOf(value.kind, FACT_KINDS) && role(value.role) &&
    strings(value.task_ids) && isRecord(value.data) && Object.values(value.data).every((item) =>
      item === null || typeof item === "boolean" || Number.isSafeInteger(item) || isString(item) || strings(item));
}

function isRecoveryResponse(value: unknown): value is RecoveryResponse {
  if (!isRecord(value) || !isString(value.context_ref) || !isRecord(value.basis)) return false;
  const { basis } = value;
  return nullableString(basis.accepted_ref) && nullableString(basis.proposal_ref) && role(basis.selected_role) &&
    oneOf(basis.comparison, ["compared", "single_schedule", "no_schedule"]) &&
    nullableString(basis.evaluation_deadline_date) && oneOf(basis.intent, INTENTS) && strings(basis.highlighted_fact_ids) &&
    isList(value.facts, isFact) && isList(value.possible_explanations, isExplanation) &&
    isList(value.suggestions, (item) => isExplanation(item) && item.status === "unverified") &&
    isList(value.unknowns, (item) => isRecord(item) && isString(item.code) && isString(item.text) && strings(item.task_ids)) &&
    oneOf(value.ai_status, AI_STATUSES);
}

export async function explainRecovery(baseUrl: string, payload: RecoveryRequest, signal: AbortSignal): Promise<RecoveryResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/recovery/explain`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Không kết nối được với trợ lý giải thích lịch. Kiểm tra kết nối rồi thử lại.");
  }
  if (response.status === 422) {
    throw new Error("Trợ lý không thể kiểm tra vì dữ liệu lịch gửi lên không hợp lệ hoặc không khớp. Hãy tính lại lịch rồi thử lại.");
  }
  if (!response.ok) throw new Error(`Trợ lý giải thích lịch hiện không khả dụng (HTTP ${response.status}). Vui lòng thử lại.`);
  const data: unknown = await response.json().catch(() => null);
  if (!isRecoveryResponse(data)) throw new Error("Trợ lý trả về dữ liệu không đọc được. Vui lòng thử lại.");

  if (data.context_ref !== payload.context_ref || data.basis.accepted_ref !== (payload.accepted?.snapshot_ref ?? null) ||
      data.basis.proposal_ref !== payload.proposal.snapshot_ref || data.basis.selected_role !== "proposal" ||
      data.basis.comparison !== (payload.accepted ? "compared" : "single_schedule")) {
    throw new Error("Câu trả lời không khớp với lịch đang xem. Hãy gửi lại câu hỏi.");
  }
  return data;
}
