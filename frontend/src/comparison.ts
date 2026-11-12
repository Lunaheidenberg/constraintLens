import { dateAtOffset, dayOffset, isCalendarDate } from "./calendar.ts";
import { hasSolution, type Plan } from "./plans.ts";

interface PlannedInterval {
  start: string;
  finalWorkDate: string;
  endExclusive: string;
  duration: number;
}

interface SnapshotTask {
  name: string;
  assigneeId: string | null;
  assignee: string | null;
  interval: PlannedInterval | null;
  done: boolean;
  actualFinish: string | null;
}

export interface TaskComparison {
  id: string;
  previous: SnapshotTask | null;
  revised: SnapshotTask | null;
  startDelta: number | null;
  finishDelta: number | null;
  moved: boolean;
  unchanged: boolean;
  durationChanged: boolean;
  confirmed: boolean;
  newlyConfirmed: boolean;
  assigneeChanged: boolean;
}

function calendarDate(value: string | null | undefined) {
  return value && isCalendarDate(value) ? value : null;
}

function offsetDate(start: string | null, offset: number) {
  if (!start || !Number.isSafeInteger(offset) || offset < 0 || offset > dayOffset(start, "9999-12-31")) return null;
  return dateAtOffset(start, offset);
}

function snapshotTasks(plan: Plan) {
  const start = calendarDate(plan.calendar.project_start_date);
  const members = new Map(plan.members.map((member) => [member.id, member.name]));
  const scheduled = new Map(plan.scheduledTasks.map((task) => [task.id, task]));
  const completed = new Map(plan.recovery?.completed_tasks.map((task) => [task.id, task]));
  const metadata = new Map(plan.tasks.map((task) => [task.id, task]));
  const ids = new Set([...metadata.keys(), ...scheduled.keys(), ...completed.keys()]);
  const tasks = new Map<string, SnapshotTask>();
  for (const id of ids) {
    const work = scheduled.get(id);
    const completion = completed.get(id);
    const task = metadata.get(id);
    const done = completion !== undefined || (plan.recovery !== null && task?.status === "Done");
    const assigneeId = completion?.assignee_id ?? work?.assignee_id ?? task?.assignee_id ?? null;
    let interval: PlannedInterval | null = null;
    if (work && !done && work.end_day > work.start_day) {
      const first = offsetDate(start, work.start_day);
      const end = offsetDate(start, work.end_day);
      if (first && end) {
        interval = { start: first, finalWorkDate: dateAtOffset(end, -1), endExclusive: end, duration: work.end_day - work.start_day };
      }
    }
    tasks.set(id, {
      name: task?.name ?? completion?.name ?? work?.name ?? id,
      assigneeId,
      assignee: assigneeId === null ? null : members.get(assigneeId) ?? assigneeId,
      interval,
      done,
      actualFinish: calendarDate(completion?.actual_finish_date),
    });
  }
  return tasks;
}

function projectFinish(plan: Plan, tasks: Map<string, SnapshotTask>, allowActualFallback: boolean) {
  const completions = [...tasks.values()].map((task) => task.actualFinish);
  const allDone = completions.length > 0 && completions.every((date) => date !== null);
  const latestActual = allDone ? completions.reduce<string>((latest, date) => date && date > latest ? date : latest, "") : null;
  const boundary = calendarDate(plan.calendar.project_finish_date_exclusive) ??
    (allowActualFallback && latestActual ? offsetDate(latestActual, 1) : null);
  const finalDate = boundary && boundary > "0001-01-01" ? dateAtOffset(boundary, -1) : null;
  return { boundary, finalDate, actual: allDone };
}

function compareTask(id: string, previous: SnapshotTask | null, revised: SnapshotTask | null): TaskComparison {
  const before = previous?.interval;
  const after = revised?.interval;
  const startDelta = before && after ? dayOffset(before.start, after.start) : null;
  const finishDelta = before && after ? dayOffset(before.finalWorkDate, after.finalWorkDate) : null;
  const confirmed = !!revised?.actualFinish;
  return {
    id, previous, revised, startDelta, finishDelta,
    moved: startDelta !== null && (startDelta !== 0 || finishDelta !== 0),
    unchanged: startDelta === 0 && finishDelta === 0,
    durationChanged: !!before && !!after && before.duration !== after.duration,
    confirmed,
    newlyConfirmed: confirmed && !previous?.actualFinish,
    assigneeChanged: !!previous && !!revised && (previous.assigneeId !== revised.assigneeId || previous.assignee !== revised.assignee),
  };
}

function deadlineStatus(deadline: string, finish: string | null) {
  if (!finish) return null;
  const daysLate = Math.max(0, dayOffset(deadline, finish) - 1);
  return { daysLate, status: daysLate === 0 ? "on_time" as const : "late" as const };
}

export function comparePlans(previous: Plan, revised: Plan) {
  if (!hasSolution(previous.status) || !hasSolution(revised.status)) return null;
  const before = snapshotTasks(previous);
  const after = snapshotTasks(revised);
  const ids = new Set([...before.keys(), ...after.keys()]);
  const tasks = [...ids].map((id) => compareTask(id, before.get(id) ?? null, after.get(id) ?? null));
  const previousFinish = projectFinish(previous, before, false);
  const revisedFinish = projectFinish(revised, after, true);

  // Evaluate both finishes against the revised snapshot's target, so the change
  // in lateness measures the schedule shift against a single inclusive deadline.
  const target = calendarDate(revised.calendar.target_deadline_date);
  const previousDeadline = target ? deadlineStatus(target, previousFinish.boundary) : null;
  const revisedDeadline = target ? deadlineStatus(target, revisedFinish.boundary) : null;
  return {
    previousFinish,
    revisedFinish,
    finishDelta: previousFinish.boundary && revisedFinish.boundary ? dayOffset(previousFinish.boundary, revisedFinish.boundary) : null,
    tasks,
    movedCount: tasks.filter((task) => task.moved).length,
    unchangedCount: tasks.filter((task) => task.unchanged).length,
    confirmedCount: tasks.filter((task) => task.confirmed).length,
    newlyConfirmedCount: tasks.filter((task) => task.newlyConfirmed).length,
    deadline: target ? {
      target, previous: previousDeadline, revised: revisedDeadline,
      latenessDelta: previousDeadline && revisedDeadline ? revisedDeadline.daysLate - previousDeadline.daysLate : null,
    } : null,
    progressAsOf: calendarDate(revised.recovery?.progress_as_of_date),
    replanningDate: calendarDate(revised.recovery?.replanning_start_date),
    remainingHorizon: revised.recovery?.remaining_horizon_days ?? null,
  };
}

export type ScheduleComparison = NonNullable<ReturnType<typeof comparePlans>>;

export function hasTaskChange(task: TaskComparison) {
  return task.moved || task.newlyConfirmed || task.assigneeChanged || !task.previous || !task.revised;
}
