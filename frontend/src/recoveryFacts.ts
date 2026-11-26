import { formatDate, isCalendarDate } from "./calendar.ts";
import type { RecoveryFact, RecoveryResponse } from "./recoveryApi";

function date(value: unknown) {
  return typeof value === "string" && isCalendarDate(value) ? formatDate(value) : "chưa rõ";
}

function amount(value: unknown) {
  return typeof value === "number" ? value : "chưa rõ";
}

function shift(value: unknown) {
  if (typeof value !== "number") return "chưa đủ ngày để đối chiếu";
  if (value === 0) return "giữ nguyên";
  return `${Math.abs(value)} ngày ${value < 0 ? "sớm hơn" : "muộn hơn"}`;
}

export function describeRecoveryFact({ kind, data, task_ids }: RecoveryFact, task: (id: string) => string): string {
  const tasks = task_ids.map(task).join(", ");
  switch (kind) {
    case "solver_status":
      return data.status === "OPTIMAL" ? "CP-SAT đã tìm được lịch tối ưu theo dữ liệu của bản lịch."
        : "CP-SAT đã tìm được lịch khả thi. Chưa xác định lịch tối ưu.";
    case "schedule":
      return data.completion_kind === "actual"
        ? `Dự án đã hoàn thành. Ngày hoàn thành thực tế ${date(data.final_work_date)}.`
        : `Ngày làm việc cuối dự kiến ${date(data.final_work_date)}.`;
    case "deadline":
      if (data.target_deadline_date === null) return "Chưa đặt hạn mục tiêu cho lần phân tích này.";
      return `Hạn mục tiêu ${date(data.target_deadline_date)} · ${data.status === "on_time" ? "Đúng hạn" :
        data.status === "late" ? `Trễ ${amount(data.days_late)} ngày` : "Chưa xác định"}.`;
    case "task":
      if (data.actual_finish_date) return `${tasks} hoàn thành thực tế ngày ${date(data.actual_finish_date)}.`;
      return `${tasks} dự kiến làm từ ${date(data.start_date)} đến ${date(data.final_work_date)}${
        data.remaining_duration != null ? ` · còn ${amount(data.remaining_duration)} ngày theo báo cáo` : ""}.`;
    case "dependency":
      return `${task(task_ids[1])} phụ thuộc vào ${task(task_ids[0])}${data.tight === true
        ? " và được xếp bắt đầu ngay khi việc tiên quyết kết thúc" : ""}.`;
    case "wait":
      return `${tasks} sẵn sàng từ ${date(data.ready_date)} và được xếp bắt đầu vào ${date(data.start_date)} · chờ ${amount(data.days)} ngày.`;
    case "shared_assignee": {
      const order = data.scheduled_order;
      return Array.isArray(order) && order.length > 1
        ? `Các công việc cùng người phụ trách, theo thứ tự trong lịch: ${order.map(task).join(" → ")}.`
        : `Các công việc cùng người phụ trách: ${tasks}.`;
    }
    case "parallel":
      return `${tasks} có thời gian làm song song từ ${date(data.overlap_start_date)} đến trước ${date(data.overlap_end_date_exclusive)}.`;
    case "progress":
      return `Báo cáo đến hết ngày ${date(data.progress_as_of_date)} · ${amount(data.confirmed_completion_count)} việc đã xác nhận hoàn thành · lịch còn ${amount(data.remaining_horizon_days)} ngày.`;
    case "task_change": {
      if (data.present_in_accepted === false) return `${tasks} được thêm vào đề xuất.`;
      if (data.present_in_proposal === false) return `${tasks} được bỏ khỏi đề xuất.`;
      if (data.newly_confirmed === true) return `${tasks} mới được xác nhận hoàn thành.`;
      const changes = [data.assignment_changed === true && "đổi phân công",
        (Array.isArray(data.dependencies_added) && data.dependencies_added.length ||
          Array.isArray(data.dependencies_removed) && data.dependencies_removed.length) && "đổi phụ thuộc",
        data.estimated_duration_delta !== 0 && typeof data.estimated_duration_delta === "number" && "đổi ước lượng ban đầu"];
      return `${tasks} · bắt đầu ${shift(data.start_delta_days)} · kết thúc ${shift(data.finish_delta_days)}${
        changes.filter(Boolean).map((change) => ` · ${change}`).join("")}.`;
    }
    case "schedule_change":
      if (data.no_changes === true) return "Không có thay đổi về lịch, hạn mục tiêu hoặc dữ liệu tiến độ trong lần đối chiếu này.";
      return `Ngày kết thúc ${shift(data.finish_delta_days)} · ${amount(data.moved_count)} việc đổi khoảng lịch · ${amount(data.unchanged_interval_count)} việc giữ nguyên khoảng lịch.`;
    case "attention":
      return `${tasks} có dữ kiện về thời điểm, thời lượng hoặc phụ thuộc cần xem lại.`;
  }
}

export function summarizeRecovery(
  result: RecoveryResponse,
  task: (id: string, role?: RecoveryFact["role"]) => string,
): string[] {
  const lines: string[] = [];
  const selectedRole = result.basis.selected_role;
  const scheduleFact = result.facts.find((fact) => fact.kind === "schedule" && fact.role === selectedRole);
  const deadlineFact = result.facts.find((fact) => fact.kind === "deadline" && fact.role === selectedRole);

  if (scheduleFact) {
    const finishText = date(scheduleFact.data.final_work_date);
    const base = scheduleFact.data.completion_kind === "actual"
      ? `Dự án đã hoàn thành thực tế ngày ${finishText}`
      : `Lịch dự kiến kết thúc ngày ${finishText}`;
    if (!deadlineFact) {
      lines.push(`${base}.`);
    } else if (deadlineFact.data.target_deadline_date === null) {
      lines.push(`${base} (chưa đặt hạn mục tiêu).`);
    } else if (deadlineFact.data.status === "on_time") {
      lines.push(`${base}, đáp ứng hạn mục tiêu ${date(deadlineFact.data.target_deadline_date)}.`);
    } else if (deadlineFact.data.status === "late" && typeof deadlineFact.data.days_late === "number") {
      lines.push(`${base}, trễ ${deadlineFact.data.days_late} ngày so với hạn ${date(deadlineFact.data.target_deadline_date)}.`);
    } else {
      lines.push(`${base} (hạn mục tiêu ${date(deadlineFact.data.target_deadline_date)}).`);
    }
  } else if (deadlineFact) {
    lines.push(describeRecoveryFact(deadlineFact, (id) => task(id, deadlineFact.role)));
  }

  const changeFact = result.basis.comparison === "compared"
    ? result.facts.find((fact) => fact.kind === "schedule_change")
    : undefined;
  if (changeFact) {
    if (changeFact.data.no_changes === true) {
      lines.push("Không có thay đổi về khoảng lịch, hạn mục tiêu hoặc tiến độ giữa hai bản lịch.");
    } else {
      const finishShift = shift(changeFact.data.finish_delta_days);
      const moved = typeof changeFact.data.moved_count === "number"
        ? `, có ${changeFact.data.moved_count} công việc đổi khoảng lịch`
        : "";
      lines.push(`So với lịch đối chiếu: ngày kết thúc ${finishShift}${moved}.`);
    }
  } else {
    const extraFact = result.basis.highlighted_fact_ids
      .map((id) => result.facts.find((fact) => fact.id === id))
      .find((fact): fact is RecoveryFact => Boolean(fact && fact !== scheduleFact && fact !== deadlineFact));
    if (extraFact) {
      lines.push(describeRecoveryFact(extraFact, (id) => task(id, extraFact.role)));
    }
  }

  if (!lines.length) {
    if (result.facts.length > 0) {
      const first = result.facts[0];
      lines.push(describeRecoveryFact(first, (id) => task(id, first.role)));
    } else if (result.unknowns.length > 0) {
      lines.push(result.unknowns[0].text);
    }
  }
  return lines;
}
