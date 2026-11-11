from pydantic import BaseModel, Field
from typing import List, Dict, Literal


KanbanStatus = Literal["To Do", "Doing", "Done"]


class ProjectMember(BaseModel):
    id: str = Field(min_length=1, pattern=r"^\S+$", description="Mã thành viên ổn định, không chứa khoảng trắng")
    name: str = Field(min_length=1, description="Tên hiển thị của thành viên")


class Task(BaseModel):
    id: str = Field(description="Mã công việc duy nhất (VD: T1, T2, T3)")
    name: str = Field(description="Tên công việc")
    duration: int = Field(description="Thời gian thực hiện (đơn vị: ngày, số nguyên dương >= 1)", ge=1, strict=True)
    dependencies: List[str] = Field(default_factory=list, description="Danh sách ID các công việc phải hoàn thành trước (tiên quyết)")
    kanban_stage: str = Field(description="Nhóm WIP cũ của bộ lập lịch T1 (VD: Design, Backend, Testing)")
    category: str = Field(
        default_factory=lambda data: data["kanban_stage"],
        validate_default=True,
        min_length=1,
        description="Nhóm chuyên môn của task, độc lập với trạng thái Kanban",
    )
    status: KanbanStatus = Field(default="To Do", description="Trạng thái Kanban hiện tại")
    assignee_id: str | None = Field(
        default=None, description="ID thành viên do người dùng phân công; null nếu chưa phân công"
    )


# team_capacity, kanban_config và kanban_stage duy trì hợp đồng WIP hiện tại.
# T2 sẽ thay thế các ràng buộc này bằng lịch theo thành viên; các trường cũ
# chỉ được loại bỏ sau khi các bên sử dụng hợp đồng cũ đã được chuyển đổi.
class KanbanConfig(BaseModel):
    stages: List[str] = Field(description="Danh sách các cột Kanban theo thứ tự luồng công việc (VD: ['Design', 'Backend', 'Review'])")
    wip_limits: Dict[str, int] = Field(description="Giới hạn số thẻ tối đa (WIP Limit) cho từng cột. Key là tên cột, Value là giới hạn. (VD: {'Review': 2})")

class SchedulingIR(BaseModel):
    project_name: str = Field(description="Tên của đồ án/dự án")
    team_capacity: int = Field(description="Tổng số lượng thành viên trong nhóm (số nguyên dương >= 1)", ge=1)
    kanban_config: KanbanConfig = Field(description="Cấu hình quy trình Kanban")
    tasks: List[Task] = Field(description="Danh sách toàn bộ các công việc cần làm")
    members: List[ProjectMember] = Field(default_factory=list, description="Danh sách thành viên dự án")
