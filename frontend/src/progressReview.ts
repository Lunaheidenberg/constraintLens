import { dateAtOffset, isCalendarDate } from "./calendar.ts";
import type { Plan } from "./plans";
import type { Task } from "./types";

export function todoTasksDueForReview(accepted: Plan | null, tasks: Task[], reportingDate: string) {
  if (!accepted || !isCalendarDate(reportingDate)) return [];
  const starts = new Map(accepted.scheduledTasks.map((task) => [task.id, task.start_day]));

  return tasks.flatMap((task) => {
    const offset = starts.get(task.id);
    if ((task.status ?? "To Do") !== "To Do" || offset === undefined) return [];
    const plannedStart = dateAtOffset(accepted.calendar.project_start_date, offset);
    return plannedStart <= reportingDate ? [{ id: task.id, name: task.name, plannedStart }] : [];
  });
}
