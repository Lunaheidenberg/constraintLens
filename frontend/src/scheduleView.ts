import { dayOffset, isCalendarDate } from "./calendar.ts";
import type { CompletedTask, ProjectCalendar, ProjectMember, ScheduledTask, Task } from "./types.ts";

export interface IntervalSegment {
  start: number;
  width: number;
}

export interface DeadlineSplit {
  onTime: IntervalSegment | null;
  overdue: IntervalSegment | null;
  overdueDays: number;
}

export interface MemberSwimlane {
  memberId: string;
  memberName: string;
  colorIndex: number;
  scheduled: ScheduledTask[];
  completed: CompletedTask[];
  totalDays: number;
  totalWaitDays: number;
  overdueTaskCount: number;
}

const PALETTE_SIZE = 6;

export function durationDeadlineWarnings(tasks: Pick<Task, "id" | "name" | "duration">[], calendar: ProjectCalendar): string[] {
  const start = calendar.project_start_date;
  const deadline = calendar.target_deadline_date;
  if (!start || !deadline || !isCalendarDate(start) || !isCalendarDate(deadline) || deadline < start) {
    return [];
  }
  const windowDays = dayOffset(start, deadline) + 1;
  const warnings: string[] = [];
  for (const task of tasks) {
    if (Number.isSafeInteger(task.duration) && task.duration > windowDays) {
      const label = task.name.trim() ? `${task.id} (${task.name})` : task.id;
      warnings.push(
        `Công việc ${label} có thời lượng ${task.duration} ngày, vượt quá tổng quỹ thời gian ${windowDays} ngày từ ngày bắt đầu đến hạn chót.`,
      );
    }
  }
  return warnings;
}

export function splitDeadlineInterval(
  startDay: number,
  endDay: number,
  deadlineBoundary: number | null,
): DeadlineSplit {
  if (endDay <= startDay) {
    return { onTime: null, overdue: null, overdueDays: 0 };
  }
  if (deadlineBoundary === null || endDay <= deadlineBoundary) {
    return { onTime: { start: startDay, width: endDay - startDay }, overdue: null, overdueDays: 0 };
  }
  if (startDay >= deadlineBoundary) {
    const overdueDays = endDay - startDay;
    return { onTime: null, overdue: { start: startDay, width: overdueDays }, overdueDays };
  }
  const overdueDays = endDay - deadlineBoundary;
  return {
    onTime: { start: startDay, width: deadlineBoundary - startDay },
    overdue: { start: deadlineBoundary, width: overdueDays },
    overdueDays,
  };
}

export function memberColorIndex(memberId: string | null | undefined, members: ProjectMember[]): number {
  if (!memberId) return 0;
  const idx = members.findIndex((member) => member.id === memberId);
  if (idx >= 0) return idx % PALETTE_SIZE;
  let hash = 0;
  for (let i = 0; i < memberId.length; i++) {
    hash = (hash * 31 + memberId.charCodeAt(i)) >>> 0;
  }
  return hash % PALETTE_SIZE;
}

export function groupTasksByMember(
  scheduledTasks: ScheduledTask[],
  completedTasks: CompletedTask[],
  members: ProjectMember[],
  deadlineBoundary: number | null = null,
): MemberSwimlane[] {
  const map = new Map<string, MemberSwimlane>();
  const ensureLane = (memberId: string, memberName: string): MemberSwimlane => {
    const existing = map.get(memberId);
    if (existing) return existing;
    const lane: MemberSwimlane = {
      memberId,
      memberName,
      colorIndex: memberId === "__unassigned__" ? 0 : memberColorIndex(memberId, members),
      scheduled: [],
      completed: [],
      totalDays: 0,
      totalWaitDays: 0,
      overdueTaskCount: 0,
    };
    map.set(memberId, lane);
    return lane;
  };

  for (const member of members) {
    ensureLane(member.id, member.name);
  }

  for (const task of scheduledTasks) {
    const key = task.assignee_id ?? "__unassigned__";
    const name = task.assignee_id
      ? (members.find((m) => m.id === task.assignee_id)?.name ?? task.assignee_id)
      : "Chưa phân công";
    const lane = ensureLane(key, name);
    lane.scheduled.push(task);
    lane.totalDays += task.duration;
    lane.totalWaitDays += task.queue_wait_days;
    if (deadlineBoundary !== null && task.end_day > deadlineBoundary) {
      lane.overdueTaskCount += 1;
    }
  }

  for (const task of completedTasks) {
    const key = task.assignee_id;
    const name = members.find((m) => m.id === key)?.name ?? key;
    const lane = ensureLane(key, name);
    lane.completed.push(task);
    if (deadlineBoundary !== null && task.actual_end_day_exclusive > deadlineBoundary) {
      lane.overdueTaskCount += 1;
    }
  }

  const lanes: MemberSwimlane[] = [];
  for (const lane of map.values()) {
    if (!lane.scheduled.length && !lane.completed.length) continue;
    lane.scheduled.sort((a, b) => a.start_day - b.start_day || a.id.localeCompare(b.id));
    lane.completed.sort((a, b) => a.actual_end_day_exclusive - b.actual_end_day_exclusive || a.id.localeCompare(b.id));
    lanes.push(lane);
  }
  return lanes;
}
