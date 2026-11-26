import { dayOffset, formatDate } from "./calendar";
import type { ScheduleComparison, TaskComparison } from "./comparison";
import { splitDeadlineInterval } from "./scheduleView";
import { timelineAxis } from "./timeline";

const previousBar = "border-dashed border-zinc-300 bg-zinc-600/45";
const revisedBar = "gantt-bar";

export function taskTiming(task: TaskComparison["revised"]) {
  if (!task) return "Không có trong lịch";
  if (task.actualFinish) return `Hoàn thành thực tế · ${formatDate(task.actualFinish)}`;
  if (!task.interval) return task.done ? "Done · Thiếu ngày hoàn thành" : "Thiếu ngày dự kiến";
  return `${formatDate(task.interval.start)} – ${formatDate(task.interval.finalWorkDate)}`;
}

export function ComparisonTimeline({ comparison, labels }: {
  comparison: ScheduleComparison;
  labels: { previous: string; revised: string };
}) {
  const { tasks, previousFinish, revisedFinish, deadline, replanningDate, progressAsOf } = comparison;
  const dates = [previousFinish.finalDate, revisedFinish.finalDate, deadline?.target, replanningDate];
  for (const task of tasks) {
    for (const snapshot of [task.previous, task.revised]) {
      dates.push(snapshot?.interval?.start, snapshot?.interval?.finalWorkDate, snapshot?.actualFinish);
    }
  }
  const calendarDates = dates.filter((date): date is string => !!date).sort();
  if (calendarDates.length === 0) return <p className="notice text-zinc-400">Không có ngày hợp lệ để vẽ biểu đồ.</p>;
  const start = calendarDates[0];
  const last = calendarDates[calendarDates.length - 1];
  const span = dayOffset(start, last) + 1;
  const deadlineBoundaryDay = deadline && deadline.target >= start ? dayOffset(start, deadline.target) + 1 : null;
  const hasOverdueRevised = deadlineBoundaryDay !== null && tasks.some((task) => {
    const interval = task.revised?.interval;
    if (interval) {
      return dayOffset(start, interval.start) + interval.duration > deadlineBoundaryDay;
    }
    return task.revised?.actualFinish ? dayOffset(start, task.revised.actualFinish) + 1 > deadlineBoundaryDay : false;
  });
  const { width, ticks, position: percent } = timelineAxis(start, span);
  const position = (date: string, fraction = 0) => percent(dayOffset(start, date) + fraction);
  const grid = <>
    {ticks.slice(1).map(({ day }) => (
      <span key={day} className="absolute inset-y-0 border-l border-zinc-700/60" style={{ left: percent(day) }} />
    ))}
    {deadline && <span className="absolute inset-y-0 z-10 border-l border-dashed border-amber-400/90"
      style={deadline.target === last ? { right: 0 } : { left: position(deadline.target, 1) }} />}
    {replanningDate && <span className="absolute inset-y-0 z-10 border-l-2 border-sky-400/70"
      style={{ left: position(replanningDate) }} />}
  </>;

  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300" aria-label="Chú giải biểu đồ">
        <li className="flex items-center gap-1.5"><span aria-hidden="true" className={`h-2.5 w-4 rounded-sm border ${previousBar}`} />{labels.previous}</li>
        <li className="flex items-center gap-1.5"><span aria-hidden="true" className={`h-2.5 w-4 rounded-sm border ${revisedBar}`} />{labels.revised}</li>
        {hasOverdueRevised && (
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="gantt-bar-overdue h-2.5 w-4 rounded-sm border" />Vượt hạn chót</li>
        )}
        {tasks.some((task) => task.previous?.actualFinish || task.revised?.actualFinish) && (
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="mx-1 size-2 rotate-45 bg-emerald-400" />Ngày hoàn thành thực tế</li>
        )}
        {deadline && <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="mx-1.5 h-3 border-l border-dashed border-amber-400" />Hết hạn ngày {formatDate(deadline.target)}
        </li>}
        {replanningDate && <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="mx-1.5 h-3 border-l-2 border-sky-400" />
          Lập lại lịch từ {formatDate(replanningDate)}{progressAsOf && ` · Tiến độ đến hết ${formatDate(progressAsOf)}`}
        </li>}
      </ul>
      <p className="helper min-[760px]:hidden">Cuộn ngang để xem thêm ngày.</p>
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt so sánh" tabIndex={0}>
        <div className="divide-y divide-zinc-800" style={{ minWidth: width }}>
          <div className="gantt-row gantt-axis">
            <div className="gantt-label px-3 py-2 text-xs font-medium text-zinc-300">Công việc · Người phụ trách</div>
            <div className="gantt-lane min-h-9 font-mono text-[11px] text-zinc-300">
              <div aria-hidden="true">{grid}</div>
              {ticks.map(({ day, label }) => label && (
                <span key={day} className="absolute top-2 whitespace-nowrap pl-1.5" style={{ left: percent(day) }}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {tasks.map((task) => {
            const name = task.revised?.name ?? task.previous?.name;
            const beforeAssignee = task.previous?.assignee ?? "Chưa phân công";
            const afterAssignee = task.revised?.assignee ?? "Chưa phân công";
            const assignee = task.assigneeChanged ? `${beforeAssignee} → ${afterAssignee}` : task.revised ? afterAssignee : beforeAssignee;
            return (
              <div key={task.id} className="gantt-row">
                <div className="gantt-label px-3 py-2 text-xs">
                  <div className="font-medium"><span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{name}</div>
                  <div className="mt-0.5 text-zinc-400">{assignee}</div>
                </div>
                <div className="gantt-lane min-h-12" role="img" tabIndex={0}
                  aria-label={`${name}. ${labels.previous}: ${taskTiming(task.previous)}. ${labels.revised}: ${taskTiming(task.revised)}.`}>
                  <div aria-hidden="true">{grid}</div>
                  {([["previous", task.previous], ["revised", task.revised]] as const).map(([side, snapshot]) => {
                    const previous = side === "previous";
                    const label = labels[side];
                    const lane = previous ? "bottom-1/2 mb-0.5" : "top-1/2 mt-0.5";
                    const interval = snapshot?.interval;
                    if (snapshot?.actualFinish) return <span key={side} aria-hidden="true"
                      className={`absolute ${lane} size-2.5 -translate-x-1/2 rotate-45 rounded-[1px] border border-emerald-300 ${previous ? "bg-[var(--panel)]" : "bg-emerald-400"}`}
                      style={{ left: position(snapshot.actualFinish, 0.5) }} title={`${label} · ${taskTiming(snapshot)}`} />;
                    if (!interval) return null;
                    if (previous || deadlineBoundaryDay === null) {
                      return <span key={side} aria-hidden="true"
                        className={`absolute ${lane} h-3 min-w-px rounded-sm border ${previous ? previousBar : revisedBar}`}
                        style={{ left: position(interval.start), width: percent(interval.duration) }} title={`${label} · ${taskTiming(snapshot)}`} />;
                    }
                    const intervalStartDay = dayOffset(start, interval.start);
                    const split = splitDeadlineInterval(intervalStartDay, intervalStartDay + interval.duration, deadlineBoundaryDay);
                    return <span key={side} className="contents">
                      {split.onTime && <span aria-hidden="true"
                        className={`absolute ${lane} h-3 min-w-px rounded-sm border ${revisedBar}`}
                        style={{ left: percent(split.onTime.start), width: percent(split.onTime.width) }} title={`${label} · ${taskTiming(snapshot)}`} />}
                      {split.overdue && <span aria-hidden="true"
                        className={`absolute ${lane} h-3 min-w-px rounded-sm border gantt-bar-overdue`}
                        style={{ left: percent(split.overdue.start), width: percent(split.overdue.width) }} title={`${label} · ${taskTiming(snapshot)} (Vượt hạn ${split.overdueDays} ngày)`} />}
                    </span>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
