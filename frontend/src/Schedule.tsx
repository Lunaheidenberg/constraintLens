import { dateAtOffset, dayOffset, formatDate } from "./calendar";
import type { Plan } from "./plans";
import type { ProjectMember } from "./types";
import { taskCategory } from "./ProjectEditor";

// Keep the existing category colors for the planned timeline.
const CATEGORY_COLORS = new Map(Object.entries({
  Design: "#f59e0b",
  Coding: "#6366f1",
  Backend: "#6366f1",
  Frontend: "#6366f1",
  Dev: "#6366f1",
  Review: "#a855f7",
  Testing: "#10b981",
}));

export function Schedule({ plan, members, deadline }: {
  plan: Plan;
  members: ProjectMember[];
  deadline: string | null;
}) {
  const { calendar, recovery, scheduledTasks } = plan;
  const start = calendar.project_start_date;
  const finish = calendar.project_finish_day_exclusive;
  const replanningDay = recovery?.replanning_start_day ?? null;
  // Both reference lines show boundaries. The deadline line is after the inclusive deadline date.
  const deadlineBoundary = deadline === null ? null : dayOffset(start, deadline) + 1;
  const endDay = Math.max(1, finish ?? 0, deadlineBoundary ?? 0, (replanningDay ?? 0) + 1);
  const crossesYear = start.slice(0, 4) !== dateAtOffset(start, endDay - 1).slice(0, 4);
  const tickStep = Math.ceil(endDay / (crossesYear ? 5 : 8));
  const ticks = Array.from({ length: Math.ceil(endDay / tickStep) }, (_, index) => index * tickStep);
  const position = (day: number) => `${(day / endDay) * 100}%`;
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const memberById = new Map([...plan.members, ...members].map((member) => [member.id, member.name]));
  const queueWait = scheduledTasks.reduce((total, task) => total + task.queue_wait_days, 0);
  const deadlineDelta = deadlineBoundary === null || finish === null ? null : deadlineBoundary - finish;
  const completionLabel = recovery?.remaining_horizon_days === 0 ? "Hoàn thành thực tế" : "Ngày làm việc cuối";

  const metrics = [
    ["Trạng thái CP-SAT", plan.status],
    recovery ? ["Khoảng lịch còn lại", `${recovery.remaining_horizon_days} ngày`] : ["Tổng thời gian", `${finish} ngày`],
    ["Tổng thời gian chờ", `${queueWait} ngày`],
    ["Thời gian giải", `${plan.solveTimeMs.toFixed(1)} ms`],
  ];
  const referenceLines = <>
    {deadlineBoundary !== null && <span aria-hidden="true" className="absolute inset-y-0 z-10 border-l border-dashed border-amber-400/80"
      style={deadlineBoundary === endDay ? { right: 0 } : { left: position(deadlineBoundary) }} />}
    {replanningDay !== null && <span aria-hidden="true" className="absolute inset-y-0 z-10 border-l border-dashed border-sky-400/80"
      style={{ left: position(replanningDay) }} />}
  </>;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div className="panel px-3 py-2.5" key={label}>
            <dt className="text-xs text-zinc-400">{label}</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-zinc-100">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300">
        <span>Bắt đầu dự án: {formatDate(start)}</span>
        {calendar.final_work_date && <span>{completionLabel}: {formatDate(calendar.final_work_date)}</span>}
        {deadline !== null && deadlineDelta !== null && <span className="text-amber-300">
          Hạn chót {formatDate(deadline)} · {deadlineDelta < 0 ? `Trễ ${-deadlineDelta} ngày` : "Đúng hạn"}
        </span>}
        {recovery?.replanning_start_date && <span className="text-sky-300">
          Tiến độ đến hết {formatDate(recovery.progress_as_of_date)} · Lập lại lịch từ {formatDate(recovery.replanning_start_date)}
        </span>}
      </div>
      {recovery?.remaining_horizon_days === 0 && <p className="text-xs text-emerald-300">Không còn công việc cần lập lịch.</p>}
      {recovery && recovery.completed_tasks.length > 0 && <p className="text-xs text-zinc-400">Chấm xanh ghi nhận ngày hoàn thành đã xác nhận.</p>}
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt" tabIndex={0}>
        <div className={`${crossesYear ? "min-w-[680px]" : "min-w-[570px]"} divide-y divide-zinc-800`}>
          <div className="gantt-row bg-[#0d0d10]">
            <span className="px-3 py-2 text-xs font-medium text-zinc-400">Công việc · Người phụ trách</span>
            <div className="relative h-8 border-l border-zinc-800 font-mono text-[10px] text-zinc-400">
              {ticks.map((day) => (
                <span key={day} className="absolute top-2 pl-1" style={{ left: position(day) }}>{formatDate(dateAtOffset(start, day), crossesYear)}</span>
              ))}
              {referenceLines}
            </div>
          </div>
          {recovery?.completed_tasks.map((task) => (
            <div key={task.id} className="gantt-row">
              <div className="min-w-0 break-words px-3 py-2 text-xs">
                <div><span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{task.name}</div>
                <div className="mt-0.5 text-zinc-400">{memberById.get(task.assignee_id)}</div>
                <div className="text-emerald-300">Done · {formatDate(task.actual_finish_date)}</div>
              </div>
              <div className="relative border-l border-zinc-800">
                {referenceLines}
                <span aria-hidden="true" className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400"
                  style={{ left: position(task.actual_end_day_exclusive - 0.5) }} />
              </div>
            </div>
          ))}
          {scheduledTasks.map((task) => {
            const plannedTask = taskById.get(task.id);
            const category = plannedTask ? taskCategory(plannedTask) : task.kanban_stage;
            const color = CATEGORY_COLORS.get(category) ?? "#71717a";
            const member = memberById.get(task.assignee_id ?? "");
            // Solver intervals are [start_day, end_day). Show the last occupied calendar date.
            const timing = `${formatDate(dateAtOffset(start, task.start_day))} – ${formatDate(dateAtOffset(start, task.end_day - 1))} · ${task.duration} ngày`;
            return (
              <div key={task.id} className="gantt-row">
                <div className="min-w-0 px-3 py-2 text-xs">
                  <div className="break-words"><span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{task.name}</div>
                  <div className="mt-0.5 break-words text-zinc-400">{member} · {category}</div>
                  <div className="text-zinc-400">{timing}</div>
                </div>
                <div className="relative border-l border-zinc-800">
                  {ticks.slice(1).map((day) => (
                    <span key={day} aria-hidden="true" className="absolute inset-y-0 border-l border-zinc-800/70" style={{ left: position(day) }} />
                  ))}
                  {referenceLines}
                  {task.queue_wait_days > 0 && (
                    <span className="gantt-wait absolute top-1/2 h-4 -translate-y-1/2 rounded-sm"
                      title={`Chờ ${task.queue_wait_days} ngày kể từ khi sẵn sàng`}
                      style={{ left: position(task.earliest_ready_day), width: position(task.queue_wait_days) }} />
                  )}
                  <span className="absolute top-1/2 h-5 min-w-px -translate-y-1/2 rounded-sm border"
                    title={`${category} · ${member} · ${timing}\n${task.dependencies.length ? `Tiên quyết ${task.dependencies.join(", ")}` : "Không có công việc tiên quyết"}`}
                    style={{ left: position(task.start_day), width: position(task.end_day - task.start_day), borderColor: color, backgroundColor: `${color}50` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
