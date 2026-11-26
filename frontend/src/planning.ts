import { draftReady, generateProjectDraft, removeDraftTask, saveDraftTask, type DraftRequestUpdates, type EditableTask } from "./draft.ts";
import type { PlanState } from "./plans.ts";
import type {
  DraftTask, PlanningClarification, PlanningDraftRequest, PlanningDraftResult, PlanningSource,
  ProjectDraft, ProjectMember, QuestionID, SchedulingIR,
} from "./types.ts";

export interface ClarificationSession extends PlanningClarification {
  prompt: string;
  answers: Partial<Record<QuestionID, string>>;
}

export function planningPayload(session: ClarificationSession, skipAll: boolean): PlanningDraftRequest {
  return {
    prompt: session.prompt,
    clarifications: session.questions.map(({ id, text }) => ({
      id, question: text, answer: skipAll ? null : session.answers[id]?.trim() || null,
    })),
  };
}

export function planningApi(post: <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>) {
  return {
    clarify: (prompt: string, signal: AbortSignal) =>
      post<PlanningClarification>("/api/planning/clarify", { prompt }, signal),
    draft: (session: ClarificationSession, skipAll: boolean, signal: AbortSignal) =>
      post<PlanningDraftResult>("/api/planning/draft", planningPayload(session, skipAll), signal),
    confirm: (draft: ProjectDraft, signal: AbortSignal) =>
      post<SchedulingIR>("/api/parse/confirm", draft, signal),
  };
}

export function cancelPlanningRequest(request: { current: AbortController | null }) {
  request.current?.abort();
  request.current = null;
}

export function planningApplyBlock(
  taskCount: number,
  plans: Pick<PlanState, "baseline" | "previous" | "accepted" | "proposal" | "confirmedProgress" | "todoConfirmed">,
  hasPendingProgress: boolean,
  busy: boolean,
) {
  if (taskCount || plans.baseline || plans.previous || plans.accepted || plans.proposal ||
      plans.confirmedProgress || plans.todoConfirmed || hasPendingProgress) {
    return "Chỉ có thể áp dụng vào dự án chưa có công việc, lịch hoặc tiến độ. Bạn vẫn có thể xem và chỉnh sửa bản nháp.";
  }
  return busy ? "Hãy hoàn tất thao tác dự án đang chạy trước khi áp dụng bản nháp." : "";
}

export interface PlanningApplyTarget {
  version: number;
  blocked: string;
}

export async function confirmPlanningDraft(
  request: { current: AbortController | null }, draft: ProjectDraft, getTarget: () => PlanningApplyTarget,
  send: (draft: ProjectDraft, signal: AbortSignal) => Promise<SchedulingIR>, updates: DraftRequestUpdates<SchedulingIR>,
) {
  if (request.current || !draftReady(draft)) return;
  const target = getTarget();
  if (target.blocked) {
    updates.failed(new Error(target.blocked));
    return;
  }
  await generateProjectDraft(request, (signal) => send(draft, signal), {
    ...updates,
    ready: (confirmed) => {
      const latest = getTarget();
      if (latest.blocked) throw new Error(latest.blocked);
      if (latest.version !== target.version) {
        throw new Error("Dự án đã thay đổi trong lúc kiểm tra. Hãy xem lại rồi xác nhận bản nháp lần nữa.");
      }
      updates.ready(confirmed);
    },
  });
}

export function hasDraftSuggestions({ tasks }: ProjectDraft) {
  return tasks.some((task) =>
    task.duration !== null && task.duration_review === "suggested" ||
    task.dependencies !== null && task.dependency_review === "suggested" ||
    task.suggested_assignee_id != null && task.assignee_review === "suggested");
}

export function confirmDraftSuggestions(draft: ProjectDraft): ProjectDraft {
  return {
    ...draft,
    tasks: draft.tasks.map((task): DraftTask => ({
      ...task,
      duration_review: task.duration !== null && task.duration_review === "suggested" ? "confirmed" : task.duration_review,
      dependency_review: task.dependencies !== null && task.dependency_review === "suggested" ? "confirmed" : task.dependency_review,
      ...(task.suggested_assignee_id != null && task.assignee_review === "suggested"
        ? { assignee_review: "confirmed" as const }
        : {}),
    })),
  };
}

const editedSource: PlanningSource = { kind: "edited" };
const missingSource: PlanningSource = { kind: "unknown" };

export function editPlanningTask(
  result: PlanningDraftResult, original: DraftTask, edited: EditableTask,
  review: { duration: boolean; dependencies: boolean; assignee?: boolean },
): PlanningDraftResult {
  const draft = saveDraftTask(result.draft, original, edited, review);
  const index = result.draft.tasks.indexOf(original);
  const updated = draft.tasks[index < 0 ? draft.tasks.length - 1 : index];
  const sources = { ...result.sources.tasks };
  const prior = index < 0 ? undefined : sources[original.id];
  if (index >= 0) delete sources[original.id];
  const prevAssignee = original.suggested_assignee_id ?? null;
  const nextAssignee = updated.suggested_assignee_id ?? null;
  const assigneeSource = nextAssignee === null ? undefined
    : nextAssignee === prevAssignee ? (prior?.assignee ?? editedSource) : editedSource;
  sources[updated.id] = {
    name: updated.name === original.name ? prior?.name ?? editedSource : editedSource,
    category: updated.category === original.category ? prior?.category ?? editedSource : editedSource,
    duration: updated.duration === null ? missingSource
      : updated.duration === original.duration ? prior?.duration ?? editedSource : editedSource,
    dependencies: updated.dependencies === null ? missingSource
      : JSON.stringify(updated.dependencies) === JSON.stringify(original.dependencies) ? prior?.dependencies ?? editedSource : editedSource,
    ...(assigneeSource ? { assignee: assigneeSource } : {}),
  };
  return { ...result, draft, sources: { ...result.sources, tasks: sources } };
}

export function updateDraftMembers(result: PlanningDraftResult, members: ProjectMember[]): PlanningDraftResult {
  const validIds = new Set(members.map((member) => member.id));
  const sources = { ...result.sources.tasks };
  const tasks = result.draft.tasks.map((task): DraftTask => {
    if (!task.suggested_assignee_id || validIds.has(task.suggested_assignee_id)) return task;
    const origin = sources[task.id];
    if (origin?.assignee) {
      const { assignee: _removed, ...rest } = origin;
      sources[task.id] = rest;
    }
    return { ...task, suggested_assignee_id: null, assignee_review: null };
  });
  return {
    ...result,
    draft: { ...result.draft, members, tasks },
    sources: { ...result.sources, tasks: sources },
  };
}

export function mergeConfirmedMembers(existing: ProjectMember[], confirmed: SchedulingIR): SchedulingIR {
  const merged = [...existing];
  const usedIds = new Set(merged.map((member) => member.id));
  const byName = new Map(merged.map((member) => [member.name.trim().toLocaleLowerCase("vi"), member.id]));
  const idMap = new Map<string, string>();
  for (const candidate of confirmed.members ?? []) {
    const key = candidate.name.trim().toLocaleLowerCase("vi");
    const matchedId = byName.get(key);
    if (matchedId) {
      idMap.set(candidate.id, matchedId);
      continue;
    }
    let nextId = candidate.id;
    let suffix = 2;
    while (usedIds.has(nextId)) {
      nextId = `${candidate.id}-${suffix++}`;
    }
    usedIds.add(nextId);
    byName.set(key, nextId);
    idMap.set(candidate.id, nextId);
    merged.push({ id: nextId, name: candidate.name });
  }
  return {
    ...confirmed,
    members: merged,
    team_capacity: Math.max(confirmed.team_capacity ?? 1, merged.length, 1),
    tasks: confirmed.tasks.map((task) => ({
      ...task,
      assignee_id: task.assignee_id ? (idMap.get(task.assignee_id) ?? task.assignee_id) : null,
    })),
  };
}

export function removePlanningTask(result: PlanningDraftResult, removed: DraftTask): PlanningDraftResult {
  const remaining = removeDraftTask(result.draft, removed);
  const originalTasks = result.draft.tasks.filter((task) => task !== removed);
  const sources = { ...result.sources.tasks };
  delete sources[removed.id];
  const tasks = remaining.tasks.map((task, index): DraftTask => {
    if (task === originalTasks[index]) return task;
    const source = sources[task.id];
    const hasDependencies = !!task.dependencies?.length;
    if (source) sources[task.id] = { ...source, dependencies: hasDependencies ? editedSource : missingSource };
    return hasDependencies ? task : { ...task, dependencies: null, dependency_review: "missing" };
  });
  return { ...result, draft: { ...remaining, tasks }, sources: { ...result.sources, tasks: sources } };
}
