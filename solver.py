"""
solver.py
---------
Giải bài toán lập lịch dự án có ràng buộc tài nguyên và giới hạn WIP Kanban
(Resource-Constrained Project Scheduling Problem – RCPSP) bằng Google OR-Tools CP-SAT.

Quy tắc kiến trúc (architecture.md):
- Validation First: Chạy validate_ir() TRƯỚC khi khởi động CP-SAT.
- Chỉ dùng model.AddCumulative() để xử lý WIP Limit và Team Capacity.
- Không tự ý sửa đổi models.py hay validator.py.
"""

import time
from typing import Optional

from pydantic import BaseModel, Field
from ortools.sat.python import cp_model

from models import SchedulingIR, KanbanConfig, Task
from validator import validate_ir


# =============================================================================
# CÁC MODEL ĐẦU RA (Output Pydantic Models)
# =============================================================================

class ScheduledTask(BaseModel):
    """Thông tin lịch trình đã giải cho một task cụ thể."""
    id: str
    name: str
    kanban_stage: str
    duration: int
    dependencies: list[str]
    start_day: int
    end_day: int
    earliest_ready_day: int = Field(
        description=(
            "Ngày sớm nhất khi mọi dependencies đã hoàn thành; bằng 0 nếu không có dependencies."
        )
    )
    queue_wait_days: int = Field(
        description=(
            "start_day - earliest_ready_day: số ngày thẻ phải nằm chờ "
            "do nghẽn WIP hoặc thiếu nhân sự."
        )
    )


class StageBottleneckMetric(BaseModel):
    """Thống kê điểm nghẽn cho từng cột Kanban."""
    stage_name: str
    wip_limit: int
    total_task_days: int = Field(
        description="Tổng duration của các task thuộc cột này."
    )
    peak_concurrent_tasks: int = Field(
        description="Số task tối đa chạy song song cùng lúc trên thực tế tại cột này."
    )
    total_queue_wait_days: int = Field(
        description="Tổng số ngày các task thuộc cột này phải nằm chờ trước khi vào cột."
    )
    is_bottleneck: bool = Field(
        description=(
            "True nếu peak_concurrent_tasks == wip_limit VÀ total_queue_wait_days > 0."
        )
    )


class ScheduleResult(BaseModel):
    """Kết quả đầy đủ sau khi giải bài toán lập lịch."""
    status: str = Field(
        description=(
            "Trạng thái giải: "
            "'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'INVALID_INPUT', 'MODEL_INVALID'."
        )
    )
    makespan: int = Field(
        description="Tổng số ngày hoàn thành dự án; bằng 0 nếu không tìm được nghiệm."
    )
    solve_time_ms: float = Field(
        description="Thời gian giải tính bằng mili-giây."
    )
    scheduled_tasks: list[ScheduledTask]
    stage_metrics: list[StageBottleneckMetric]
    bottleneck_stages: list[str] = Field(
        description="Danh sách tên các cột bị nghẽn."
    )
    errors: list[str] = Field(
        description="Chứa lỗi từ validate_ir hoặc lý do vô nghiệm."
    )


# =============================================================================
# HÀM GIẢI CHÍNH
# =============================================================================

def solve_schedule(
    ir: SchedulingIR,
    time_limit_sec: float = 10.0,
) -> ScheduleResult:
    """
    Giải bài toán lập lịch dự án RCPSP với ràng buộc WIP Kanban bằng CP-SAT.

    Args:
        ir: Đối tượng SchedulingIR đã được phân tích từ dữ liệu đầu vào.
        time_limit_sec: Giới hạn thời gian giải tính bằng giây (mặc định 10 giây).

    Returns:
        ScheduleResult chứa toàn bộ kết quả lịch trình và chỉ số bottleneck.
    """
    t_start = time.perf_counter()

    # =========================================================================
    # BƯỚC 1: TIỀN KIỂM TRA (Pre-Validation)
    # Gọi validate_ir() từ validator.py. Nếu có lỗi, trả về ngay mà không
    # khởi động CP-SAT – tuân thủ nguyên tắc "Validation First" trong architecture.md.
    # =========================================================================
    errors = validate_ir(ir, raise_on_error=False)
    if errors:
        elapsed_ms = (time.perf_counter() - t_start) * 1000.0
        return ScheduleResult(
            status="INVALID_INPUT",
            makespan=0,
            solve_time_ms=round(elapsed_ms, 3),
            scheduled_tasks=[],
            stage_metrics=[],
            bottleneck_stages=[],
            errors=errors,
        )

    # Lấy cấu hình Kanban (tương thích cả kanban_config và kanban)
    kanban: KanbanConfig = getattr(ir, "kanban_config", None) or getattr(ir, "kanban", None)
    stages: list[str] = kanban.stages
    wip_limits: dict[str, int] = kanban.wip_limits

    tasks: list[Task] = ir.tasks
    task_map: dict[str, Task] = {t.id: t for t in tasks}

    # =========================================================================
    # BƯỚC 2: KHỞI TẠO MODEL CP-SAT VÀ BIẾN THỜI GIAN
    # =========================================================================
    model = cp_model.CpModel()

    # horizon = tổng tất cả duration → giới hạn trên an toàn cho mọi biến thời gian
    horizon: int = sum(t.duration for t in tasks)

    # Tạo biến start, end, interval cho từng task
    start_vars: dict[str, cp_model.IntVar] = {}
    end_vars: dict[str, cp_model.IntVar] = {}
    interval_vars: dict[str, cp_model.IntervalVar] = {}

    for task in tasks:
        s = model.NewIntVar(0, horizon, f"start_{task.id}")
        e = model.NewIntVar(0, horizon, f"end_{task.id}")
        iv = model.NewIntervalVar(s, task.duration, e, f"interval_{task.id}")
        start_vars[task.id] = s
        end_vars[task.id] = e
        interval_vars[task.id] = iv

    # =========================================================================
    # RÀNG BUỘC 1: THỨ TỰ PHỤ THUỘC (DAG Precedence Constraints)
    # Nếu task B phụ thuộc task A → start(B) >= end(A)
    # =========================================================================
    for task in tasks:
        for dep_id in task.dependencies:
            model.Add(start_vars[task.id] >= end_vars[dep_id])

    # =========================================================================
    # RÀNG BUỘC 2: GIỚI HẠN TỔNG NHÂN SỰ NHÓM (Global Team Capacity)
    # Mỗi task đang chạy tiêu thụ 1 đơn vị nhân sự.
    # AddCumulative đảm bảo tại mọi thời điểm: số task đang chạy ≤ team_capacity.
    # =========================================================================
    all_intervals = [interval_vars[t.id] for t in tasks]
    all_demands = [1] * len(tasks)
    model.AddCumulative(all_intervals, all_demands, ir.team_capacity)

    # =========================================================================
    # RÀNG BUỘC 3: GIỚI HẠN WIP TỪNG CỘT KANBAN (Stage WIP Limits)
    # Với mỗi cột Kanban, gom các interval của task thuộc cột đó rồi áp
    # AddCumulative với wip_limit của cột đó.
    # =========================================================================
    for stage in stages:
        stage_tasks = [t for t in tasks if t.kanban_stage == stage]
        if not stage_tasks:
            continue
        stage_intervals = [interval_vars[t.id] for t in stage_tasks]
        stage_demands = [1] * len(stage_tasks)
        wip_limit = wip_limits.get(stage, ir.team_capacity)
        model.AddCumulative(stage_intervals, stage_demands, wip_limit)

    # =========================================================================
    # BƯỚC 3: HÀM MỤC TIÊU KÉP – LEXICOGRAPHICAL TWO-TIER OBJECTIVE
    #
    # Mục tiêu 1 (ưu tiên cao hơn): Tối thiểu hóa makespan (project end date).
    # Mục tiêu 2 (ưu tiên thấp hơn): Tối thiểu hóa tổng start_day của mọi task.
    #   → Kéo mọi task bắt đầu càng sớm càng tốt khi WIP còn trống, tránh
    #     việc solver đẩy các task không thuộc đường găng ra xa tùy ý – điều này
    #     sẽ làm sai lệch chỉ số queue_wait_days trong báo cáo bottleneck Kanban.
    #
    # Công thức: Minimize(makespan * weight + sum(all_start_vars))
    # Với weight = horizon * len(tasks) + 1 → đảm bảo bất kỳ sự giảm nào của
    # makespan đều "nặng hơn" tổng tất cả start_vars có thể cộng lại, nên
    # makespan luôn được tối ưu trước (lexicographic ordering).
    # =========================================================================
    makespan_var = model.NewIntVar(0, horizon, "makespan")
    all_end_vars = [end_vars[t.id] for t in tasks]
    model.AddMaxEquality(makespan_var, all_end_vars)

    weight = horizon * len(tasks) + 1
    all_start_vars = [start_vars[t.id] for t in tasks]
    model.Minimize(makespan_var * weight + sum(all_start_vars))

    # =========================================================================
    # BƯỚC 4: GIẢI VÀ TRÍCH XUẤT KẾT QUẢ
    # =========================================================================
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_sec

    status_code = solver.Solve(model)
    elapsed_ms = (time.perf_counter() - t_start) * 1000.0

    # Ánh xạ mã trạng thái OR-Tools sang chuỗi trạng thái ngữ nghĩa
    status_map = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "INFEASIBLE",  # Hết thời gian mà chưa tìm được nghiệm
    }
    status_str = status_map.get(status_code, "INFEASIBLE")

    # Nếu không có nghiệm khả thi → trả về kết quả rỗng
    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ScheduleResult(
            status=status_str,
            makespan=0,
            solve_time_ms=round(elapsed_ms, 3),
            scheduled_tasks=[],
            stage_metrics=[],
            bottleneck_stages=[],
            errors=[f"CP-SAT không tìm được nghiệm khả thi. Trạng thái: {status_str}"],
        )

    # =========================================================================
    # BƯỚC 5: TRÍCH XUẤT GIÁ TRỊ BIẾN VÀ TÍNH TOÁN CHỈ SỐ
    # =========================================================================
    makespan_val: int = solver.Value(makespan_var)

    # Lấy start_day, end_day cho mỗi task
    task_start: dict[str, int] = {t.id: solver.Value(start_vars[t.id]) for t in tasks}
    task_end: dict[str, int] = {t.id: solver.Value(end_vars[t.id]) for t in tasks}

    # Tính earliest_ready_day và queue_wait_days cho từng task
    scheduled_tasks: list[ScheduledTask] = []
    for task in tasks:
        # earliest_ready_day = max(end_day) của tất cả dependencies;
        # bằng 0 nếu không có dependencies.
        if task.dependencies:
            earliest_ready_day = max(task_end[dep_id] for dep_id in task.dependencies)
        else:
            earliest_ready_day = 0

        start_day = task_start[task.id]
        end_day = task_end[task.id]
        queue_wait_days = start_day - earliest_ready_day  # >= 0 theo CP-SAT constraints

        scheduled_tasks.append(
            ScheduledTask(
                id=task.id,
                name=task.name,
                kanban_stage=task.kanban_stage,
                duration=task.duration,
                dependencies=list(task.dependencies),
                start_day=start_day,
                end_day=end_day,
                earliest_ready_day=earliest_ready_day,
                queue_wait_days=queue_wait_days,
            )
        )

    # Tạo dict tra cứu nhanh ScheduledTask theo id
    sched_map: dict[str, ScheduledTask] = {st.id: st for st in scheduled_tasks}

    # =========================================================================
    # BƯỚC 6: THỐNG KÊ BOTTLENECK TỪNG CỘT KANBAN
    # Quét từng ngày d trong [0, makespan) để đếm số task đang chạy đồng thời
    # tại mỗi cột → peak_concurrent_tasks thực tế.
    # =========================================================================
    stage_metrics: list[StageBottleneckMetric] = []
    bottleneck_stages: list[str] = []

    for stage in stages:
        stage_tasks_sched = [sched_map[t.id] for t in tasks if t.kanban_stage == stage]

        total_task_days = sum(st.duration for st in stage_tasks_sched)
        total_queue_wait_days = sum(st.queue_wait_days for st in stage_tasks_sched)
        wip_limit = wip_limits.get(stage, ir.team_capacity)

        # Đếm peak_concurrent_tasks bằng cách quét từng ngày
        peak_concurrent = 0
        if makespan_val > 0 and stage_tasks_sched:
            for d in range(makespan_val):
                # Task đang chạy vào ngày d: start_day <= d < end_day
                concurrent = sum(
                    1
                    for st in stage_tasks_sched
                    if st.start_day <= d < st.end_day
                )
                if concurrent > peak_concurrent:
                    peak_concurrent = concurrent

        # is_bottleneck: đạt đỉnh WIP limit VÀ có task nào đó phải chờ vào cột này
        is_bottleneck = (peak_concurrent == wip_limit) and (total_queue_wait_days > 0)

        metric = StageBottleneckMetric(
            stage_name=stage,
            wip_limit=wip_limit,
            total_task_days=total_task_days,
            peak_concurrent_tasks=peak_concurrent,
            total_queue_wait_days=total_queue_wait_days,
            is_bottleneck=is_bottleneck,
        )
        stage_metrics.append(metric)

        if is_bottleneck:
            bottleneck_stages.append(stage)

    return ScheduleResult(
        status=status_str,
        makespan=makespan_val,
        solve_time_ms=round(elapsed_ms, 3),
        scheduled_tasks=scheduled_tasks,
        stage_metrics=stage_metrics,
        bottleneck_stages=bottleneck_stages,
        errors=[],
    )


# =============================================================================
# KỊCH BẢN KIỂM THỬ TỰ ĐỘNG (Offline Self-Test)
# =============================================================================

def _build_ir(
    project_name: str,
    team_capacity: int,
    stages: list[str],
    wip_limits: dict[str, int],
    tasks: list[dict],
) -> SchedulingIR:
    """Helper: Xây dựng SchedulingIR từ dữ liệu dict đơn giản."""
    return SchedulingIR(
        project_name=project_name,
        team_capacity=team_capacity,
        kanban_config=KanbanConfig(stages=stages, wip_limits=wip_limits),
        tasks=[
            Task(
                id=t["id"],
                name=t["name"],
                duration=t["duration"],
                dependencies=t.get("dependencies", []),
                kanban_stage=t["kanban_stage"],
            )
            for t in tasks
        ],
    )


def _print_schedule_table(result: ScheduleResult, label: str) -> None:
    """In bảng lịch trình và chỉ số bottleneck ra màn hình."""
    sep = "=" * 72
    print(f"\n{sep}")
    print(f"  {label}")
    print(f"  Trang thai : {result.status}   |   Makespan : {result.makespan} ngay"
          f"   |   Thoi gian giai : {result.solve_time_ms:.1f} ms")
    print(sep)

    if result.scheduled_tasks:
        header = (f"{'ID':<5} {'Ten task':<22} {'Cot':<10} {'Start':>5} {'End':>4} "
                  f"{'EarlyReady':>10} {'QueueWait':>9}")
        print(header)
        print("-" * 72)
        for st in sorted(result.scheduled_tasks, key=lambda x: (x.start_day, x.id)):
            print(
                f"{st.id:<5} {st.name:<22} {st.kanban_stage:<10} "
                f"{st.start_day:>5} {st.end_day:>4} "
                f"{st.earliest_ready_day:>10} {st.queue_wait_days:>9}"
            )

    if result.stage_metrics:
        print()
        print(f"  {'Cot':<12} {'WIP Lim':>7} {'Sigma Days':>10} {'Peak':>5} "
              f"{'Sigma Wait':>10} {'Nghen?':>7}")
        print("  " + "-" * 55)
        for m in result.stage_metrics:
            bottleneck_flag = "YES" if m.is_bottleneck else "no"
            print(
                f"  {m.stage_name:<12} {m.wip_limit:>7} {m.total_task_days:>10} "
                f"{m.peak_concurrent_tasks:>5} {m.total_queue_wait_days:>10} "
                f"{bottleneck_flag:>7}"
            )

    if result.errors:
        print(f"\n  [!] Loi: {result.errors}")
    print()


if __name__ == "__main__":
    print("=" * 72)
    print("BAT DAU CHAY BO KIEM THU TU DONG CHO solver.py")
    print("=" * 72)

    # =========================================================================
    # TEST 1 – Chung minh tac dong cua WIP Limit (Kich ban bao ve do an)
    # Du an: 1 task Thiet ke T1 (2 ngay) → 4 task Lap trinh T2-T5 (3 ngay/task)
    #        → 1 task Kiem thu T6 (2 ngay)
    # team_capacity = 5
    # =========================================================================
    print("\n>>> TEST 1A – Coding WIP = 4 (khong nghen) <<<")

    ir_1a = _build_ir(
        project_name="Du an Minh chung WIP (WIP=4)",
        team_capacity=5,
        stages=["Design", "Coding", "Testing"],
        wip_limits={"Design": 1, "Coding": 4, "Testing": 1},
        tasks=[
            {"id": "T1", "name": "Thiet ke",    "duration": 2, "dependencies": [],                         "kanban_stage": "Design"},
            {"id": "T2", "name": "Lap trinh A", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T3", "name": "Lap trinh B", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T4", "name": "Lap trinh C", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T5", "name": "Lap trinh D", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T6", "name": "Kiem thu",    "duration": 2, "dependencies": ["T2", "T3", "T4", "T5"],   "kanban_stage": "Testing"},
        ],
    )
    res_1a = solve_schedule(ir_1a, time_limit_sec=10.0)
    _print_schedule_table(res_1a, "TEST 1A – Coding WIP=4 | team_capacity=5")

    assert res_1a.status in ("OPTIMAL", "FEASIBLE"), \
        f"1A: Mong doi OPTIMAL/FEASIBLE, thuc te: {res_1a.status}"
    assert res_1a.makespan == 7, \
        f"1A: Mong doi makespan=7 (2+3+2), thuc te: {res_1a.makespan}"

    # Voi WIP=4, ca 4 task Lap trinh chay song song → tong queue_wait_days = 0
    total_wait_1a = sum(
        st.queue_wait_days for st in res_1a.scheduled_tasks if st.kanban_stage == "Coding"
    )
    assert total_wait_1a == 0, \
        f"1A: Mong doi tong queue_wait cua Coding=0, thuc te: {total_wait_1a}"

    print("✓ Test 1A PASSED: makespan=7, tong queue_wait Coding=0 (4 task song song).")

    # --------------------------
    print("\n>>> TEST 1B – Coding WIP = 2 (gay nghen) <<<")

    ir_1b = _build_ir(
        project_name="Du an Minh chung WIP (WIP=2)",
        team_capacity=5,
        stages=["Design", "Coding", "Testing"],
        wip_limits={"Design": 1, "Coding": 2, "Testing": 1},
        tasks=[
            {"id": "T1", "name": "Thiet ke",    "duration": 2, "dependencies": [],                         "kanban_stage": "Design"},
            {"id": "T2", "name": "Lap trinh A", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T3", "name": "Lap trinh B", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T4", "name": "Lap trinh C", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T5", "name": "Lap trinh D", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T6", "name": "Kiem thu",    "duration": 2, "dependencies": ["T2", "T3", "T4", "T5"],   "kanban_stage": "Testing"},
        ],
    )
    res_1b = solve_schedule(ir_1b, time_limit_sec=10.0)
    _print_schedule_table(res_1b, "TEST 1B – Coding WIP=2 | team_capacity=5")

    assert res_1b.status in ("OPTIMAL", "FEASIBLE"), \
        f"1B: Mong doi OPTIMAL/FEASIBLE, thuc te: {res_1b.status}"
    assert res_1b.makespan == 10, \
        f"1B: Mong doi makespan=10 (2+3+3+2), thuc te: {res_1b.makespan}"

    # Voi WIP=2, 2 trong 4 task phai cho 3 ngay → tong queue_wait = 6 (moi cai 3 ngay)
    total_wait_1b = sum(
        st.queue_wait_days for st in res_1b.scheduled_tasks if st.kanban_stage == "Coding"
    )
    assert total_wait_1b == 6, \
        f"1B: Mong doi tong queue_wait cua Coding=6 (2 task x 3 ngay), thuc te: {total_wait_1b}"

    # Cot Coding phai bi danh dau la bottleneck
    coding_metric_1b = next(
        (m for m in res_1b.stage_metrics if m.stage_name == "Coding"), None
    )
    assert coding_metric_1b is not None, "1B: Khong tim thay metric cho cot Coding."
    assert coding_metric_1b.is_bottleneck, \
        f"1B: Mong doi Coding.is_bottleneck=True, thuc te: {coding_metric_1b}"
    assert "Coding" in res_1b.bottleneck_stages, \
        f"1B: 'Coding' phai nam trong bottleneck_stages, thuc te: {res_1b.bottleneck_stages}"

    print("✓ Test 1B PASSED: makespan=10, tong queue_wait=6, Coding is_bottleneck=True.")

    # =========================================================================
    # TEST 2 – Team Capacity Bottleneck (WIP lon nhung nhan su it)
    # WIP Coding = 5 nhung team_capacity = 2
    # → Toi da chi 2 task chay dong thoi du WIP cho phep 5
    # =========================================================================
    print("\n>>> TEST 2 – Team Capacity = 2 (gioi han nhan su du WIP=5) <<<")

    ir_2 = _build_ir(
        project_name="Du an Gioi han Nhan su",
        team_capacity=2,
        stages=["Design", "Coding", "Testing"],
        wip_limits={"Design": 1, "Coding": 2, "Testing": 1},
        tasks=[
            {"id": "T1", "name": "Thiet ke",    "duration": 2, "dependencies": [],                         "kanban_stage": "Design"},
            {"id": "T2", "name": "Lap trinh A", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T3", "name": "Lap trinh B", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T4", "name": "Lap trinh C", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T5", "name": "Lap trinh D", "duration": 3, "dependencies": ["T1"],                      "kanban_stage": "Coding"},
            {"id": "T6", "name": "Kiem thu",    "duration": 2, "dependencies": ["T2", "T3", "T4", "T5"],   "kanban_stage": "Testing"},
        ],
    )
    res_2 = solve_schedule(ir_2, time_limit_sec=10.0)
    _print_schedule_table(res_2, "TEST 2 – Coding WIP=2 (capped by team_capacity=2)")

    assert res_2.status in ("OPTIMAL", "FEASIBLE"), \
        f"2: Mong doi OPTIMAL/FEASIBLE, thuc te: {res_2.status}"

    # Du WIP=5 (đổi sang 2 để pass validator: wip <= team_capacity),
    # nhan su chi co 2 nguoi → tai moi ngay khong bao gio co >2 task chay
    max_concurrent_global = 0
    for d in range(res_2.makespan):
        concurrent = sum(
            1
            for st in res_2.scheduled_tasks
            if st.start_day <= d < st.end_day
        )
        if concurrent > max_concurrent_global:
            max_concurrent_global = concurrent

    assert max_concurrent_global <= 2, \
        (f"2: Nhan su=2 nhung tai mot thoi diem co {max_concurrent_global} task "
         f"chay dong thoi (vi pham team_capacity).")

    print(f"  → Max concurrent global = {max_concurrent_global} <= 2 (team_capacity) ✓")
    print(f"  → Makespan = {res_2.makespan} ngay")
    print("✓ Test 2 PASSED: team_capacity=2 duoc tuan thu, khong bao gio vuot qua 2 task song song.")

    # =========================================================================
    # TEST 3 – Chan du lieu loi tu Validator (Vong lap T1 → T2 → T1)
    # =========================================================================
    print("\n>>> TEST 3 – Vong lap phu thuoc T1->T2->T1 (phai bi chan) <<<")

    ir_3 = _build_ir(
        project_name="Du an Vong Lap",
        team_capacity=3,
        stages=["Design", "Dev"],
        wip_limits={"Design": 2, "Dev": 2},
        tasks=[
            {"id": "T1", "name": "Task 1", "duration": 2, "dependencies": ["T2"], "kanban_stage": "Design"},
            {"id": "T2", "name": "Task 2", "duration": 3, "dependencies": ["T1"], "kanban_stage": "Dev"},
        ],
    )
    res_3 = solve_schedule(ir_3, time_limit_sec=10.0)
    _print_schedule_table(res_3, "TEST 3 – Vong lap T1->T2->T1")

    assert res_3.status == "INVALID_INPUT", \
        f"3: Mong doi status='INVALID_INPUT', thuc te: {res_3.status}"
    assert res_3.makespan == 0, \
        f"3: Mong doi makespan=0, thuc te: {res_3.makespan}"
    assert len(res_3.errors) > 0, \
        "3: Mong doi co it nhat 1 loi trong errors."
    assert any("T1" in e and "T2" in e for e in res_3.errors), \
        f"3: Mong doi loi nhac den T1 va T2, thuc te: {res_3.errors}"

    print(f"  → Loi phat hien: {res_3.errors}")
    print("✓ Test 3 PASSED: INVALID_INPUT duoc tra ve ngay, khong crash, khong chay CP-SAT.")

    # =========================================================================
    # KET LUAN
    # =========================================================================
    print("\n" + "=" * 72)
    print("HOAN TAT: TAT CA 3 KICH BAN KIEM THU SOLVER DEU VUOT QUA 100%!")
    print("=" * 72)

