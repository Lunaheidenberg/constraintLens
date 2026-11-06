from pydantic import BaseModel, Field
from typing import List, Dict, Optional

class Task(BaseModel):
    id: str = Field(description="Mã công việc duy nhất (VD: T1, T2, T3)")
    name: str = Field(description="Tên công việc")
    duration: int = Field(description="Thời gian thực hiện (đơn vị: ngày, số nguyên dương >= 1)", ge=1)
    dependencies: List[str] = Field(default=[], description="Danh sách ID các công việc phải hoàn thành trước (tiên quyết)")
    kanban_stage: str = Field(description="Tên cột Kanban mà công việc này thuộc về (VD: Design, Backend, Frontend, Review, Testing)")

class KanbanConfig(BaseModel):
    stages: List[str] = Field(description="Danh sách các cột Kanban theo thứ tự luồng công việc (VD: ['Design', 'Backend', 'Review'])")
    wip_limits: Dict[str, int] = Field(description="Giới hạn số thẻ tối đa (WIP Limit) cho từng cột. Key là tên cột, Value là giới hạn. (VD: {'Review': 2})")

class SchedulingIR(BaseModel):
    project_name: str = Field(description="Tên của đồ án/dự án")
    team_capacity: int = Field(description="Tổng số lượng thành viên trong nhóm (số nguyên dương >= 1)", ge=1)
    kanban_config: KanbanConfig = Field(description="Cấu hình quy trình Kanban")
    tasks: List[Task] = Field(description="Danh sách toàn bộ các công việc cần làm")