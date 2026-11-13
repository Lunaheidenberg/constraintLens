import { dayOffset, isCalendarDate, parseDateInput } from "./calendar.ts";
import type { Plan } from "./plans";
import type { CompletedTask, ProgressSnapshot, Task } from "./types";

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
    const value = entries.get(task.id);
    if (task.status === "Doing" && value) {
      const duration = parseRemainingDuration(value);
      if (duration === null) errors.push(`Nhập số ngày thực tế còn lại là số nguyên dương cho '${task.id}'.`);
      else progress.push([task.id, { remaining_duration: duration }]);
    } else if (task.status === "Done") {
      const finish = completed.get(task.id)?.actual_finish_date ?? parseDateInput(value ?? "");
      if (finish) progress.push([task.id, { actual_finish_date: finish }]);
      else if (value?.trim()) errors.push(`Nhập ngày hoàn thành thực tế của ${task.id} theo định dạng DD/MM/YYYY.`);
    }
  }
  return { taskProgress: Object.fromEntries(progress), errors };
}
