import { dayOffset, isCalendarDate, parseDateInput } from "./calendar.ts";
import type { Plan } from "./plans";
import type { CompletedTask, ProgressSnapshot, Task } from "./types";

export function progressFromPlan(plan: Plan | null): ProgressSnapshot | null {
  if (!plan?.recovery) return null;
  const completions = plan.recovery.completed_tasks.map(({ id, actual_finish_date }) => [id, { actual_finish_date }] as const);
  const doing = new Set(plan.tasks.filter((task) => task.status === "Doing").map((task) => task.id));
  const remaining = plan.scheduledTasks.filter((task) => doing.has(task.id))
    .map(({ id, duration }) => [id, { remaining_duration: duration }] as const);
  return {
    progress_as_of_date: plan.recovery.progress_as_of_date,
    task_progress: Object.fromEntries([...completions, ...remaining]),
  };
}

export function matchesReportedStatuses(tasks: Task[], snapshot: ProgressSnapshot | null) {
  const reports = new Map(Object.entries(snapshot?.task_progress ?? {}));
  return tasks.every(({ id, status }) => {
    const entry = reports.get(id);
    reports.delete(id);
    const reported = !entry ? "To Do" : "actual_finish_date" in entry ? "Done" : "Doing";
    return (status ?? "To Do") === reported;
  }) && reports.size === 0;
}

export function plannedRemainingDays(accepted: Plan | null, reportingDate: string) {
  const remaining = new Map<string, number>();
  if (!accepted || !isCalendarDate(reportingDate) || reportingDate === "9999-12-31") return remaining;
  const start = accepted.calendar.project_start_date;
  if (!isCalendarDate(start)) return remaining;

  // The report includes the whole reporting day. Offsets belong to the accepted plan's calendar.
  const boundary = dayOffset(start, reportingDate) + 1;
  const lastOffset = dayOffset(start, "9999-12-31");
  for (const { id, start_day, end_day } of accepted.scheduledTasks) {
    if (!Number.isSafeInteger(start_day) || !Number.isSafeInteger(end_day) ||
      start_day < 0 || end_day <= start_day || end_day > lastOffset) continue;
    remaining.set(id, Math.max(0, end_day - Math.max(start_day, boundary)));
  }
  return remaining;
}

export function parseRemainingDuration(value: string) {
  const duration = Number(value);
  return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
}

export function remainingDurationDifference(planned: number | undefined, actual: number | null) {
  return planned === undefined || actual === null ? null : actual - planned;
}

export function collectTaskProgress(
  tasks: Task[], entries: ReadonlyMap<string, string>, completed: ReadonlyMap<string, CompletedTask>,
) {
  const progress: [string, ProgressSnapshot["task_progress"][string]][] = [];
  const errors: string[] = [];
  for (const task of tasks) {
    const value = entries.get(task.id)?.trim();
    if (task.status === "Doing" && value) {
      const duration = parseRemainingDuration(value);
      if (duration === null) errors.push(`Nhập số ngày thực tế còn lại là số nguyên dương cho '${task.id}'.`);
      else progress.push([task.id, { remaining_duration: duration }]);
    } else if (task.status === "Done") {
      const finish = completed.get(task.id)?.actual_finish_date ?? parseDateInput(value ?? "");
      if (finish) progress.push([task.id, { actual_finish_date: finish }]);
      else if (value) errors.push(`Nhập ngày hoàn thành thực tế của ${task.id} theo định dạng DD/MM/YYYY.`);
    }
  }
  return { taskProgress: Object.fromEntries(progress), errors };
}

export function hasProgressReportEdits(
  asOfInput: string, draft: ReturnType<typeof collectTaskProgress>, confirmed: ProgressSnapshot | null,
) {
  const asOf = parseDateInput(asOfInput);
  if (draft.errors.length || asOf !== (confirmed?.progress_as_of_date ?? null) || (!asOf && asOfInput.trim())) return true;

  const submitted = new Map(Object.entries(confirmed?.task_progress ?? {}));
  const entries = Object.entries(draft.taskProgress);
  return entries.length !== submitted.size || entries.some(([id, entry]) => {
    const previous = submitted.get(id);
    if (!previous) return true;
    return "remaining_duration" in entry
      ? !("remaining_duration" in previous) || entry.remaining_duration !== previous.remaining_duration
      : !("actual_finish_date" in previous) || entry.actual_finish_date !== previous.actual_finish_date;
  });
}
