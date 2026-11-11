"""
validator.py
------------
Kiểm tra tính hợp lệ toàn diện của đối tượng SchedulingIR trước khi đưa vào
bộ giải quy hoạch ràng buộc OR-Tools CP-SAT.

Quy tắc kiến trúc (architecture.md):
- Validation First: Chặn đứng mọi dữ liệu không hợp lệ, đặc biệt là chu trình (DAG cycle).
- Thu thập TOÀN BỘ lỗi (không dừng ở lỗi đầu tiên) để người dùng sửa một lần trên UI.
- Thông báo lỗi bằng tiếng Việt chi tiết, rõ ràng, chỉ rõ nguyên nhân và vị trí lỗi.
"""

from typing import List, Dict, Set, Tuple, Optional
from models import SchedulingIR, KanbanConfig, Task


class SchedulingValidationError(Exception):
    """
    Ngoại lệ tùy chỉnh ném ra khi đối tượng SchedulingIR không thỏa mãn
    các ràng buộc tính hợp lệ logic. Lưu trữ toàn bộ danh sách lỗi phát hiện được.
    """

    def __init__(self, errors: list[str]):
        self.errors = errors
        message = (
            f"Phát hiện {len(errors)} lỗi logic trong dữ liệu SchedulingIR:\n"
            + "\n".join(f"- {err}" for err in errors)
        )
        super().__init__(message)


def _normalize_cycle(cycle_nodes: list[str]) -> tuple[str, ...]:
    """
    Chuẩn hóa chu trình đồ thị có hướng để nhận diện trùng lặp:
    Xoay vòng danh sách đỉnh sao cho đỉnh có thứ tự từ điển nhỏ nhất đứng đầu.
    """
    if not cycle_nodes:
        return ()
    min_idx = min(range(len(cycle_nodes)), key=lambda i: cycle_nodes[i])
    rotated = cycle_nodes[min_idx:] + cycle_nodes[:min_idx]
    return tuple(rotated)


def validate_ir(
    ir: SchedulingIR, raise_on_error: bool = False, *, require_assignments: bool = False
) -> list[str]:
    """
    Kiểm tra toàn diện tính hợp lệ của đối tượng SchedulingIR trước khi giải bài toán.

    Thu thập TOÀN BỘ lỗi logic mà không dừng sớm, bao gồm:
    1. Kiểm tra danh sách tasks rỗng & trùng lặp Task ID.
    2. Trong chế độ cũ, kiểm tra tính toàn vẹn cột Kanban & WIP Limits.
    3. Kiểm tra tính toàn vẹn tham chiếu phụ thuộc (không tự phụ thuộc, không phụ thuộc ID ma).
    4. Phát hiện chu trình phụ thuộc vòng tròn bằng thuật toán DFS 3 màu (DAG Cycle Detection).
    5. Kiểm tra ID thành viên duy nhất và tham chiếu người được phân công.

    Args:
        ir: Đối tượng SchedulingIR cần kiểm tra.
        raise_on_error: Nếu True và có lỗi, ném ra ngoại lệ SchedulingValidationError(errors).
                        Mặc định là False (chỉ trả về danh sách lỗi).
        require_assignments: Kiểm tra lịch theo thành viên. Mỗi task phải có người
                             phụ trách và không áp dụng các quy tắc WIP cũ.

    Returns:
        list[str]: Danh sách các chuỗi thông báo lỗi bằng tiếng Việt (rỗng [] nếu hợp lệ).
    """
    errors: list[str] = []

    # =========================================================================
    # CHỐT CHẶN 1: Kiểm tra Danh sách rỗng & Trùng lặp ID (ID Uniqueness)
    # =========================================================================
    tasks = ir.tasks if ir.tasks is not None else []

    if not tasks:
        errors.append("Danh sách công việc (ir.tasks) không được để rỗng.")

    # Kiểm tra trùng lặp Task ID
    seen_task_ids: set[str] = set()
    duplicate_task_ids: set[str] = set()
    for task in tasks:
        if task.id in seen_task_ids:
            duplicate_task_ids.add(task.id)
        else:
            seen_task_ids.add(task.id)

    for dup_id in sorted(duplicate_task_ids):
        errors.append(
            f"Mã công việc (Task ID) '{dup_id}' bị trùng lặp. Mỗi task phải có một ID duy nhất."
        )

    member_ids: set[str] = set()
    for member in ir.members:
        if member.id in member_ids:
            errors.append(f"Mã thành viên '{member.id}' bị trùng lặp. Hãy dùng một ID duy nhất cho mỗi thành viên.")
        member_ids.add(member.id)

    for task in tasks:
        if task.assignee_id is None:
            if require_assignments:
                errors.append(f"Task '{task.id}' chưa được phân công. Hãy chọn một thành viên cho task này.")
        elif task.assignee_id not in member_ids:
            errors.append(
                f"Task '{task.id}' được giao cho ID '{task.assignee_id}' không có trong danh sách thành viên. "
                "Hãy chọn một thành viên hiện có hoặc thêm người phụ trách vào danh sách thành viên."
            )

    # =========================================================================
    # CHỐT CHẶN 2: Kiểm tra Tính toàn vẹn cột Kanban & WIP Limits (Kanban Integrity)
    # =========================================================================
    if not require_assignments:
        errors.extend(_validate_legacy_kanban(ir, tasks))

    # =========================================================================
    # CHỐT CHẶN 3: Kiểm tra Tham chiếu Phụ thuộc (Referential Integrity)
    # =========================================================================
    existing_ids = {task.id for task in tasks}

    for task in tasks:
        # 3.1 Không có Task nào tự phụ thuộc vào chính nó
        if task.id in task.dependencies:
            errors.append(f"Task '{task.id}' không thể tự phụ thuộc vào chính nó.")

        # 3.2 Mọi mã ID trong dependencies phải thực sự tồn tại trong ir.tasks
        for dep_id in task.dependencies:
            if dep_id not in existing_ids:
                errors.append(
                    f"Task '{task.id}' phụ thuộc vào mã công việc không tồn tại: '{dep_id}'."
                )

    # =========================================================================
    # CHỐT CHẶN 4: Phát hiện Chu trình Đồ thị Có hướng - DAG Cycle Detection (DFS 3 màu)
    # =========================================================================
    # Xây dựng đồ thị có hướng: node -> dependencies (task phụ thuộc vào dep)
    # Chỉ bổ sung cạnh tới các ID thực sự tồn tại và khác chính task.id
    adj: dict[str, list[str]] = {t.id: [] for t in tasks}
    for task in tasks:
        for dep_id in task.dependencies:
            if dep_id in existing_ids and dep_id != task.id:
                if dep_id not in adj[task.id]:
                    adj[task.id].append(dep_id)

    # Màu sắc:
    # 0 = WHITE (Chưa thăm)
    # 1 = GRAY (Đang trong ngăn xếp đệ quy hiện tại)
    # 2 = BLACK (Đã duyệt hoàn tất toàn bộ nhánh con)
    color: dict[str, int] = {t_id: 0 for t_id in existing_ids}
    seen_cycles: set[tuple[str, ...]] = set()

    def dfs(u: str, current_path: list[str]) -> None:
        color[u] = 1
        current_path.append(u)

        for v in adj.get(u, []):
            if color[v] == 1:
                # Phát hiện back-edge dẫn tới đỉnh đang nằm trong stack -> Có chu trình!
                cycle_start_idx = current_path.index(v)
                cycle_nodes = current_path[cycle_start_idx:]

                # Chuẩn hóa để tránh thông báo trùng lặp cùng một chu trình từ đỉnh khác
                canonical_key = _normalize_cycle(cycle_nodes)
                if canonical_key not in seen_cycles:
                    seen_cycles.add(canonical_key)
                    # Sắp xếp hiển thị bắt đầu từ đỉnh có thứ tự từ điển nhỏ nhất
                    min_idx = min(range(len(cycle_nodes)), key=lambda i: cycle_nodes[i])
                    ordered_nodes = cycle_nodes[min_idx:] + cycle_nodes[:min_idx]
                    cycle_path_str = " -> ".join(ordered_nodes + [ordered_nodes[0]])
                    errors.append(
                        f"Phát hiện phụ thuộc vòng tròn (Cycle): {cycle_path_str}"
                    )
            elif color[v] == 0:
                dfs(v, current_path)

        current_path.pop()
        color[u] = 2

    for node_id in sorted(existing_ids):
        if color[node_id] == 0:
            dfs(node_id, [])

    # =========================================================================
    # Kết luận & Xử lý raise_on_error
    # =========================================================================
    if raise_on_error and errors:
        raise SchedulingValidationError(errors)

    return errors


def _validate_legacy_kanban(ir: SchedulingIR, tasks: list[Task]) -> list[str]:
    errors: list[str] = []
    # Truy xuất an toàn cấu hình Kanban (tương thích kanban_config hoặc kanban)
    kanban: Optional[KanbanConfig] = getattr(ir, "kanban_config", None)
    if kanban is None:
        kanban = getattr(ir, "kanban", None)

    stages: list[str] = getattr(kanban, "stages", []) if kanban else []
    wip_limits: dict[str, int] = getattr(kanban, "wip_limits", {}) if kanban else {}
    if not stages:
        errors.append("Danh sách các cột Kanban (ir.kanban.stages) không được để rỗng.")
    stages_set = set(stages)

    # 2.1 Mọi task.kanban_stage phải nằm trong ir.kanban.stages
    for task in tasks:
        if task.kanban_stage not in stages_set:
            errors.append(
                f"Task '{task.id}' gắn với cột '{task.kanban_stage}' không tồn tại trong cấu hình Kanban {stages}"
            )

    # 2.2 Mọi key trong ir.kanban.wip_limits phải nằm trong ir.kanban.stages
    for stage_name in wip_limits:
        if stage_name not in stages_set:
            errors.append(
                f"Cột '{stage_name}' trong cấu hình giới hạn WIP (wip_limits) không tồn tại trong cấu hình Kanban {stages}."
            )

    # 2.3 Mọi giá trị giới hạn trong wip_limits phải thỏa mãn: 1 <= wip_limit <= ir.team_capacity
    for stage_name, limit_val in wip_limits.items():
        if not (1 <= limit_val <= ir.team_capacity):
            errors.append(
                f"Cột '{stage_name}' có giới hạn WIP={limit_val} không hợp lệ. "
                f"Giới hạn phải thỏa mãn: 1 <= wip_limit <= dung lượng nhóm ({ir.team_capacity})."
            )

    return errors


# =============================================================================
# KIỂM THỬ NỘI BỘ (Offline Self-Test Suite)
# =============================================================================
if __name__ == "__main__":
    print("=" * 70)
    print("BẮT ĐẦU CHẠY BỘ KIỂM THỬ TỰ ĐỘNG CHO validator.py")
    print("=" * 70)

    # -------------------------------------------------------------------------
    # Case 1: Đồ thị dự án Kanban hợp lệ (kết quả mong đợi: errors == [])
    # -------------------------------------------------------------------------
    ir_case1 = SchedulingIR(
        project_name="Dự án Website Thương mại Điện tử",
        team_capacity=4,
        kanban_config=KanbanConfig(
            stages=["Backlog", "Design", "Dev", "Testing", "Done"],
            wip_limits={"Design": 2, "Dev": 3},
        ),
        tasks=[
            Task(
                id="T1",
                name="Thiết kế UI/UX",
                duration=2,
                dependencies=[],
                kanban_stage="Design",
            ),
            Task(
                id="T2",
                name="Xây dựng API Backend",
                duration=3,
                dependencies=["T1"],
                kanban_stage="Dev",
            ),
            Task(
                id="T3",
                name="Kiểm thử tích hợp",
                duration=1,
                dependencies=["T2"],
                kanban_stage="Testing",
            ),
        ],
    )
    errors_case1 = validate_ir(ir_case1)
    assert errors_case1 == [], f"Case 1 thất bại! Lỗi bất ngờ: {errors_case1}"
    print("✓ Case 1 passed: Đồ thị dự án Kanban hợp lệ (errors == []).")

    # -------------------------------------------------------------------------
    # Case 2: Lỗi chu trình T1 -> T2 -> T3 -> T1 (in ra đúng chuỗi chu trình)
    # -------------------------------------------------------------------------
    ir_case2 = SchedulingIR(
        project_name="Dự án Phụ thuộc Vòng tròn",
        team_capacity=3,
        kanban_config=KanbanConfig(
            stages=["Design", "Dev", "Review"],
            wip_limits={"Design": 2, "Dev": 2},
        ),
        tasks=[
            Task(
                id="T1",
                name="Công việc 1",
                duration=2,
                dependencies=["T2"],
                kanban_stage="Design",
            ),
            Task(
                id="T2",
                name="Công việc 2",
                duration=3,
                dependencies=["T3"],
                kanban_stage="Dev",
            ),
            Task(
                id="T3",
                name="Công việc 3",
                duration=1,
                dependencies=["T1"],
                kanban_stage="Review",
            ),
        ],
    )
    errors_case2 = validate_ir(ir_case2)
    assert len(errors_case2) == 1, (
        f"Case 2 mong đợi 1 lỗi chu trình, thực tế có {len(errors_case2)}: {errors_case2}"
    )
    assert any("T1 -> T2 -> T3 -> T1" in err for err in errors_case2), (
        f"Case 2 không in đúng chuỗi chu trình 'T1 -> T2 -> T3 -> T1'. Thực tế: {errors_case2}"
    )
    print(f"✓ Case 2 passed: Phát hiện đúng chu trình: {errors_case2[0]}")

    # -------------------------------------------------------------------------
    # Case 3: Lỗi phụ thuộc vào ID không tồn tại (T99) và sai tên cột kanban_stage
    # -------------------------------------------------------------------------
    ir_case3 = SchedulingIR(
        project_name="Dự án ID Ma và Sai Cột",
        team_capacity=2,
        kanban_config=KanbanConfig(
            stages=["Backlog", "Dev"],
            wip_limits={},
        ),
        tasks=[
            Task(
                id="T1",
                name="Công việc lỗi",
                duration=2,
                dependencies=["T99"],
                kanban_stage="InvalidStage",
            ),
        ],
    )
    errors_case3 = validate_ir(ir_case3)
    assert len(errors_case3) == 2, (
        f"Case 3 mong đợi 2 lỗi (ID ma và sai cột), thực tế có {len(errors_case3)}: {errors_case3}"
    )
    assert any("T99" in err for err in errors_case3), (
        f"Case 3 không bắt được lỗi phụ thuộc vào ID ma 'T99': {errors_case3}"
    )
    assert any("InvalidStage" in err for err in errors_case3), (
        f"Case 3 không bắt được lỗi cột 'InvalidStage' không hợp lệ: {errors_case3}"
    )
    print(f"✓ Case 3 passed: Bắt đủ cả 2 lỗi ID ma và sai tên cột: {errors_case3}")

    # -------------------------------------------------------------------------
    # Case 4: Lỗi wip_limit > team_capacity
    # -------------------------------------------------------------------------
    ir_case4 = SchedulingIR(
        project_name="Dự án Quá tải WIP Limit",
        team_capacity=2,
        kanban_config=KanbanConfig(
            stages=["Analysis", "Dev"],
            wip_limits={"Dev": 5},  # 5 > team_capacity (2)
        ),
        tasks=[
            Task(
                id="T1",
                name="Công việc hợp lệ",
                duration=1,
                dependencies=[],
                kanban_stage="Dev",
            ),
        ],
    )
    errors_case4 = validate_ir(ir_case4)
    assert any("Dev" in err and "5" in err for err in errors_case4), (
        f"Case 4 không phát hiện được lỗi wip_limit > team_capacity: {errors_case4}"
    )
    print(f"✓ Case 4 passed: Bắt đúng lỗi WIP Limit vượt quá dung lượng nhóm: {errors_case4}")

    # -------------------------------------------------------------------------
    # Kiểm tra bổ sung: Cơ chế raise_on_error
    # -------------------------------------------------------------------------
    try:
        validate_ir(ir_case2, raise_on_error=True)
        assert False, "validate_ir phải ném ra SchedulingValidationError khi raise_on_error=True"
    except SchedulingValidationError as ex:
        assert len(ex.errors) == 1
        assert "T1 -> T2 -> T3 -> T1" in ex.errors[0]
        print("✓ Kiểm tra ngoại lệ SchedulingValidationError(raise_on_error=True) passed.")

    print("\n" + "=" * 70)
    print("HOÀN TẤT: TẤT CẢ 4 TRƯỜNG HỢP KIỂM THỬ TỰ ĐỘNG ĐỀU VƯỢT QUA 100%!")
    print("=" * 70)

