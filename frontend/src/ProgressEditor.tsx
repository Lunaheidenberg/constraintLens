import { ArrowRight, ClipboardList, LoaderCircle } from "lucide-react";
import { dateAtOffset, formatDate } from "./calendar";
import { DateField } from "./DateField";
import type { todoTasksDueForReview } from "./progressReview";
import type { CompletedTask, ProjectCalendar, Task } from "./types";

interface ProgressEditorProps {
  hasAcceptedPlan: boolean;
  calendar: ProjectCalendar;
  tasks: Task[];
  asOf: string;
  asOfInput: string;
  minimumAsOf: string;
  entries: ReadonlyMap<string, string>;
  completed: ReadonlyMap<string, CompletedTask>;
  canRequest: boolean;
  projectNeedsCorrections: boolean;
  phase: "checkingProgress" | "rescheduling" | "preparingRecovery" | null;
  pendingMessage: string;
  feedback: { message: string; errors: string[] } | null;
  hasProposal: boolean;
  todoReview: ReturnType<typeof todoTasksDueForReview>;
  todoConfirmed: boolean;
  onConfirmTodo: (confirmed: boolean) => void;
  onOpenKanban: () => void;
  onOpenPlanning: () => void;
  onDateChange: (date: string) => void;
  onEntryChange: (id: string, value: string) => void;
  onRequest: (solve: boolean) => void;
}

export function ProgressEditor(props: ProgressEditorProps) {
  const { calendar, tasks, asOf, asOfInput, minimumAsOf, completed, entries, phase, feedback, todoReview, todoConfirmed } = props;
  const nextDate = asOf && asOf >= minimumAsOf && asOf < "9999-12-31" ? dateAtOffset(asOf, 1) : null;
  const replanning = phase === "rescheduling" || phase === "preparingRecovery";
  const needsReview = todoReview.length > 0 && !todoConfirmed;
  return (
    <section className="panel section-pad space-y-3" aria-labelledby="progress-heading">
      <h3 id="progress-heading" tabIndex={-1} className="section-title">
        <ClipboardList size={16} className="section-icon" aria-hidden="true" /> Báo cáo tiến độ
      </h3>
      {!props.hasAcceptedPlan ? (
        <div className="empty-state items-center justify-between flex-wrap">
          <p>Tính và chấp nhận lịch ban đầu để lập lại lịch theo tiến độ.</p>
          <button className="button" onClick={props.onOpenPlanning}>Đến mục Lập lịch <ArrowRight size={14} aria-hidden="true" /></button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="progress-dates">
            <DateField label="Tiến độ xác nhận đến hết ngày" value={asOfInput} min={minimumAsOf || undefined} max="9999-12-30"
              onChange={props.onDateChange} describedBy="reporting-boundary" />
            <div id="reporting-boundary" className="progress-boundary">
              <p className="helper">Bắt đầu lịch mới</p>
              <p className="font-medium tabular-nums">{nextDate ? formatDate(nextDate) : "Ngày kế tiếp ngày báo cáo"}</p>
            </div>
          </div>
          <p className="helper">Trạng thái lấy từ Kanban. Nhập số ngày còn lại cho Doing và xác nhận ngày hoàn thành thực tế cho Done.</p>
          <div className="panel overflow-x-auto" role="region" aria-label="Tiến độ công việc" tabIndex={0}>
            <table className="data-table w-full min-w-[480px] text-left">
              <thead className="table-head border-b border-zinc-800">
                <tr><th scope="col" className="p-2">Công việc</th><th scope="col" className="p-2">Trạng thái</th><th scope="col" className="p-2">Thông tin tiến độ</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {tasks.map((task) => {
                  const status = task.status ?? "To Do";
                  const confirmed = completed.get(task.id);
                  return (
                    <tr key={task.id}>
                      <th scope="row" className="p-2 font-medium"><span className="mr-2 font-mono text-zinc-400">{task.id}</span>{task.name}</th>
                      <td className="whitespace-nowrap p-2">
                        <span className={`badge ${status === "Done" ? "badge-success" : status === "Doing" ? "badge-accent" : ""}`}>{status}</span>
                      </td>
                      <td className="w-48 p-2">
                        {confirmed ? <span className="badge badge-success">Đã xác nhận · {formatDate(confirmed.actual_finish_date)}</span>
                          : status === "Doing" ? <input type="number" min={1} step={1} className="control w-28"
                            placeholder="Số ngày" aria-label={`Số ngày còn lại của ${task.id}`} value={entries.get(task.id) ?? ""}
                            onChange={(event) => props.onEntryChange(task.id, event.target.value)} />
                          : status === "Done" ? <DateField hideLabel label={`Ngày hoàn thành thực tế của ${task.id}`}
                            min={calendar.project_start_date || undefined} max={asOf || undefined} value={entries.get(task.id) ?? ""}
                            onChange={(value) => props.onEntryChange(task.id, value)} />
                          : <span className="text-zinc-400">{task.duration} ngày theo ước tính</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {todoReview.length > 0 && (
            <section className="notice warning progress-review" aria-labelledby="progress-review-heading">
              <h4 id="progress-review-heading" className="font-semibold">Xác nhận công việc chưa bắt đầu</h4>
              <p role="status">{todoReview.length} công việc đã đến ngày bắt đầu dự kiến và vẫn ở trạng thái To Do. Hãy kiểm tra tiến độ thực tế.</p>
              <ul className="review-list">
                {todoReview.map(({ id, name, plannedStart }) => (
                  <li key={id}>
                    <span className="min-w-0 break-words font-medium">{name}</span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <time dateTime={plannedStart}>{formatDate(plannedStart)}</time>
                      <span className="badge">To Do</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="section-bar">
                <label className="review-confirmation">
                  <input type="checkbox" checked={todoConfirmed} onChange={(event) => props.onConfirmTodo(event.target.checked)} />
                  Tôi xác nhận các công việc trên chưa bắt đầu
                </label>
                <button type="button" className="button quiet" onClick={props.onOpenKanban}>Cập nhật trên Kanban</button>
              </div>
            </section>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="button" disabled={!props.canRequest} onClick={() => props.onRequest(false)}>Kiểm tra tiến độ</button>
            <button className="button primary schedule-action" disabled={!props.canRequest || needsReview}
              aria-describedby={needsReview ? "progress-review-heading" : undefined} onClick={() => props.onRequest(true)}>
              {replanning && <LoaderCircle size={15} className="busy-icon" aria-hidden="true" />}
              {replanning ? props.pendingMessage : "Đề xuất lịch mới"}
            </button>
            {phase === "checkingProgress" && <span className="helper">{props.pendingMessage}</span>}
          </div>
          {props.projectNeedsCorrections && <p className="notice warning">Sửa các điều kiện trong mục <button className="underline" onClick={props.onOpenPlanning}>Lập lịch</button> trước khi gửi tiến độ.</p>}
          {!asOfInput && <p className="helper">Chọn ngày báo cáo để kiểm tra tiến độ hoặc đề xuất lịch mới.</p>}
          {feedback && (
            <div className={`notice ${feedback.errors.length ? "error" : "success"}`} role={feedback.errors.length ? "alert" : undefined}>
              <p className="font-medium">{feedback.message}</p>
              {feedback.errors.length > 0 && <ul className="mt-1 list-disc space-y-1 whitespace-pre-line pl-4">
                {feedback.errors.map((error, index) => <li key={index}>{error}</li>)}
              </ul>}
              {props.hasProposal && <a href="#schedule-proposal" className="mt-1 inline-block underline">Xem lịch đề xuất</a>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
