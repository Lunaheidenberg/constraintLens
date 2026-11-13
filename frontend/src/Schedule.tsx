import { dateAtOffset, dayOffset, formatDate } from "./calendar";
import { assessDeadline, type Plan } from "./plans";
import type { ProjectMember } from "./types";
import { taskCategory } from "./ProjectEditor";

import { timelineAxis } from "./timeline";

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
  const deadlineBoundary = deadline === null || deadline < start ? null : dayOffset(start, deadline) + 1;
  const endDay = Math.max(1, finish ?? 0, deadlineBoundary ?? 0, (replanningDay ?? 0) + 1);
  const { ticks, width, position } = timelineAxis(start, endDay);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const memberById = new Map([...plan.members, ...members].map((member) => [member.id, member.name]));
  const queueWait = scheduledTasks.reduce((total, task) => total + task.queue_wait_days, 0);
  const daysLate = assessDeadline(plan, deadline)?.daysLate;
  const completionLabel = recovery?.remaining_horizon_days === 0 ? "Hoàn thành thực tế" : "Ngày làm việc cuối";

  const metrics = [
    [completionLabel, calendar.final_work_date ? formatDate(calendar.final_work_date) : "Chưa rõ"],
    ["Thời gian dự án", finish === null ? "Chưa rõ" : `${finish} ngày`],
    ["Công việc trong lịch", plan.tasks.length],
    ["Trạng thái CP-SAT", plan.status],
    ["Hạn mục tiêu", deadline === null ? "Chưa đặt" : daysLate === undefined ? "Chưa rõ" : daysLate ? `Trễ ${daysLate} ngày` : "Đúng hạn"],
  ];
  const grid = <>
    {ticks.slice(1).map(({ day }) => (
      <span key={day} aria-hidden="true" className="absolute inset-y-0 border-l border-zinc-700/60" style={{ left: position(day) }} />
    ))}
    {deadlineBoundary !== null && <span aria-hidden="true" className="absolute inset-y-0 z-10 border-l border-dashed border-amber-400/80"
      style={deadlineBoundary === endDay ? { right: 0 } : { left: position(deadlineBoundary) }} />}
    {replanningDay !== null && <span aria-hidden="true" className="absolute inset-y-0 z-10 border-l-2 border-sky-400/80"
      style={{ left: position(replanningDay) }} />}
  </>;

  return (
    <div className="space-y-3">
      <dl className="metric-strip">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={`text-sm font-semibold tabular-nums ${label === "Hạn mục tiêu" && daysLate !== undefined
              ? daysLate ? "text-amber-200" : "text-emerald-300" : ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="helper">
        Bắt đầu {formatDate(start)} · Tổng số ngày chờ của các công việc: {queueWait} · Thời gian giải: {plan.solveTimeMs.toFixed(1)} ms
        {plan.status === "FEASIBLE" && " · Có lịch khả thi, chưa chứng minh tối ưu"}
        {recovery && ` · Khoảng lịch còn lại: ${recovery.remaining_horizon_days} ngày`}
      </p>
      {recovery?.remaining_horizon_days === 0 && <p className="notice success">Không còn công việc cần lập lịch.</p>}
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-300" aria-label="Chú giải biểu đồ">
        <li className="flex items-center gap-1.5"><span className="gantt-bar h-2.5 w-4 rounded-sm border" aria-hidden="true" /> Công việc dự kiến</li>
        {queueWait > 0 && <li className="flex items-center gap-1.5"><span className="gantt-wait h-2.5 w-4 rounded-sm" aria-hidden="true" /> Thời gian chờ</li>}
        {!!recovery?.completed_tasks.length && <li className="flex items-center gap-1.5"><span className="mx-1 size-2 rotate-45 bg-emerald-400" aria-hidden="true" /> Hoàn thành thực tế</li>}
        {deadlineBoundary !== null && deadline !== null && <li className="flex items-center gap-1.5"><span className="mx-1 h-3 border-l border-dashed border-amber-400" aria-hidden="true" /> Hết hạn ngày {formatDate(deadline)}</li>}
        {recovery?.replanning_start_date && <li className="flex items-center gap-1.5"><span className="mx-1 h-3 border-l-2 border-sky-400" aria-hidden="true" />
          Lập lại lịch từ {formatDate(recovery.replanning_start_date)} · Tiến độ đến hết {formatDate(recovery.progress_as_of_date)}
        </li>}
      </ul>
      <p className="helper min-[760px]:hidden">Cuộn ngang để xem thêm ngày.</p>
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt" tabIndex={0}>
        <div className="divide-y divide-zinc-800" style={{ minWidth: width }}>
          <div className="gantt-row gantt-axis">
            <span className="gantt-label px-3 py-2 text-xs font-medium text-zinc-300">Công việc · Người phụ trách</span>
            <div className="gantt-lane min-h-9 font-mono text-[11px] text-zinc-300">
              {grid}
              {ticks.map(({ day, label }) => label && (
                <span key={day} className="absolute top-2 whitespace-nowrap pl-1.5" style={{ left: position(day) }}>{label}</span>
              ))}
            </div>
          </div>
          {recovery?.completed_tasks.map((task) => (
            <div key={task.id} className="gantt-row">
              <div className="gantt-label px-3 py-2 text-xs">
                <div><span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{task.name}</div>
                <div className="mt-0.5 text-zinc-400">{memberById.get(task.assignee_id)}</div>
                <div className="text-emerald-300">Done · {formatDate(task.actual_finish_date)}</div>
              </div>
              <div className="gantt-lane" role="img" tabIndex={0} title={`Hoàn thành thực tế · ${formatDate(task.actual_finish_date)}`}
                aria-label={`${task.name} · Hoàn thành thực tế ${formatDate(task.actual_finish_date)}`}>
                {grid}
                <span aria-hidden="true" className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-emerald-400"
                  style={{ left: position(task.actual_end_day_exclusive - 0.5) }} />
              </div>
            </div>
          ))}
          {scheduledTasks.map((task) => {
            const plannedTask = taskById.get(task.id);
            const category = plannedTask ? taskCategory(plannedTask) : task.kanban_stage;
            const member = memberById.get(task.assignee_id ?? "") ?? "Chưa phân công";
            // Solver intervals are [start_day, end_day). Show the last occupied calendar date.
            const timing = `${formatDate(dateAtOffset(start, task.start_day))} – ${formatDate(dateAtOffset(start, task.end_day - 1))} · ${task.duration} ngày`;
            return (
              <div key={task.id} className="gantt-row">
                <div className="gantt-label px-3 py-2 text-xs">
                  <div className="font-semibold"><span className="mr-1.5 font-mono font-normal text-zinc-400">{task.id}</span>{task.name}</div>
                  <div className="mt-0.5 break-words text-zinc-400">{member} · {category}</div>
                  <div className="text-zinc-400">{timing}</div>
                </div>
                <div className="gantt-lane" role="img" tabIndex={0}
                  aria-label={`${task.name} · ${member} · ${timing}${task.queue_wait_days ? ` · Chờ ${task.queue_wait_days} ngày` : ""}`}>
                  {grid}
                  {task.queue_wait_days > 0 && (
                    <span className="gantt-wait absolute top-1/2 h-4 -translate-y-1/2 rounded-sm"
                      title={`Chờ ${task.queue_wait_days} ngày kể từ khi sẵn sàng`}
                      style={{ left: position(task.earliest_ready_day), width: position(task.queue_wait_days) }} />
                  )}
                  <span className="gantt-bar absolute top-1/2 h-4 min-w-px -translate-y-1/2 rounded-sm border"
                    title={`${category} · ${member} · ${timing}\n${task.dependencies.length ? `Tiên quyết ${task.dependencies.join(", ")}` : "Không có công việc tiên quyết"}`}
                    style={{ left: position(task.start_day), width: position(task.end_day - task.start_day) }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
