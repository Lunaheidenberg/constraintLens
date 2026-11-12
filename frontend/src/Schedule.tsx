import type { ProjectMember, ScheduleResult, Task } from "./types";
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

export function Schedule({ result, tasks, members, deadline }: {
  result: ScheduleResult;
  tasks: Task[];
  members: ProjectMember[];
  deadline: number | null;
}) {
  const endDay = Math.max(result.makespan, deadline ?? 0) + 1;
  const tickStep = Math.ceil(endDay / 12);
  const ticks = Array.from({ length: Math.ceil(endDay / tickStep) }, (_, index) => index * tickStep);
  const position = (day: number) => `${(day / endDay) * 100}%`;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const memberById = new Map(members.map((member) => [member.id, member.name]));
  const queueWait = result.scheduled_tasks.reduce((total, task) => total + task.queue_wait_days, 0);
  const deadlineDelta = deadline === null ? null : deadline - result.makespan;

  const metrics = [
    ["Trạng thái CP-SAT", result.status],
    ["Tổng thời gian", `${result.makespan} ngày`],
    ["Tổng thời gian chờ", `${queueWait} ngày`],
    ["Thời gian giải", `${result.solve_time_ms.toFixed(1)} ms`],
  ];

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
      {deadlineDelta !== null && (
        <p className={`text-xs ${deadlineDelta < 0 ? "text-amber-300" : "text-zinc-300"}`}>
          Hạn chót ngày {deadline} · {deadlineDelta === 0 ? "Đúng hạn" : `${deadlineDelta > 0 ? "Sớm" : "Trễ"} ${Math.abs(deadlineDelta)} ngày`}
        </p>
      )}
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt" tabIndex={0}>
        <div className="min-w-[570px] divide-y divide-zinc-800">
          <div className="gantt-row bg-[#0d0d10]">
            <span className="px-3 py-2 text-xs font-medium text-zinc-400">Công việc · Người phụ trách</span>
            <div className="relative h-8 border-l border-zinc-800 font-mono text-[10px] text-zinc-400">
              {ticks.map((day) => (
                <span key={day} className="absolute top-2 pl-1" style={{ left: position(day) }}>N{day}</span>
              ))}
            </div>
          </div>
          {result.scheduled_tasks.map((task) => {
            const plannedTask = taskById.get(task.id);
            const category = plannedTask ? taskCategory(plannedTask) : task.kanban_stage;
            const color = CATEGORY_COLORS.get(category) ?? "#71717a";
            const member = memberById.get(task.assignee_id ?? "");
            const timing = `Ngày ${task.start_day} đến ngày ${task.end_day}`;
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
                  {deadline !== null && (
                    <span aria-hidden="true" className="absolute inset-y-0 z-10 border-l border-dashed border-amber-400/80" style={{ left: position(deadline) }} />
                  )}
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
