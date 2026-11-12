import { useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { formatDate } from "./calendar";
import { comparePlans, hasTaskChange, type ScheduleComparison, type TaskComparison } from "./comparison";
import { ComparisonTimeline, taskTiming } from "./ComparisonTimeline";
import { comparisonPair, type ComparisonReference, type PlanState } from "./plans";

const LABELS = {
  proposal: { previous: "Lịch đang áp dụng", revised: "Lịch đề xuất" },
  previous: { previous: "Lịch trước đó", revised: "Lịch đã chấp nhận hiện tại" },
  baseline: { previous: "Lịch gốc", revised: "Lịch đã chấp nhận hiện tại" },
};
const FILTERS = { all: "Tất cả", changed: "Có thay đổi", completed: "Đã hoàn thành" };
type Filter = keyof typeof FILTERS;

function signed(days: number) {
  return days > 0 ? `+${days}` : String(days);
}

function dayChange(days: number | null) {
  if (days === null) return "Chưa có dữ liệu";
  if (days === 0) return "Không đổi";
  return `${Math.abs(days)} ngày ${days < 0 ? "sớm hơn" : "muộn hơn"}`;
}

function deadlineLabel(result: NonNullable<ScheduleComparison["deadline"]>["revised"]) {
  if (!result) return "Chưa rõ";
  return result.status === "on_time" ? "Đúng hạn" : `Trễ ${result.daysLate} ngày`;
}

function ComparisonSummary({ comparison, labels }: {
  comparison: ScheduleComparison;
  labels: typeof LABELS.previous;
}) {
  const { previousFinish, revisedFinish, finishDelta, deadline, remainingHorizon } = comparison;
  const dates = [[labels.previous, previousFinish], [labels.revised, revisedFinish]] as const;
  const tone = finishDelta === null || finishDelta === 0 ? "text-zinc-200" : finishDelta > 0 ? "text-amber-200" : "text-emerald-300";
  return (
    <div className="space-y-2">
      <dl className="metric-strip">
        {dates.map(([label, finish]) => (
          <div key={label}>
            <dt className="text-xs text-zinc-400">{label}</dt>
            <dd className="text-sm font-semibold tabular-nums">{finish.finalDate ? formatDate(finish.finalDate) : "Chưa có dữ liệu"}</dd>
            <dd className="text-[11px] text-zinc-400">{finish.actual ? "Ngày hoàn thành thực tế" : "Ngày làm việc cuối"}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-zinc-400">Thay đổi ngày kết thúc</dt>
          <dd className={`mt-0.5 text-sm font-semibold ${tone}`}>{dayChange(finishDelta)}</dd>
          {remainingHorizon !== null && <dd className="text-[11px] text-zinc-400">Khoảng lịch còn lại · {remainingHorizon} ngày</dd>}
        </div>
        <div>
          <dt>Công việc thay đổi</dt>
          <dd className="text-sm font-semibold tabular-nums">{comparison.tasks.filter(hasTaskChange).length} / {comparison.tasks.length}</dd>
          <dd className="text-[11px] text-zinc-400">{comparison.movedCount} đổi khoảng lịch</dd>
        </div>
      </dl>
      {deadline ? (
        <div className="notice flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold">Hạn mục tiêu {formatDate(deadline.target)}</span>
          <span className="text-zinc-400">{labels.previous} · {deadlineLabel(deadline.previous)}</span>
          <span className={`badge ${deadline.revised?.status === "late" ? "badge-warning" : deadline.revised ? "badge-success" : ""}`}>
            {labels.revised} · {deadlineLabel(deadline.revised)}
          </span>
          {deadline.latenessDelta !== null && <span className="text-zinc-400">
            Chênh lệch số ngày trễ · {signed(deadline.latenessDelta)} ngày
          </span>}
        </div>
      ) : <p className="text-xs text-zinc-400">Chưa đặt hạn mục tiêu cho lịch so sánh.</p>}
      <p className="text-xs text-zinc-300">
        {comparison.movedCount} công việc đổi lịch · {comparison.unchangedCount} giữ nguyên lịch · {comparison.confirmedCount} đã xác nhận hoàn thành
        {comparison.newlyConfirmedCount > 0 && ` (${comparison.newlyConfirmedCount} mới)`}
      </p>
    </div>
  );
}

function taskClassifications(task: TaskComparison) {
  const labels = [];
  if (task.moved) labels.push("Đổi lịch");
  if (task.unchanged) labels.push("Giữ nguyên lịch");
  if (task.durationChanged) {
    labels.push(`Đổi thời lượng (${task.previous?.interval?.duration} → ${task.revised?.interval?.duration} ngày)`);
  }
  if (task.confirmed) labels.push(task.newlyConfirmed ? "Mới xác nhận hoàn thành" : "Đã xác nhận hoàn thành");
  if (task.assigneeChanged) labels.push("Đổi thông tin phân công");
  if (!task.previous) labels.push("Mới thêm");
  if (!task.revised) labels.push("Đã bỏ");
  return labels.length ? labels.join(" · ") : "Thiếu ngày dự kiến để đối chiếu";
}

function ComparisonDetails({ comparison, labels }: {
  comparison: ScheduleComparison;
  labels: typeof LABELS.previous;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = filter === "all" ? comparison.tasks :
    comparison.tasks.filter(filter === "changed" ? hasTaskChange : (task) => task.confirmed);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Chi tiết thay đổi</p>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Lọc thay đổi công việc">
          {(Object.keys(FILTERS) as Filter[]).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value}
              className="button aria-pressed:border-indigo-400/70 aria-pressed:text-indigo-200"
              onClick={() => setFilter(value)}>{FILTERS[value]}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <p className="notice text-zinc-400" role="status">
        {filter === "changed" ? "Không có công việc thay đổi." : filter === "completed" ? "Chưa có công việc đã xác nhận hoàn thành." : "Không có công việc để so sánh."}
      </p> : (
        <div className="panel overflow-x-auto" role="region" aria-label="Bảng thay đổi công việc" tabIndex={0}>
          <table className="data-table w-full min-w-[730px] text-left">
            <thead className="table-head">
              <tr>
                {["Công việc", labels.previous, labels.revised, "Chênh lệch ngày", "Thay đổi"].map((label) => (
                  <th key={label} scope="col" className="px-3 py-2 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 border-t border-zinc-800">
              {rows.map((task) => (
                <tr key={task.id}>
                  <th scope="row" className="px-3 py-2 font-medium">
                    <span className="mr-1.5 font-mono text-zinc-400">{task.id}</span>{task.revised?.name ?? task.previous?.name}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{taskTiming(task.previous)}</td>
                  <td className={`whitespace-nowrap px-3 py-2 ${task.confirmed ? "text-emerald-300" : "text-zinc-300"}`}>{taskTiming(task.revised)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-300">
                    {task.startDelta !== null && task.finishDelta !== null ? (
                      <>Bắt đầu {signed(task.startDelta)}<br />Kết thúc {signed(task.finishDelta)}</>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{taskClassifications(task)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PlanComparison({ plans }: { plans: PlanState }) {
  const [reference, setReference] = useState<ComparisonReference>("previous");
  const pair = comparisonPair(plans, reference);
  if (!pair) return <div className="empty-state">
    <GitCompareArrows size={18} aria-hidden="true" />
    <div><p className="font-medium text-zinc-100">Chưa có hai lịch để so sánh</p><p>Gửi báo cáo tiến độ và đề xuất lịch mới để xem thay đổi.</p></div>
  </div>;
  const comparison = comparePlans(pair.previous, pair.revised);
  const labels = LABELS[pair.mode];
  const Heading = pair.mode === "proposal" ? "h5" : "h4";
  return (
    <section id="schedule-comparison" aria-labelledby="comparison-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Heading id="comparison-heading" className="text-sm font-semibold text-zinc-100">So sánh lịch</Heading>
          <p className="mt-0.5 text-xs text-zinc-400">
            {labels.previous} → {labels.revised} · CP-SAT {pair.revised.status}
            {pair.revised.status === "FEASIBLE" && " (chưa chứng minh tối ưu)"}
          </p>
        </div>
        {pair.mode !== "proposal" && plans.baseline && plans.baseline !== plans.previous && (
          <label className="flex items-center gap-2 text-xs text-zinc-400">Mốc so sánh
            <select className="control" value={reference} onChange={(event) => setReference(event.target.value as ComparisonReference)}>
              <option value="previous">Lịch trước đó</option>
              <option value="baseline">Lịch gốc</option>
            </select>
          </label>
        )}
      </div>
      {pair.mode !== "proposal" && plans.acceptedRevision !== plans.revision && (
        <p className="notice warning">Đang so sánh các lịch đã chấp nhận. Hãy tính lại lịch để đánh giá dữ liệu vừa chỉnh sửa.</p>
      )}
      {comparison ? (
        <>
          <ComparisonSummary comparison={comparison} labels={labels} />
          <ComparisonTimeline comparison={comparison} labels={labels} />
          <ComparisonDetails key={pair.mode} comparison={comparison} labels={labels} />
        </>
      ) : <p className="notice text-amber-200" role="status">Chưa có hai kết quả lập lịch hợp lệ để so sánh.</p>}
    </section>
  );
}
