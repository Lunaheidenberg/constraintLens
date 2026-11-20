/**
 * types.ts
 * --------
 * Hợp đồng dữ liệu TypeScript (Data Contracts) đồng bộ 100% với Backend:
 * models.py, solver.py và api.py.
 */

// ============================================================================
// 1. CÁC KIỂU DỮ LIỆU ĐẦU VÀO & CẤU HÌNH KANBAN (models.py)
// ============================================================================

export type KanbanStatus = 'To Do' | 'Doing' | 'Done';

export interface ProjectMember {
  id: string;
  name: string;
}

/**
 * Một công việc cụ thể trong dự án Kanban.
 * Tương ứng với class Task trong models.py.
 */
export interface Task {
  /** Mã công việc duy nhất (VD: T1, T2, T3) */
  id: string;
  /** Tên công việc */
  name: string;
  /** Thời gian thực hiện (đơn vị: ngày, số nguyên dương >= 1) */
  duration: number;
  /** Danh sách ID các công việc phải hoàn thành trước (tiên quyết) */
  dependencies: string[];
  /** Nhóm WIP cũ của bộ lập lịch (VD: Design, Backend, Testing) */
  kanban_stage: string;
  /** Nhóm chuyên môn, mặc định lấy từ kanban_stage với payload cũ */
  category?: string;
  status?: KanbanStatus;
  assignee_id?: string | null;
}

/**
 * Cấu hình quy trình Kanban và giới hạn số thẻ tối đa (WIP).
 * Tương ứng với class KanbanConfig trong models.py.
 */
export interface KanbanConfig {
  /** Danh sách các cột Kanban theo thứ tự luồng công việc */
  stages: string[];
  /** Giới hạn số thẻ tối đa (WIP Limit) cho từng cột: key là tên cột, value là giới hạn */
  wip_limits: Record<string, number>;
}

/**
 * Bản thiết kế trung gian chuẩn hóa (Scheduling Intermediate Representation).
 * Tương ứng với class SchedulingIR trong models.py.
 */
export interface SchedulingIR {
  /** Tên của đồ án/dự án */
  project_name: string;
  /** Tổng số lượng thành viên trong nhóm (>= 1) */
  team_capacity: number;
  /** Cấu hình quy trình Kanban */
  kanban_config: KanbanConfig;
  /** Danh sách toàn bộ các công việc cần làm */
  tasks: Task[];
  /** Có thể bỏ qua trong payload cũ hoặc bản nháp chưa có thành viên */
  members?: ProjectMember[];
}


// ============================================================================
// 2. KẾT QUẢ GIẢI BÀI TOÁN RCPSP & PHÂN TÍCH BOTTLENECK (solver.py)
// ============================================================================

/**
 * Thông tin chi tiết lịch trình của một task đã được giải toán.
 * Tương ứng với class ScheduledTask trong solver.py.
 */
export interface ScheduledTask {
  id: string;
  name: string;
  kanban_stage: string;
  duration: number;
  dependencies: string[];
  start_day: number;
  end_day: number;
  assignee_id: string | null;
  /** Ngày sớm nhất sau mốc lập lịch và khi mọi dependencies đã hoàn thành */
  earliest_ready_day: number;
  /** start_day - earliest_ready_day: số ngày thẻ phải chờ do nghẽn WIP hoặc thiếu người */
  queue_wait_days: number;
}

/**
 * Thống kê đo lường điểm nghẽn tại từng cột Kanban.
 * Tương ứng với class StageBottleneckMetric trong solver.py.
 */
export interface StageBottleneckMetric {
  stage_name: string;
  wip_limit: number;
  /** Tổng duration của các task thuộc cột này */
  total_task_days: number;
  /** Số task tối đa chạy song song cùng lúc trên thực tế */
  peak_concurrent_tasks: number;
  /** Tổng số ngày các task thuộc cột này phải nằm chờ */
  total_queue_wait_days: number;
  /** True nếu peak_concurrent_tasks == wip_limit VÀ total_queue_wait_days > 0 */
  is_bottleneck: boolean;
}

export type SolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'INFEASIBLE'
  | 'INVALID_INPUT'
  | 'MODEL_INVALID'
  | 'UNKNOWN';

export type SchedulingMode = 'legacy' | 'member';

/**
 * Kết quả lập lịch đầy đủ từ Google OR-Tools CP-SAT.
 * Tương ứng với class ScheduleResult trong solver.py.
 */
export interface ScheduleResult {
  scheduling_mode: SchedulingMode;
  status: SolverStatus | string;
  makespan: number;
  solve_time_ms: number;
  scheduled_tasks: ScheduledTask[];
  stage_metrics: StageBottleneckMetric[];
  bottleneck_stages: string[];
  errors: string[];
}


// ============================================================================
// 3. API REQUEST & RESPONSE PAYLOADS (api.py)
// ============================================================================

/**
 * Dữ liệu trả về khi gọi POST /api/solve.
 * Chứa kết quả solver và danh sách giải pháp What-If Counterfactual.
 */
export interface SolveResponse {
  result: ScheduleResult;
  rescue_suggestions: string[];
  calendar: CalendarFinish | null;
}

/**
 * Payload yêu cầu giải bài toán lập lịch POST /api/solve.
 * Hỗ trợ cả 2 dạng: bọc trong { ir, ... } hoặc gửi trực tiếp SchedulingIR ở root.
 */
export type SolveRequest = ({ ir: SchedulingIR } | SchedulingIR) & {
  scheduling_mode?: SchedulingMode | null;
  target_deadline?: number | null;
  calendar?: ProjectCalendar;
  time_limit_sec?: number;
};

export interface ProjectCalendar {
  project_start_date: string;
  target_deadline_date: string | null;
}

export interface CalendarFinish extends ProjectCalendar {
  project_finish_day_exclusive: number | null;
  project_finish_date_exclusive: string | null;
  final_work_date: string | null;
  deadline_status: 'on_time' | 'late' | null;
  days_late: number | null;
}

export interface ProgressSnapshot {
  progress_as_of_date: string;
  task_progress: Record<string, { remaining_duration: number } | { actual_finish_date: string }>;
}

export interface RescheduleRequest {
  ir: SchedulingIR;
  calendar: ProjectCalendar;
  progress: ProgressSnapshot;
}

export interface CompletedTask {
  id: string;
  name: string;
  assignee_id: string;
  actual_finish_date: string;
  actual_end_day_exclusive: number;
  actual_end_date_exclusive: string;
}

export interface RescheduleResult extends CalendarFinish {
  status: SolverStatus;
  progress_as_of_date: string;
  replanning_start_day: number | null;
  replanning_start_date: string | null;
  remaining_horizon_days: number | null;
  scheduled_tasks: (ScheduledTask & { start_date: string; final_work_date: string; end_date_exclusive: string })[];
  completed_tasks: CompletedTask[];
  solve_time_ms: number;
  errors: string[];
}

/**
 * Payload yêu cầu tạo bản nháp POST /api/parse/draft.
 */
export interface ParseRequest {
  prompt: string;
}

export type DraftReview = "provided" | "suggested" | "missing" | "confirmed";

export interface DraftTask {
  id: string;
  name: string;
  category: string;
  duration: number | null;
  dependencies: string[] | null;
  duration_review: DraftReview;
  dependency_review: DraftReview;
}

export interface ProjectDraft {
  project_name: string;
  tasks: DraftTask[];
}

export type QuestionID = "Q1" | "Q2" | "Q3";

export interface PlanningClarification {
  goal: string | null;
  questions: { id: QuestionID; text: string }[];
}

export interface PlanningDraftRequest extends ParseRequest {
  clarifications: { id: QuestionID; question: string; answer: string | null }[];
}

export interface PlanningSource {
  // "edited" is set locally when the user changes a draft value.
  kind: "description" | "answer" | "ai" | "unknown" | "edited";
  question_id?: QuestionID | null;
}

export interface PlanningTaskSources {
  name: PlanningSource;
  category: PlanningSource;
  duration: PlanningSource;
  dependencies: PlanningSource;
}

export interface PlanningDraftResult {
  goal: string;
  draft: ProjectDraft;
  assumptions: string[];
  uncertainties: string[];
  sources: { goal: PlanningSource; project_name: PlanningSource; tasks: Record<string, PlanningTaskSources> };
}

/**
 * Kết quả kiểm tra dữ liệu POST /api/validate.
 */
export interface ValidateResponse {
  valid: boolean;
  errors: string[];
}

/**
 * Cấu trúc kịch bản mẫu từ GET /api/presets.
 */
export interface PresetScenario {
  name: string;
  ir: SchedulingIR;
}

/**
 * Bản đồ ánh xạ kịch bản mẫu từ API: Record<tên_kịch_bản, SchedulingIR>.
 */
export type PresetsMap = Record<string, SchedulingIR>;

export type Workspace = "setup" | "planning" | "recovery";

export interface HelpSuggestion {
  topic: string;
  question: string;
}

export interface HelpAnswer {
  topic: string | null;
  answer: string;
  suggestions: HelpSuggestion[];
}

