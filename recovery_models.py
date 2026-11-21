"""Read-only Recovery contracts for client-held schedule snapshots."""

from datetime import date
from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from models import KanbanStatus, canonical_dependency_ids
from project_calendar import (
    CalendarDate, ProjectCalendar, calendar_finish, day_offset, end_of_day_boundary,
)
from validator import validate_dependencies


Role = Literal["accepted", "proposal"]
SolverStatus = Literal["OPTIMAL", "FEASIBLE", "UNKNOWN", "INFEASIBLE", "INVALID_INPUT", "MODEL_INVALID"]
SOLVED = {"OPTIMAL", "FEASIBLE"}
Intent = Literal["overview", "changes", "deadline", "dependencies", "progress", "attention", "causes", "actions"]
Identifier = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"\S")]
PositiveDays = Annotated[int, Field(strict=True, gt=0)]
Offset = Annotated[int, Field(strict=True, ge=0)]


class RecoveryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RecoveryTask(RecoveryModel):
    id: Identifier
    name: str = ""
    estimated_duration: PositiveDays
    dependencies: list[Identifier] = Field(default_factory=list)
    assignee_id: Identifier | None = None
    status: KanbanStatus | None = None
    _canonicalize_dependencies = field_validator("dependencies")(canonical_dependency_ids)


class RecoveryInterval(RecoveryModel):
    task_id: Identifier
    start_day: Offset
    end_day: PositiveDays
    earliest_ready_day: Offset | None = None
    queue_wait_days: Offset | None = None


class RecoveryProgress(RecoveryModel):
    progress_as_of_date: CalendarDate
    actual_finishes: dict[Identifier, CalendarDate] = Field(default_factory=dict)
    remaining_durations: dict[Identifier, PositiveDays] = Field(default_factory=dict)


class RecoveryScheduleSnapshot(RecoveryModel):
    project_ref: Identifier
    snapshot_ref: Identifier
    calendar: ProjectCalendar
    status: SolverStatus
    tasks: list[RecoveryTask]
    scheduled_tasks: list[RecoveryInterval] = Field(default_factory=list)
    progress: RecoveryProgress | None = None

    @property
    def replanning_day(self) -> int:
        if self.progress is None:
            return 0
        return end_of_day_boundary(self.calendar.project_start_date, self.progress.progress_as_of_date)

    @property
    def actual_end_days(self) -> dict[str, int]:
        if self.progress is None:
            return {}
        start = self.calendar.project_start_date
        return {task_id: end_of_day_boundary(start, finish) for task_id, finish in self.progress.actual_finishes.items()}

    @model_validator(mode="after")
    def validate_snapshot(self) -> "RecoveryScheduleSnapshot":
        tasks = {task.id: task for task in self.tasks}
        work = {interval.task_id: interval for interval in self.scheduled_tasks}
        if len(tasks) != len(self.tasks) or len(work) != len(self.scheduled_tasks):
            raise ValueError("Snapshot có ID công việc hoặc khoảng lịch trùng nhau.")
        try:
            errors = validate_dependencies([(task.id, task.dependencies) for task in self.tasks])
        except RecursionError:
            raise ValueError("Đồ thị phụ thuộc của snapshot vượt quá độ sâu có thể kiểm tra.") from None
        if errors:
            raise ValueError(errors[0])

        completed = self.actual_end_days
        remaining = self.progress.remaining_durations if self.progress is not None else {}
        if (work.keys() | completed.keys() | remaining.keys()) - tasks.keys():
            raise ValueError("Khoảng lịch hoặc tiến độ tham chiếu công việc ngoài snapshot.")
        if completed.keys() & (work.keys() | remaining.keys()):
            raise ValueError("Công việc đã xác nhận hoàn thành không thể có việc còn lại trong cùng snapshot.")

        max_day = day_offset(self.calendar.project_start_date, date.max)
        boundary = self.replanning_day
        if self.progress is not None and not 1 <= boundary <= max_day:
            raise ValueError("Ngày báo cáo tiến độ nằm ngoài phạm vi lịch.")
        for task_id, end in completed.items():
            if not 1 <= end <= boundary:
                raise ValueError(f"Ngày hoàn thành thực tế của '{task_id}' nằm ngoài kỳ báo cáo.")
            if any(dep not in completed or completed[dep] >= end for dep in tasks[task_id].dependencies):
                raise ValueError(f"Mốc hoàn thành của '{task_id}' mâu thuẫn với tiến độ công việc tiên quyết.")
        for task_id in remaining:
            if any(dep not in completed for dep in tasks[task_id].dependencies):
                raise ValueError(f"Tiến độ còn lại của '{task_id}' thiếu xác nhận cho công việc tiên quyết.")

        if self.status not in SOLVED:
            if work:
                raise ValueError("Kết quả chưa có nghiệm không thể chứa khoảng lịch đã giải.")
            return self
        if not tasks or (work.keys() | completed.keys()) != tasks.keys():
            raise ValueError("Lịch có nghiệm cần một khoảng làm việc hoặc mốc hoàn thành cho mỗi công việc.")
        if any(task.assignee_id is None for task in self.tasks):
            raise ValueError("Lịch theo thành viên có nghiệm cần mã người phụ trách cho mỗi công việc.")

        ends = {**completed, **{task_id: interval.end_day for task_id, interval in work.items()}}
        last_end_by_member: dict[str, int] = {}
        for interval in sorted(work.values(), key=lambda item: (item.start_day, item.task_id)):
            task = tasks[interval.task_id]
            duration = remaining.get(task.id, task.estimated_duration)
            ready = max(boundary, max((ends[dep] for dep in task.dependencies), default=boundary))
            if not ready <= interval.start_day < interval.end_day <= max_day or interval.end_day - interval.start_day != duration:
                raise ValueError(f"Khoảng lịch của '{task.id}' mâu thuẫn với thời lượng hoặc mốc sẵn sàng.")
            if interval.earliest_ready_day not in (None, ready) or interval.queue_wait_days not in (None, interval.start_day - ready):
                raise ValueError(f"Thông tin thời gian chờ của '{task.id}' mâu thuẫn với khoảng lịch.")
            member = task.assignee_id
            assert member is not None
            if last_end_by_member.get(member, 0) > interval.start_day:
                raise ValueError(f"Khoảng lịch của '{task.id}' chồng lấn với công việc cùng người phụ trách.")
            last_end_by_member[member] = interval.end_day
        return self


class RecoveryRequest(RecoveryModel):
    context_ref: Identifier = Field(description="Client correlation token for stale responses. It does not authenticate snapshots.")
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    intent: Intent | None = None
    focus_task_ids: list[Identifier] = Field(default_factory=list, max_length=30)
    accepted: RecoveryScheduleSnapshot | None = None
    proposal: RecoveryScheduleSnapshot | None = None

    @model_validator(mode="after")
    def validate_pair(self) -> "RecoveryRequest":
        if self.accepted is not None and self.accepted.status not in SOLVED:
            raise ValueError("Lịch đã chấp nhận phải có nghiệm.")
        if self.accepted is None or self.proposal is None:
            return self
        if self.accepted.project_ref != self.proposal.project_ref:
            raise ValueError("Hai snapshot phải thuộc cùng dự án.")
        if self.accepted.snapshot_ref == self.proposal.snapshot_ref:
            raise ValueError("Lịch đã chấp nhận và đề xuất cần mã snapshot riêng.")
        before, after = self.accepted.progress, self.proposal.progress
        if before and after:
            if after.progress_as_of_date < before.progress_as_of_date:
                raise ValueError("Ngày báo cáo của đề xuất không được trước ngày báo cáo của lịch đã chấp nhận.")
            for task_id in before.actual_finishes.keys() & after.actual_finishes.keys():
                if before.actual_finishes[task_id] != after.actual_finishes[task_id]:
                    raise ValueError(f"Hai snapshot chứa ngày hoàn thành thực tế khác nhau cho '{task_id}'.")
        if before and any(interval.task_id in before.actual_finishes for interval in self.proposal.scheduled_tasks):
            raise ValueError("Đề xuất có khoảng làm việc cho công việc đã xác nhận hoàn thành trong lịch chấp nhận.")
        return self


FactKind = Literal[
    "solver_status", "schedule", "deadline", "task", "dependency", "wait", "shared_assignee",
    "parallel", "progress", "task_change", "schedule_change", "attention",
]
FactValue = str | int | bool | None | list[str]


def fact_id(kind: FactKind, role: Role | None, *task_ids: str) -> str:
    return ":".join((role or "comparison", kind, *(quote(task_id, safe="") for task_id in task_ids)))


class RecoveryFact(RecoveryModel):
    id: str
    kind: FactKind
    role: Role | None
    task_ids: list[str] = Field(default_factory=list)
    data: dict[str, FactValue]


class RecoveryExplanation(RecoveryModel):
    id: str
    text: str
    fact_ids: list[str]
    task_ids: list[str] = Field(default_factory=list)


class RecoverySuggestion(RecoveryExplanation):
    status: Literal["unverified"] = "unverified"


class RecoveryUnknown(RecoveryModel):
    code: str
    text: str
    task_ids: list[str] = Field(default_factory=list)


class RecoveryBasis(RecoveryModel):
    accepted_ref: str | None
    proposal_ref: str | None
    selected_role: Role | None
    comparison: Literal["compared", "single_schedule", "no_schedule"]
    evaluation_deadline_date: CalendarDate | None
    intent: Intent
    highlighted_fact_ids: list[str] = Field(default_factory=list)


class RecoveryResponse(RecoveryModel):
    context_ref: str
    basis: RecoveryBasis
    facts: list[RecoveryFact]
    possible_explanations: list[RecoveryExplanation]
    suggestions: list[RecoverySuggestion]
    unknowns: list[RecoveryUnknown]
    ai_status: Literal["skipped", "used", "missing_key", "unavailable", "timeout", "invalid_output"] = "skipped"
