import { dateAtOffset, dayOffset, formatDate } from "./calendar";
import type { ScheduleComparison, TaskComparison } from "./comparison";

const previousBar = "border-dashed border-zinc-300 bg-zinc-600/45";
const revisedBar = "border-indigo-300/80 bg-indigo-500";

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
  const crossesYear = start.slice(0, 4) !== last.slice(0, 4);
  const width = Math.min(1450, Math.max(680, 184 + span * 22));
  const tickStep = Math.ceil(span / (crossesYear ? 5 : 8));
  const ticks = Array.from({ length: Math.ceil(span / tickStep) }, (_, index) => index * tickStep);
  const percent = (offset: number) => `${100 * offset / span}%`;
  const position = (date: string, fraction = 0) => percent(dayOffset(start, date) + fraction);
  const grid = <>
    {ticks.slice(1).map((day) => (
      <span key={day} className="absolute inset-y-0 border-l border-zinc-800/80" style={{ left: percent(day) }} />
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
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt so sánh" tabIndex={0}>
        <div className="divide-y divide-zinc-800" style={{ minWidth: width }}>
          <div className="grid grid-cols-[184px_minmax(0,1fr)] bg-[#0d0d10]">
            <div className="sticky left-0 z-20 bg-[#0d0d10] px-3 py-2 text-xs font-medium text-zinc-400">Công việc · Người phụ trách</div>
            <div className="relative h-8 border-l border-zinc-800 font-mono text-[10px] text-zinc-300">
              <div aria-hidden="true">{grid}</div>
              {ticks.map((day) => (
                <span key={day} className="absolute top-2 whitespace-nowrap pl-1.5" style={{ left: percent(day) }}>
                  {formatDate(dateAtOffset(start, day), crossesYear)}
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
              <div key={task.id} className="grid grid-cols-[184px_minmax(0,1fr)]">
                <div className="sticky left-0 z-20 min-w-0 break-words bg-[#121215] px-3 py-2 text-xs">
                  <div className="font-medium"><span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{name}</div>
                  <div className="mt-0.5 text-zinc-400">{assignee}</div>
                </div>
                <div className="relative min-h-12 border-l border-zinc-800" role="img"
                  aria-label={`${name}. ${labels.previous}: ${taskTiming(task.previous)}. ${labels.revised}: ${taskTiming(task.revised)}.`}>
                  <div aria-hidden="true">{grid}</div>
                  {([["previous", task.previous], ["revised", task.revised]] as const).map(([side, snapshot]) => {
                    const previous = side === "previous";
                    const label = labels[side];
                    const lane = previous ? "bottom-1/2 mb-0.5" : "top-1/2 mt-0.5";
                    const interval = snapshot?.interval;
                    if (snapshot?.actualFinish) return <span key={side} aria-hidden="true"
                      className={`absolute ${lane} size-2.5 -translate-x-1/2 rotate-45 rounded-[1px] border border-emerald-300 ${previous ? "bg-[#121215]" : "bg-emerald-400"}`}
                      style={{ left: position(snapshot.actualFinish, 0.5) }} title={`${label} · ${taskTiming(snapshot)}`} />;
                    if (!interval) return null;
                    return <span key={side} aria-hidden="true"
                      className={`absolute ${lane} h-3 min-w-px rounded-sm border ${previous ? previousBar : revisedBar}`}
                      style={{ left: position(interval.start), width: percent(interval.duration) }} title={`${label} · ${taskTiming(snapshot)}`} />;
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
