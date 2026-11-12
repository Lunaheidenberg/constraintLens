import type { RefObject } from "react";
import { dateAtOffset, formatDate, isCalendarDate } from "./calendar";
import type { CompletedTask, ProjectCalendar, Task } from "./types";

interface ProgressEditorProps {
  panelRef: RefObject<HTMLDetailsElement>;
  hasAcceptedPlan: boolean;
  calendar: ProjectCalendar;
  tasks: Task[];
  asOf: string;
  minimumAsOf: string;
  entries: ReadonlyMap<string, string>;
  completed: ReadonlyMap<string, CompletedTask>;
  canRequest: boolean;
  projectNeedsCorrections: boolean;
  phase: "checkingProgress" | "rescheduling" | null;
  feedback: { message: string; errors: string[] } | null;
  hasProposal: boolean;
  onDateChange: (date: string) => void;
  onEntryChange: (id: string, value: string) => void;
  onRequest: (solve: boolean) => void;
}

export function ProgressEditor(props: ProgressEditorProps) {
  const { calendar, tasks, asOf, minimumAsOf, completed, entries, phase, feedback } = props;
  const nextDate = isCalendarDate(asOf) && asOf < "9999-12-31" ? dateAtOffset(asOf, 1) : null;
  const dateError = asOf && (!nextDate ? "Chọn ngày báo cáo có ngày kế tiếp hợp lệ." : asOf < minimumAsOf
    ? `Ngày báo cáo phải từ ${formatDate(minimumAsOf)} trở đi.` : "");
  return (
    <details ref={props.panelRef} className="panel" aria-labelledby="progress-heading">
      <summary id="progress-heading" className="cursor-pointer rounded-md px-3 py-2.5 text-sm font-semibold">
        Cập nhật tiến độ và lập lại lịch
      </summary>
      {!props.hasAcceptedPlan ? (
        <p className="border-t border-zinc-800 px-3 py-3 text-xs text-zinc-400">Tính và chấp nhận lịch ban đầu để lập lại lịch theo tiến độ.</p>
      ) : (
        <div className="space-y-3 border-t border-zinc-800 p-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <label className="field">Tiến độ xác nhận đến hết ngày
              <input type="date" className="control" min={minimumAsOf || undefined} max="9999-12-30"
                value={asOf} aria-describedby="reporting-boundary" onChange={(event) => props.onDateChange(event.target.value)} />
            </label>
            <p id="reporting-boundary" className={`pb-1 text-xs ${dateError ? "text-amber-200" : "text-zinc-300"}`}>
              {dateError || (nextDate ? `Lập lại lịch từ ${formatDate(nextDate)}.` : "Công việc còn lại bắt đầu sớm nhất vào ngày kế tiếp.")}
            </p>
          </div>
          <p className="text-xs text-zinc-400">Trạng thái lấy từ Kanban. Nhập số ngày còn lại cho Doing và xác nhận ngày hoàn thành thực tế cho Done.</p>
          <div className="overflow-x-auto" role="region" aria-label="Tiến độ công việc" tabIndex={0}>
            <table className="w-full min-w-[450px] text-left text-xs">
              <thead className="border-b border-zinc-800 text-zinc-400">
                <tr><th scope="col" className="p-2">Công việc</th><th scope="col" className="p-2">Trạng thái</th><th scope="col" className="p-2">Thông tin tiến độ</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {tasks.map((task) => {
                  const status = task.status ?? "To Do";
                  const confirmed = completed.get(task.id);
                  return (
                    <tr key={task.id}>
                      <th scope="row" className="p-2 font-medium"><span className="mr-2 font-mono text-zinc-400">{task.id}</span>{task.name}</th>
                      <td className="whitespace-nowrap p-2">{status}</td>
                      <td className="w-48 p-2">
                        {confirmed ? <span className="text-emerald-300">Đã xác nhận · {formatDate(confirmed.actual_finish_date)}</span>
                          : status === "Doing" ? <input type="number" min={1} step={1} className="control w-28"
                            placeholder="Số ngày" aria-label={`Số ngày còn lại của ${task.id}`} value={entries.get(task.id) ?? ""}
                            onChange={(event) => props.onEntryChange(task.id, event.target.value)} />
                          : status === "Done" ? <input type="date" className="control"
                            min={calendar.project_start_date || undefined} max={asOf || undefined}
                            aria-label={`Ngày hoàn thành thực tế của ${task.id}`} value={entries.get(task.id) ?? ""}
                            onChange={(event) => props.onEntryChange(task.id, event.target.value)} />
                          : <span className="text-zinc-400">{task.duration} ngày theo ước tính</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="button" disabled={!props.canRequest || !nextDate || !!dateError} onClick={() => props.onRequest(false)}>Kiểm tra tiến độ</button>
            <button className="button primary" disabled={!props.canRequest || !nextDate || !!dateError} onClick={() => props.onRequest(true)}>Đề xuất lịch mới</button>
            {phase && <span role="status" className="text-xs text-zinc-300">{phase === "checkingProgress" ? "Đang kiểm tra tiến độ…" : "CP-SAT đang tính lịch mới…"}</span>}
          </div>
          {props.projectNeedsCorrections && <p className="text-xs text-amber-200">Sửa các điều kiện trong mục Lập lịch trước khi gửi tiến độ.</p>}
          {feedback && (
            <div className={`notice ${feedback.errors.length ? "text-rose-300" : "text-emerald-300"}`} role={feedback.errors.length ? "alert" : "status"}>
              <p className="font-medium">{feedback.message}</p>
              {feedback.errors.length > 0 && <ul className="mt-1 list-disc space-y-1 whitespace-pre-line pl-4">
                {feedback.errors.map((error, index) => <li key={index}>{error}</li>)}
              </ul>}
              {props.hasProposal && <a href="#schedule-proposal" className="mt-1 inline-block underline">Xem lịch đề xuất</a>}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
