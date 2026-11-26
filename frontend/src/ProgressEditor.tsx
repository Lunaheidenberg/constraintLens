import { ArrowRight, ClipboardList, LoaderCircle } from "lucide-react";
import { dateAtOffset, formatDate, parseDateInput } from "./calendar";
import { DateField } from "./DateField";
import type { Plan } from "./plans";
import { parseRemainingDuration, plannedRemainingDays, remainingDurationDifference } from "./progressReport";
import type { todoTasksDueForReview } from "./progressReview";
import type { CompletedTask, KanbanStatus, ProjectCalendar, Task } from "./types";

const STATUS_OPTIONS: KanbanStatus[] = ["To Do", "Doing", "Done"];

interface ProgressEditorProps {
  acceptedPlan: Plan | null;
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
  hasPendingEdits: boolean;
  confirmedAsOf: string;
  todoReview: ReturnType<typeof todoTasksDueForReview>;
  todoConfirmed: boolean;
  onConfirmTodo: (confirmed: boolean) => void;
  onOpenKanban: () => void;
  onOpenPlanning: () => void;
  onStatusChange: (index: number, status: KanbanStatus) => void;
  onDateChange: (date: string) => void;
  onEntryChange: (id: string, value: string) => void;
  onRequest: (solve: boolean) => void;
}

export function ProgressEditor(props: ProgressEditorProps) {
  const { acceptedPlan, calendar, tasks, asOf, asOfInput, minimumAsOf, completed, entries, phase, feedback, todoReview, todoConfirmed } = props;
  const nextDate = asOf && asOf >= minimumAsOf && asOf < "9999-12-31" ? dateAtOffset(asOf, 1) : null;
  const plannedDays = plannedRemainingDays(acceptedPlan, nextDate ? asOf : "");
  const replanning = phase === "rescheduling" || phase === "preparingRecovery";
  const needsReview = todoReview.length > 0 && !todoConfirmed;
  const canUseReportDate = !!asOf && (!calendar.project_start_date || asOf >= calendar.project_start_date);
  const reportDateDisplay = canUseReportDate ? formatDate(asOf) : "";
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  return (
    <section className="panel section-pad space-y-3" aria-labelledby="progress-heading">
      <h3 id="progress-heading" tabIndex={-1} className="section-title">
        <ClipboardList size={16} className="section-icon" aria-hidden="true" /> Báo cáo tiến độ
      </h3>
      {!acceptedPlan ? (
        <div className="empty-state items-center justify-between flex-wrap">
          <p>Chưa có lịch tham chiếu. Tính và chấp nhận lịch ban đầu để lập lại lịch theo tiến độ.</p>
          <button className="button" onClick={props.onOpenPlanning}>Đến mục Lập lịch <ArrowRight size={14} aria-hidden="true" /></button>
        </div>
      ) : (
        <div className="space-y-3">
          {props.hasPendingEdits && <div className="notice warning" role="status">
            <p className="font-medium">Báo cáo tiến độ có thay đổi chưa được áp dụng.</p>
            {props.confirmedAsOf && <p>Báo cáo gần nhất đã xác nhận đến hết <time dateTime={props.confirmedAsOf}>{formatDate(props.confirmedAsOf)}</time>.</p>}
            <p>Chọn Đề xuất lịch mới để xác nhận báo cáo và tính lịch. Kiểm tra tiến độ chỉ kiểm tra dữ liệu.</p>
          </div>}
          <div className="progress-dates">
            <DateField label="Tiến độ xác nhận đến hết ngày" value={asOfInput} min={minimumAsOf || undefined} max="9999-12-30"
              quickToday onChange={props.onDateChange} describedBy="reporting-boundary" />
            <div id="reporting-boundary" className="progress-boundary">
              <p className="helper">Bắt đầu lịch mới</p>
              <p className="font-medium tabular-nums">{nextDate ? formatDate(nextDate) : "Ngày kế tiếp ngày báo cáo"}</p>
            </div>
          </div>
          <div className="helper">
            <p id="remaining-duration-help">Nhập tổng số ngày công việc còn cần để hoàn thành, không chỉ số ngày phát sinh thêm.</p>
            <p>Có thể đổi trạng thái trực tiếp tại cột Trạng thái và dùng nút điền nhanh bên cạnh.</p>
          </div>
          <div className="panel overflow-x-auto" role="region" aria-label="Tiến độ công việc" tabIndex={0}>
            <table className="data-table w-full min-w-[620px] table-fixed text-left">
              <colgroup><col /><col className="w-24 sm:w-28" /><col className="w-[21%]" /><col className="w-[31%]" /></colgroup>
              <thead className="table-head border-b border-zinc-800">
                <tr>
                  <th scope="col" className="p-2">Công việc</th>
                  <th scope="col" className="p-2">Trạng thái</th>
                  <th scope="col" className="p-2">Còn theo kế hoạch</th>
                  <th scope="col" className="p-2">Còn lại thực tế</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {tasks.map((task, index) => {
                  const status = task.status ?? "To Do";
                  const confirmed = completed.get(task.id);
                  const value = entries.get(task.id) ?? "";
                  const planned = plannedDays.get(task.id);
                  const actual = parseRemainingDuration(value);
                  const difference = remainingDurationDifference(planned, actual);
                  const invalid = value !== "" && actual === null;
                  const errorId = `remaining-duration-error-${task.id}`;
                  return (
                    <tr key={task.id} className="align-top">
                      <th scope="row" className="break-words p-2 font-medium">
                        <span className="mr-2 font-mono text-zinc-400">{task.id}</span>{task.name}
                        {status === "Doing" && <span className="helper mt-1 block font-normal">Ước tính ban đầu: {task.duration} ngày</span>}
                      </th>
                      <td className="p-2">
                        {confirmed ? (
                          <span className="badge badge-success">Done</span>
                        ) : (
                          <select className="control progress-status-select" aria-label={`Trạng thái báo cáo của ${task.id}`}
                            value={status} onChange={(event) => props.onStatusChange(index, event.target.value as KanbanStatus)}>
                            {STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                          </select>
                        )}
                      </td>
                      {status === "Doing" && !confirmed ? (
                        <>
                          <td className="break-words p-2 tabular-nums">
                            {planned === undefined ? <span className="helper">Chưa có lịch tham chiếu</span> : `${planned} ngày`}
                          </td>
                          <td className="break-words p-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <div className="progress-stepper">
                                <button type="button" className="button quiet icon-button progress-step-btn"
                                  aria-label={`Giảm số ngày còn lại của ${task.id}`}
                                  disabled={(actual ?? 1) <= 1}
                                  onClick={() => props.onEntryChange(task.id, String(Math.max(1, (actual ?? planned ?? 2) - 1)))}>−</button>
                                <input type="number" min={1} step={1} inputMode="numeric" className="control w-16 text-center tabular-nums"
                                  aria-label={`Số ngày thực tế còn lại của ${task.id}`} value={value}
                                  aria-invalid={invalid || undefined}
                                  aria-describedby={invalid ? `remaining-duration-help ${errorId}` : "remaining-duration-help"}
                                  onChange={(event) => props.onEntryChange(task.id, event.target.value)} />
                                <button type="button" className="button quiet icon-button progress-step-btn"
                                  aria-label={`Tăng số ngày còn lại của ${task.id}`}
                                  onClick={() => props.onEntryChange(task.id, String((actual ?? planned ?? 0) + 1))}>+</button>
                              </div>
                              {planned !== undefined && planned >= 1 && actual !== planned && (
                                <button type="button" className="text-link progress-quick-btn"
                                  onClick={() => props.onEntryChange(task.id, String(planned))}>
                                  Theo kế hoạch ({planned} ngày)
                                </button>
                              )}
                              {invalid && <p className="date-error" id={errorId}>Nhập số nguyên dương.</p>}
                              {difference !== null && (
                                <span className={`badge ${difference > 0 ? "badge-warning" : difference < 0 ? "badge-success" : ""}`}>
                                  {difference > 0 ? `+${difference} ngày so với kế hoạch`
                                    : difference < 0 ? `Ít hơn kế hoạch ${-difference} ngày` : "Không thay đổi"}
                                </span>
                              )}
                            </div>
                          </td>
                        </>
                      ) : <td colSpan={2} className="p-2">
                        {confirmed ? <span className="badge badge-success">Đã xác nhận · {formatDate(confirmed.actual_finish_date)}</span>
                          : status === "Done" ? (() => {
                            let latestDepFinish = "";
                            let latestDepId = "";
                            for (const depId of task.dependencies) {
                              const depConfirmed = completed.get(depId)?.actual_finish_date;
                              const depTask = taskById.get(depId);
                              const depDraft = depTask?.status === "Done" ? parseDateInput(entries.get(depId) ?? "") : null;
                              const depFinish = depConfirmed ?? depDraft ?? "";
                              if (depFinish && depFinish > latestDepFinish) {
                                latestDepFinish = depFinish;
                                latestDepId = depId;
                              }
                            }
                            const earliestAfterDep = latestDepFinish && latestDepFinish < "9999-12-31"
                              ? dateAtOffset(latestDepFinish, 1)
                              : "";
                            const minFinishDate = earliestAfterDep && (!calendar.project_start_date || earliestAfterDep > calendar.project_start_date)
                              ? earliestAfterDep
                              : calendar.project_start_date;
                            const canQuickFillReportDate = canUseReportDate && value.trim() !== reportDateDisplay && (!minFinishDate || asOf >= minFinishDate);
                            const showDepHint = Boolean(latestDepFinish && earliestAfterDep && (!asOf || asOf <= latestDepFinish));
                            return (
                              <div className="progress-done-row">
                                <div className="progress-done-field">
                                  <DateField label={`Ngày hoàn thành thực tế của ${task.id}`}
                                    min={minFinishDate || undefined} max={asOf || undefined} value={value}
                                    onChange={(value) => props.onEntryChange(task.id, value)} />
                                </div>
                                {(canQuickFillReportDate || showDepHint) && (
                                  <div className="progress-done-hint">
                                    {canQuickFillReportDate && (
                                      <button type="button" className="button progress-quick-chip"
                                        onClick={() => props.onEntryChange(task.id, reportDateDisplay)}>
                                        Dùng ngày báo cáo ({reportDateDisplay})
                                      </button>
                                    )}
                                    {showDepHint && (
                                      <p className="progress-dep-hint">
                                        Phải sau ngày hoàn thành của {latestDepId} ({formatDate(latestDepFinish)}), từ {formatDate(earliestAfterDep)} trở đi.
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })()
                          : <span className="text-zinc-400">{task.duration} ngày theo ước tính</span>}
                      </td>}
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
            <button className="button primary schedule-action" disabled={!props.canRequest || needsReview}
              aria-describedby={needsReview ? "progress-review-heading" : undefined} onClick={() => props.onRequest(true)}>
              {replanning && <LoaderCircle size={15} className="busy-icon" aria-hidden="true" />}
              {replanning ? props.pendingMessage : "Đề xuất lịch mới"}
            </button>
            <button className="button quiet" disabled={!props.canRequest} onClick={() => props.onRequest(false)}>Kiểm tra tiến độ</button>
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
