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
  /** Ngày sớm nhất khi mọi dependencies đã hoàn thành (0 nếu không có) */
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
  | 'MODEL_INVALID';

/**
 * Kết quả lập lịch đầy đủ từ Google OR-Tools CP-SAT.
 * Tương ứng với class ScheduleResult trong solver.py.
 */
export interface ScheduleResult {
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
}

/**
 * Payload yêu cầu giải bài toán lập lịch POST /api/solve.
 * Hỗ trợ cả 2 dạng: bọc trong { ir, ... } hoặc gửi trực tiếp SchedulingIR ở root.
 */
export type SolveRequest =
  | {
      ir: SchedulingIR;
      target_deadline?: number | null;
      time_limit_sec?: number;
    }
  | (SchedulingIR & {
      target_deadline?: number | null;
      time_limit_sec?: number;
    });

/**
 * Payload yêu cầu phân tích ngôn ngữ tự nhiên POST /api/parse.
 */
export interface ParseRequest {
  prompt: string;
  api_key?: string;
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

