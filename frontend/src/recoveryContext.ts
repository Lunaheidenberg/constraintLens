import { comparisonPair, type Plan, type PlanState } from "./plans.ts";
import { progressFromPlan } from "./progressReport.ts";
import type { RecoverySnapshot } from "./recoveryApi";

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

export function recoveryContext(plans: PlanState, projectInstance: number) {
  const { proposal, accepted, revision } = plans;
  if (!proposal || proposal.revision !== revision) return null;

  const pair = comparisonPair(plans);
  const projectRef = `project-${projectInstance}`;
  const after = toSnapshot(pair?.revised ?? proposal.plan, projectRef);
  const before = pair && toSnapshot(pair.previous, projectRef);
  if (!after || (accepted && !before)) return null;

  return {
    key: `${before?.snapshot_ref ?? "initial"}/${after.snapshot_ref}/revision-${revision}`,
    accepted: before,
    proposal: after,
  };
}
