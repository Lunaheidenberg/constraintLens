"""Reviewable extraction data and its explicit conversion to a scheduling project."""

import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from models import KanbanConfig, ProjectMember, SchedulingIR, Task
from validator import validate_ir


def _plain_label(label: str) -> str:
    if re.search(r"[<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", label):
        raise ValueError("Chỉ nhập văn bản một dòng, không dùng dấu < hoặc >.")
    return label


Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=180), AfterValidator(_plain_label)]
TaskID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")]
Days = Annotated[int, Field(strict=True, gt=0, le=2**53 - 1)]
Review = Literal["provided", "suggested", "missing", "confirmed"]


class DraftModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskFields(DraftModel):
    id: TaskID
    name: Label
    category: Label
    duration: Days | None
    dependencies: list[TaskID] | None = Field(max_length=100)


class ExtractedTask(TaskFields):
    duration_quote: str | None = Field(max_length=500)
    dependency_quote: str | None = Field(max_length=500)


class Extraction(DraftModel):
    project_name: Label
    tasks: list[ExtractedTask] = Field(max_length=100)


class DraftMember(DraftModel):
    id: TaskID
    name: Label


class DraftTask(TaskFields):
    duration_review: Review
    dependency_review: Review
    suggested_assignee_id: TaskID | None = None
    assignee_review: Review | None = None


class ProjectDraft(DraftModel):
    project_name: Label
    members: list[DraftMember] = Field(default_factory=list, max_length=50)
    tasks: list[DraftTask] = Field(min_length=1, max_length=100)

    def confirm(self) -> tuple[SchedulingIR | None, list[str]]:
        errors: list[str] = []
        member_ids = {member.id for member in self.members}
        if len(member_ids) != len(self.members):
            errors.append("Mã thành viên trong bản nháp bị trùng.")
        for task in self.tasks:
            if task.duration is None or task.duration_review not in {"provided", "confirmed"}:
                errors.append(f"{task.id}: Nhập hoặc xác nhận thời lượng theo ngày.")
            if task.dependencies is None or task.dependency_review not in {"provided", "confirmed"}:
                errors.append(f"{task.id}: Xác nhận công việc tiên quyết hoặc chọn không có.")
            if task.suggested_assignee_id is not None:
                if task.assignee_review not in {"provided", "confirmed"}:
                    errors.append(f"{task.id}: Xác nhận hoặc bỏ gợi ý người phụ trách trước khi áp dụng.")
                if task.suggested_assignee_id not in member_ids:
                    errors.append(f"{task.id}: Người phụ trách gợi ý '{task.suggested_assignee_id}' không có trong danh sách thành viên bản nháp.")
        if errors:
            return None, errors
        members = [ProjectMember(id=member.id, name=member.name) for member in self.members]
        tasks = [
            Task(
                id=task.id, name=task.name, category=task.category, kanban_stage=task.category,
                duration=task.duration, dependencies=task.dependencies, status="To Do",
                assignee_id=(
                    task.suggested_assignee_id
                    if task.suggested_assignee_id is not None and task.assignee_review in {"provided", "confirmed"}
                    else None
                ),
            )
            for task in self.tasks
        ]
        ir = SchedulingIR(
            project_name=self.project_name,
            team_capacity=max(1, len(members)),
            members=members,
            tasks=tasks,
            kanban_config=KanbanConfig(stages=list(dict.fromkeys(task.kanban_stage for task in tasks)), wip_limits={}),
        )
        errors = validate_ir(ir)
        return (None if errors else ir), errors
