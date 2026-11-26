import { useState } from "react";
import { dateAtOffset, dayOffset, formatDate } from "./calendar";
import { assessDeadline, type Plan } from "./plans";
import type { ProjectMember } from "./types";
import { taskCategory } from "./ProjectEditor";
import { groupTasksByMember, memberColorIndex, splitDeadlineInterval } from "./scheduleView";
import { timelineAxis } from "./timeline";

function shortDateRange(startIso: string, endIso: string, baseYear: string) {
  const [y1, m1, d1] = startIso.split("-");
  const [y2, m2, d2] = endIso.split("-");
  if (y1 === baseYear && y2 === baseYear) return `${d1}/${m1} – ${d2}/${m2}`;
  return `${formatDate(startIso)} – ${formatDate(endIso)}`;
}

export function Schedule({ plan, members, deadline }: {
  plan: Plan;
  members: ProjectMember[];
  deadline: string | null;
}) {
  const [viewMode, setViewMode] = useState<"tasks" | "members">("tasks");
  const { calendar, recovery, scheduledTasks } = plan;
  const start = calendar.project_start_date;
  const finish = calendar.project_finish_day_exclusive;
  const replanningDay = recovery?.replanning_start_day ?? null;
  // Both reference lines show boundaries. The deadline line is after the inclusive deadline date.
  const deadlineBoundary = deadline === null || deadline < start ? null : dayOffset(start, deadline) + 1;
  const endDay = Math.max(1, finish ?? 0, deadlineBoundary ?? 0, (replanningDay ?? 0) + 1);
  const { ticks, width, position } = timelineAxis(start, endDay);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const allMembers = [...plan.members, ...members];
  const memberById = new Map(allMembers.map((member) => [member.id, member.name]));
  const queueWait = scheduledTasks.reduce((total, task) => total + task.queue_wait_days, 0);
  const daysLate = assessDeadline(plan, deadline)?.daysLate;
  const completionLabel = recovery?.remaining_horizon_days === 0 ? "Hoàn thành thực tế" : "Ngày làm việc cuối";
  const completedTasks = recovery?.completed_tasks ?? [];
  const hasOverdue = deadlineBoundary !== null && (
    scheduledTasks.some((task) => task.end_day > deadlineBoundary) ||
    completedTasks.some((task) => task.actual_end_day_exclusive > deadlineBoundary)
  );
  const swimlanes = viewMode === "members"
    ? groupTasksByMember(scheduledTasks, completedTasks, allMembers.length ? members : plan.members, deadlineBoundary)
    : [];

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
      <div className="gantt-toolbar">
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-300" aria-label="Chú giải biểu đồ">
          <li className="flex items-center gap-1.5"><span className="gantt-bar h-2.5 w-4 rounded-sm border" aria-hidden="true" /> Công việc dự kiến</li>
          {hasOverdue && <li className="flex items-center gap-1.5"><span className="gantt-bar-overdue h-2.5 w-4 rounded-sm border" aria-hidden="true" /> Vượt hạn chót</li>}
          {queueWait > 0 && <li className="flex items-center gap-1.5"><span className="gantt-wait h-2.5 w-4 rounded-sm" aria-hidden="true" /> Thời gian chờ</li>}
          {!!completedTasks.length && <li className="flex items-center gap-1.5"><span className="mx-1 size-2 rotate-45 bg-emerald-400" aria-hidden="true" /> Hoàn thành thực tế</li>}
          {deadlineBoundary !== null && deadline !== null && <li className="flex items-center gap-1.5"><span className="mx-1 h-3 border-l border-dashed border-amber-400" aria-hidden="true" /> Hết hạn ngày {formatDate(deadline)}</li>}
          {recovery?.replanning_start_date && <li className="flex items-center gap-1.5"><span className="mx-1 h-3 border-l-2 border-sky-400" aria-hidden="true" />
            Lập lại lịch từ {formatDate(recovery.replanning_start_date)} · Tiến độ đến hết {formatDate(recovery.progress_as_of_date)}
          </li>}
        </ul>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Chế độ xem Gantt">
          <button type="button" className="button aria-pressed:border-[var(--accent-border)] aria-pressed:text-[var(--accent)]"
            aria-pressed={viewMode === "tasks"} onClick={() => setViewMode("tasks")}>Theo công việc</button>
          <button type="button" className="button aria-pressed:border-[var(--accent-border)] aria-pressed:text-[var(--accent)]"
            aria-pressed={viewMode === "members"} onClick={() => setViewMode("members")}>Theo thành viên</button>
        </div>
      </div>
      <p className="helper min-[760px]:hidden">Cuộn ngang để xem thêm ngày.</p>
      <div className="panel overflow-x-auto" role="region" aria-label="Biểu đồ Gantt" tabIndex={0}>
        <div className="divide-y divide-zinc-800" style={{ minWidth: width }}>
          <div className="gantt-row gantt-axis">
            <span className="gantt-label px-3 py-2 text-xs font-medium text-zinc-300">
              {viewMode === "members" ? "Thành viên · Khối lượng" : "Công việc · Người phụ trách"}
            </span>
            <div className="gantt-lane min-h-9 font-mono text-[11px] text-zinc-300">
              {grid}
              {ticks.map(({ day, label }) => label && (
                <span key={day} className="absolute top-2 whitespace-nowrap pl-1.5" style={{ left: position(day) }}>{label}</span>
              ))}
            </div>
          </div>
          {viewMode === "members" ? (
            swimlanes.map((lane) => (
              <div key={lane.memberId} className="gantt-row">
                <div className="gantt-label px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span className={`member-dot member-tone-${lane.colorIndex}`} aria-hidden="true" />
                    <span>{lane.memberName}</span>
                  </div>
                  <div className="mt-0.5 text-zinc-400">
                    {lane.scheduled.length + lane.completed.length} việc · {lane.totalDays} ngày
                    {lane.totalWaitDays > 0 && ` · Chờ ${lane.totalWaitDays} ngày`}
                  </div>
                  {lane.overdueTaskCount > 0 && (
                    <span className="badge badge-danger mt-1">{lane.overdueTaskCount} việc vượt hạn</span>
                  )}
                </div>
                <div className="gantt-lane min-h-12" role="img" tabIndex={0}
                  aria-label={`${lane.memberName} · ${lane.scheduled.length + lane.completed.length} công việc · ${lane.totalDays} ngày`}>
                  {grid}
                  {lane.scheduled.map((task) => {
                    const split = splitDeadlineInterval(task.start_day, task.end_day, deadlineBoundary);
                    const dates = `${formatDate(dateAtOffset(start, task.start_day))} – ${formatDate(dateAtOffset(start, task.end_day - 1))}`;
                    const tip = `${task.id} · ${task.name}\n${dates} (${task.duration} ngày)${task.dependencies.length ? `\nTiên quyết: ${task.dependencies.join(", ")}` : ""}${split.overdueDays > 0 ? `\nVượt hạn ${split.overdueDays} ngày` : ""}`;
                    return (
                      <span key={task.id} className="contents">
                        {task.queue_wait_days > 0 && (
                          <span className="gantt-wait absolute top-1/2 h-5 -translate-y-1/2 rounded-sm"
                            title={`${task.id} chờ ${task.queue_wait_days} ngày`}
                            style={{ left: position(task.earliest_ready_day), width: position(task.queue_wait_days) }} />
                        )}
                        {split.onTime && (
                          <span className={`gantt-bar gantt-swimlane-bar member-tone-${lane.colorIndex} absolute top-1/2 h-5 min-w-px -translate-y-1/2 rounded-sm border`}
                            title={tip}
                            style={{ left: position(split.onTime.start), width: position(split.onTime.width) }} />
                        )}
                        {split.overdue && (
                          <span className="gantt-bar-overdue gantt-swimlane-bar absolute top-1/2 h-5 min-w-px -translate-y-1/2 rounded-sm border"
                            title={tip}
                            style={{ left: position(split.overdue.start), width: position(split.overdue.width) }} />
                        )}
                        <span className="gantt-bar-label absolute top-1/2 -translate-y-1/2 font-mono text-[10px] font-semibold"
                          title={tip}
                          style={{ left: position(task.start_day), width: position(task.end_day - task.start_day) }}>
                          {task.id}
                        </span>
                      </span>
                    );
                  })}
                  {lane.completed.map((task) => (
                    <span key={task.id} aria-hidden="true"
                      className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-emerald-400"
                      title={`${task.id} · ${task.name} · Hoàn thành ${formatDate(task.actual_finish_date)}`}
                      style={{ left: position(task.actual_end_day_exclusive - 0.5) }} />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <>
              {completedTasks.map((task) => {
                const overdue = deadlineBoundary !== null && task.actual_end_day_exclusive > deadlineBoundary;
                const plannedTask = taskById.get(task.id);
                const category = plannedTask ? taskCategory(plannedTask) : "";
                return (
                  <div key={task.id} className="gantt-row">
                    <div className="gantt-label gantt-label-card"
                      title={`${task.id} · ${task.name}\n${memberById.get(task.assignee_id) ?? ""} · Hoàn thành thực tế ${formatDate(task.actual_finish_date)}`}>
                      <div className="gantt-row-head">
                        <div className="gantt-title-wrap">
                          <span className="gantt-id">{task.id}</span>
                          <span className="gantt-name">{task.name}</span>
                        </div>
                        {category && <span className="gantt-cat">{category}</span>}
                      </div>
                      <div className="gantt-row-time">
                        <span className="truncate text-zinc-400">{memberById.get(task.assignee_id)}</span>
                        <span className={`shrink-0 tabular-nums ${overdue ? "text-rose-300" : "text-emerald-300"}`}>
                          Done {formatDate(task.actual_finish_date)}
                        </span>
                      </div>
                    </div>
                    <div className="gantt-lane" role="img" tabIndex={0} title={`Hoàn thành thực tế · ${formatDate(task.actual_finish_date)}`}
                      aria-label={`${task.name} · Hoàn thành thực tế ${formatDate(task.actual_finish_date)}`}>
                      {grid}
                      <span aria-hidden="true" className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] ${overdue ? "bg-rose-400" : "bg-emerald-400"}`}
                        style={{ left: position(task.actual_end_day_exclusive - 0.5) }} />
                    </div>
                  </div>
                );
              })}
              {scheduledTasks.map((task) => {
                const plannedTask = taskById.get(task.id);
                const category = plannedTask ? taskCategory(plannedTask) : task.kanban_stage;
                const member = memberById.get(task.assignee_id ?? "") ?? "Chưa phân công";
                const tone = memberColorIndex(task.assignee_id, members.length ? members : plan.members);
                const split = splitDeadlineInterval(task.start_day, task.end_day, deadlineBoundary);
                // Solver intervals are [start_day, end_day). Show the last occupied calendar date.
                const startIso = dateAtOffset(start, task.start_day);
                const endIso = dateAtOffset(start, task.end_day - 1);
                const dates = `${formatDate(startIso)} – ${formatDate(endIso)}`;
                const compactDates = shortDateRange(startIso, endIso, start.slice(0, 4));
                const duration = recovery && plannedTask?.status === "Doing"
                  ? `Còn ${task.duration} ngày · Ước tính ban đầu: ${plannedTask.duration} ngày`
                  : `Dự kiến ${task.duration} ngày`;
                const compactDuration = recovery && plannedTask?.status === "Doing"
                  ? `Còn ${task.duration} ngày`
                  : `${task.duration} ngày`;
                const timing = `${dates} · ${duration}`;
                const barTip = `${task.id} · ${task.name}\n${category} · ${member} · ${timing}\n${task.dependencies.length ? `Tiên quyết: ${task.dependencies.join(", ")}` : "Không có công việc tiên quyết"}${split.overdueDays > 0 ? `\nVượt hạn chót ${split.overdueDays} ngày` : ""}`;
                return (
                  <div key={task.id} className="gantt-row">
                    <div className="gantt-label gantt-label-card" title={barTip}>
                      <div className="gantt-row-head">
                        <div className="gantt-title-wrap">
                          <span className="gantt-id">{task.id}</span>
                          <span className="gantt-name">{task.name}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="gantt-cat">{category}</span>
                          {split.overdueDays > 0 && <span className="badge badge-danger">Trễ {split.overdueDays}n</span>}
                        </div>
                      </div>
                      <div className="gantt-row-sub">
                        <span className="flex min-w-0 items-center gap-1.5 text-zinc-300">
                          <span className={`member-dot member-tone-${tone}`} aria-hidden="true" />
                          <span className="truncate">{member}</span>
                        </span>
                        {task.dependencies.length > 0 && (
                          <span className="gantt-deps-inline">← {task.dependencies.join(", ")}</span>
                        )}
                      </div>
                      <div className="gantt-row-time">
                        <span className="tabular-nums text-zinc-400">{compactDates}</span>
                        <span className="shrink-0 tabular-nums text-zinc-300">{compactDuration}</span>
                      </div>
                    </div>
                    <div className="gantt-lane" role="img" tabIndex={0}
                      aria-label={`${task.name} · ${member} · ${timing}${task.queue_wait_days ? ` · Chờ ${task.queue_wait_days} ngày` : ""}${split.overdueDays ? ` · Vượt hạn ${split.overdueDays} ngày` : ""}`}>
                      {grid}
                      {task.queue_wait_days > 0 && (
                        <span className="gantt-wait absolute top-1/2 h-4 -translate-y-1/2 rounded-sm"
                          title={`Chờ ${task.queue_wait_days} ngày kể từ khi sẵn sàng`}
                          style={{ left: position(task.earliest_ready_day), width: position(task.queue_wait_days) }} />
                      )}
                      {split.onTime && (
                        <span className={`gantt-bar member-tone-${tone} absolute top-1/2 h-4 min-w-px -translate-y-1/2 rounded-sm border`}
                          title={barTip}
                          style={{ left: position(split.onTime.start), width: position(split.onTime.width) }} />
                      )}
                      {split.overdue && (
                        <span className="gantt-bar-overdue absolute top-1/2 h-4 min-w-px -translate-y-1/2 rounded-sm border"
                          title={barTip}
                          style={{ left: position(split.overdue.start), width: position(split.overdue.width) }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
