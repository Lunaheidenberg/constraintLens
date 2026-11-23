import { dateAtOffset, deadlineDaysLate, isCalendarDate } from "./calendar.ts";
import type { CalendarFinish, CompletedTask, ProgressSnapshot, ProjectMember, RescheduleResult, ScheduledTask, Task } from "./types";

export interface Plan {
  calendar: CalendarFinish;
  status: string;
  scheduledTasks: ScheduledTask[];
  solveTimeMs: number;
  scheduleRevision: number;
  tasks: Task[];
  members: ProjectMember[];
  recovery: Pick<RescheduleResult, "progress_as_of_date" | "replanning_start_day" | "replanning_start_date" |
    "remaining_horizon_days" | "completed_tasks"> | null;
}

export interface PlanState {
  revision: number;
  baseline: Plan | null;
  previous: Plan | null;
  accepted: Plan | null;
  acceptedRevision: number | null;
  todoConfirmed: boolean | null;
  confirmedProgress: ConfirmedProgress | null;
  proposal: { revision: number; plan: Plan; source: "planning" | "progress" } | null;
  stale: boolean;
}

export interface ConfirmedProgress {
  snapshot: ProgressSnapshot;
  completedTasks: CompletedTask[];
  reviewedTodoTaskIds: string[];
}

export const initialPlans: PlanState = {
  revision: 0, baseline: null, previous: null, accepted: null, acceptedRevision: null, todoConfirmed: null,
  confirmedProgress: null, proposal: null, stale: false,
};

export const hasSolution = (status: string) => status === "OPTIMAL" || status === "FEASIBLE";

export function assessDeadline(plan: Plan, deadline = plan.calendar?.target_deadline_date) {
  if (!deadline || !isCalendarDate(deadline)) return null;
  const boundary = plan.calendar.project_finish_date_exclusive;
  const finalDate = boundary && isCalendarDate(boundary) && boundary > "0001-01-01" ? dateAtOffset(boundary, -1) : null;
  return finalDate ? { deadline, finalDate, daysLate: deadlineDaysLate(deadline, finalDate) } : null;
}

export function canAcceptProposal({ proposal, revision }: PlanState) {
  if (!proposal || proposal.revision !== revision || !hasSolution(proposal.plan.status)) return false;
  return proposal.plan.calendar?.target_deadline_date == null || assessDeadline(proposal.plan)?.daysLate === 0;
}

export type ComparisonReference = "previous" | "baseline";

export function comparisonPair(state: PlanState, reference: ComparisonReference = "previous") {
  if (!state.accepted) return null;
  if (state.proposal?.revision === state.revision) {
    return { previous: state.accepted, revised: state.proposal.plan, mode: "proposal" as const };
  }
  const previous = reference === "baseline" ? state.baseline : state.previous;
  return previous && previous !== state.accepted ? { previous, revised: state.accepted, mode: reference } : null;
}

type PlanAction =
  | { type: "reset" | "cancel" | "accept" }
  | { type: "inputsChanged"; todoConfirmed?: boolean | null }
  | { type: "propose"; revision: number; plan: Plan; confirmation?: ConfirmedProgress };

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.type) {
    case "reset":
      return { ...initialPlans, revision: state.revision + 1 };
    case "inputsChanged":
      return {
        ...state, revision: state.revision + 1, todoConfirmed: action.todoConfirmed ?? null,
        proposal: null, stale: state.stale || state.proposal !== null,
      };
    case "propose": {
      if (action.revision !== state.revision || !hasSolution(action.plan.status)) return state;
      const source = action.confirmation ? "progress" : "planning";
      return {
        ...state, proposal: { revision: action.revision, plan: action.plan, source }, stale: false,
        confirmedProgress: action.confirmation ?? state.confirmedProgress,
      };
    }
    case "cancel":
      return { ...state, proposal: null, stale: false };
    case "accept": {
      if (!state.proposal || !canAcceptProposal(state)) return state;
      const plan = state.proposal.plan;
      return {
        ...state, baseline: state.baseline ?? plan, previous: state.accepted, accepted: plan,
        acceptedRevision: state.revision, todoConfirmed: null, proposal: null, stale: false,
      };
    }
  }
}
