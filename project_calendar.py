"""Date-only conversions at the edge of the integer scheduling model."""

import re
from datetime import date, timedelta
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, model_validator


def _parse_iso_date(value: object) -> date:
    if type(value) is date:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise ValueError("Nhập ngày hợp lệ theo định dạng YYYY-MM-DD.")


CalendarDate = Annotated[date, BeforeValidator(_parse_iso_date)]
DeadlineStatus = Literal["on_time", "late"]


def day_offset(project_start: date, day: date) -> int:
    return (day - project_start).days


def date_at_offset(project_start: date, offset: int) -> date:
    return project_start + timedelta(days=offset)


def end_of_day_boundary(project_start: date, day: date) -> int:
    """Day after an inclusive work date, expressed as an exclusive offset."""
    return day_offset(project_start, day) + 1


def calendar_range_errors(calendar: "ProjectCalendar", upper_bound: int) -> list[str]:
    if upper_bound > day_offset(calendar.project_start_date, date.max):
        return ["Khoảng lập lịch vượt quá ngày 31/12/9999. Hãy kiểm tra ngày bắt đầu và số ngày làm việc."]
    return []


class ProjectCalendar(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_start_date: CalendarDate
    target_deadline_date: CalendarDate | None = None

    @model_validator(mode="after")
    def validate_deadline(self) -> "ProjectCalendar":
        if self.target_deadline_date is not None and self.target_deadline_date < self.project_start_date:
            raise ValueError("Hạn chót mục tiêu không được trước ngày bắt đầu dự án.")
        return self


class CalendarFinish(ProjectCalendar):
    project_finish_day_exclusive: int | None = None
    project_finish_date_exclusive: date | None = None
    final_work_date: date | None = None
    deadline_status: DeadlineStatus | None = None
    days_late: int | None = None


def calendar_finish(calendar: ProjectCalendar, end_day: int | None) -> CalendarFinish:
    if end_day is None:
        return CalendarFinish(**calendar.model_dump())

    start = calendar.project_start_date
    deadline = calendar.target_deadline_date
    days_late = None if deadline is None else max(0, end_day - end_of_day_boundary(start, deadline))
    return CalendarFinish(
        **calendar.model_dump(),
        project_finish_day_exclusive=end_day,
        project_finish_date_exclusive=date_at_offset(start, end_day),
        # [start_day, end_day): the last occupied day is end_day - 1.
        final_work_date=date_at_offset(start, end_day - 1),
        deadline_status=None if days_late is None else "late" if days_late else "on_time",
        days_late=days_late,
    )
