import { comparisonPair, type ComparisonReference, type Plan, type PlanState } from "./plans.ts";
import { progressFromPlan } from "./progressReport.ts";
import type { RecoverySnapshot } from "./recoveryApi";

export interface RecoveryContext {
  key: string;
  mode: "proposal" | "accepted" | "history";
  accepted: RecoverySnapshot | null;
  proposal: RecoverySnapshot;
  roleLabels: { accepted: string; proposal: string };
  summary: string;
}

// Two proposals can share the same input and accepted revisions. Each solved Plan is a new object.
const planRefs = new WeakMap<Plan, number>();
let nextPlanRef = 0;

function toSnapshot(plan: Plan, projectRef: string): RecoverySnapshot | null {
  const { status, calendar, tasks, scheduledTasks } = plan;
  if ((status !== "OPTIMAL" && status !== "FEASIBLE") || !calendar.final_work_date || !tasks.length ||
      (!scheduledTasks.length && !plan.recovery?.completed_tasks.length)) return null;

  let ref = planRefs.get(plan);
  if (ref === undefined) {
    ref = ++nextPlanRef;
    planRefs.set(plan, ref);
  }
  const report = progressFromPlan(plan);
  const progressEntries = Object.entries(report?.task_progress ?? {});
  const actualFinishes = [];
  const remainingDurations = [];
  for (const [id, entry] of progressEntries) {
    if ("actual_finish_date" in entry) actualFinishes.push([id, entry.actual_finish_date] as const);
    else remainingDurations.push([id, entry.remaining_duration] as const);
  }

  return {
    project_ref: projectRef, snapshot_ref: `${projectRef}-schedule-${ref}`, status,
    calendar: { project_start_date: calendar.project_start_date, target_deadline_date: calendar.target_deadline_date },
    tasks: tasks.map(({ id, name, duration, dependencies, assignee_id, status }) => ({
      id, name, estimated_duration: duration, dependencies: [...dependencies], assignee_id: assignee_id ?? null, status,
    })),
    scheduled_tasks: scheduledTasks.map(({ id, start_day, end_day, earliest_ready_day, queue_wait_days }) => ({
      task_id: id, start_day, end_day, earliest_ready_day, queue_wait_days,
    })),
    progress: report && {
      progress_as_of_date: report.progress_as_of_date,
      actual_finishes: Object.fromEntries(actualFinishes), remaining_durations: Object.fromEntries(remainingDurations),
    },
  };
}

export function recoveryContext(plans: PlanState, projectInstance: number): RecoveryContext | null {
  const { proposal, accepted, revision } = plans;
  if (!proposal || proposal.revision !== revision) return null;

  const pair = comparisonPair(plans);
  const projectRef = `project-${projectInstance}`;
  const after = toSnapshot(pair?.revised ?? proposal.plan, projectRef);
  const before = pair && toSnapshot(pair.previous, projectRef);
  if (!after || (accepted && !before)) return null;

  return {
    key: `${before?.snapshot_ref ?? "initial"}/${after.snapshot_ref}/revision-${revision}`,
    mode: "proposal",
    accepted: before,
    proposal: after,
    roleLabels: { accepted: "Lịch đang áp dụng", proposal: "Lịch đề xuất" },
    summary: before
      ? "Phân tích lịch đang áp dụng và đề xuất hiện tại."
      : "Phân tích lịch ban đầu đề xuất. Chưa có lịch đã chấp nhận để đối chiếu.",
  };
}

export function acceptedRecoveryContext(
  plans: PlanState,
  projectInstance: number,
  reference?: ComparisonReference,
): RecoveryContext | null {
  if (!plans.accepted) return null;
  const projectRef = `project-${projectInstance}`;
  if (reference) {
    const pair = comparisonPair({ ...plans, proposal: null }, reference);
    if (pair) {
      const before = toSnapshot(pair.previous, projectRef);
      const after = toSnapshot(pair.revised, projectRef);
      if (!before || !after) return null;
      const beforeLabel = pair.mode === "baseline" ? "Lịch gốc" : "Lịch trước đó";
      return {
        key: `history-${pair.mode}/${before.snapshot_ref}/${after.snapshot_ref}`,
        mode: "history",
        accepted: before,
        proposal: after,
        roleLabels: { accepted: beforeLabel, proposal: "Lịch đã chấp nhận hiện tại" },
        summary: `Phân tích so sánh giữa ${beforeLabel} và Lịch đã chấp nhận hiện tại.`,
      };
    }
  }
  const current = toSnapshot(plans.accepted, projectRef);
  if (!current) return null;
  return {
    key: `accepted/${current.snapshot_ref}`,
    mode: "accepted",
    accepted: null,
    proposal: current,
    roleLabels: { accepted: "Lịch trước đó", proposal: "Lịch đang áp dụng" },
    summary: "Phân tích lịch đang áp dụng hiện tại. Chưa đối chiếu với bản lịch khác.",
  };
}
