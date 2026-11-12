import type { CalendarFinish, ProjectMember, RescheduleResult, ScheduledTask, Task } from "./types";

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
  todoConfirmed: boolean;
  proposal: { revision: number; plan: Plan } | null;
  stale: boolean;
}

export const initialPlans: PlanState = {
  revision: 0, baseline: null, previous: null, accepted: null, acceptedRevision: null, todoConfirmed: false, proposal: null, stale: false,
};

export const hasSolution = (status: string) => status === "OPTIMAL" || status === "FEASIBLE";

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
  | { type: "reset" | "inputsChanged" | "confirmTodo" | "cancel" | "accept" }
  | { type: "propose"; revision: number; plan: Plan };

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.type) {
    case "reset":
      return { ...initialPlans, revision: state.revision + 1 };
    case "inputsChanged":
      return { ...state, revision: state.revision + 1, todoConfirmed: false, proposal: null, stale: state.stale || state.proposal !== null };
    case "confirmTodo":
      return state.accepted ? { ...state, todoConfirmed: true } : state;
    case "propose":
      if (action.revision !== state.revision) return state;
      if (!hasSolution(action.plan.status)) return { ...state, proposal: null };
      return { ...state, proposal: { revision: action.revision, plan: action.plan }, stale: false };
    case "cancel":
      return { ...state, proposal: null, stale: false };
    case "accept": {
      if (!state.proposal || state.proposal.revision !== state.revision) return state;
      const plan = state.proposal.plan;
      return {
        ...state, baseline: state.baseline ?? plan, previous: state.accepted, accepted: plan,
        acceptedRevision: state.revision, todoConfirmed: false, proposal: null, stale: false,
      };
    }
  }
}
