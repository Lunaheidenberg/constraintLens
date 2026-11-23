import { draftReady, generateProjectDraft, removeDraftTask, saveDraftTask, type DraftRequestUpdates, type EditableTask } from "./draft.ts";
import type { PlanState } from "./plans.ts";
import type {
  DraftTask, PlanningClarification, PlanningDraftRequest, PlanningDraftResult, PlanningSource,
  ProjectDraft, QuestionID, SchedulingIR,
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
    task.dependencies !== null && task.dependency_review === "suggested");
}

export function confirmDraftSuggestions(draft: ProjectDraft): ProjectDraft {
  return {
    ...draft,
    tasks: draft.tasks.map((task): DraftTask => ({
      ...task,
      duration_review: task.duration !== null && task.duration_review === "suggested" ? "confirmed" : task.duration_review,
      dependency_review: task.dependencies !== null && task.dependency_review === "suggested" ? "confirmed" : task.dependency_review,
    })),
  };
}

const editedSource: PlanningSource = { kind: "edited" };
const missingSource: PlanningSource = { kind: "unknown" };

export function editPlanningTask(
  result: PlanningDraftResult, original: DraftTask, edited: EditableTask,
  review: { duration: boolean; dependencies: boolean },
): PlanningDraftResult {
  const draft = saveDraftTask(result.draft, original, edited, review);
  const index = result.draft.tasks.indexOf(original);
  const updated = draft.tasks[index < 0 ? draft.tasks.length - 1 : index];
  const sources = { ...result.sources.tasks };
  const prior = index < 0 ? undefined : sources[original.id];
  if (index >= 0) delete sources[original.id];
  sources[updated.id] = {
    name: updated.name === original.name ? prior?.name ?? editedSource : editedSource,
    category: updated.category === original.category ? prior?.category ?? editedSource : editedSource,
    duration: updated.duration === null ? missingSource
      : updated.duration === original.duration ? prior?.duration ?? editedSource : editedSource,
    dependencies: updated.dependencies === null ? missingSource
      : JSON.stringify(updated.dependencies) === JSON.stringify(original.dependencies) ? prior?.dependencies ?? editedSource : editedSource,
  };
  return { ...result, draft, sources: { ...result.sources, tasks: sources } };
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
