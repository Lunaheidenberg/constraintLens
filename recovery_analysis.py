"""Explain supplied schedules using date and constraint evidence from each snapshot."""

import re
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from application_guide import normalize
from project_calendar import calendar_finish, date_at_offset, day_offset
from recovery_models import (
    SOLVED, FactKind, FactValue, Intent, RecoveryBasis, RecoveryExplanation, RecoveryFact,
    RecoveryRequest, RecoveryResponse, RecoveryScheduleSnapshot, RecoverySuggestion,
    RecoveryUnknown, Role, fact_id,
)


DIRECT_INTENTS = {"changes", "deadline", "dependencies", "progress"}
FACT_ORDER: dict[Intent, tuple[FactKind, ...]] = {
    "overview": ("deadline", "schedule_change", "schedule", "attention", "solver_status"),
    "changes": ("schedule_change", "task_change", "schedule", "deadline"),
    "deadline": ("deadline", "schedule", "solver_status"),
    "dependencies": ("dependency", "wait", "parallel"),
    "progress": ("progress", "task", "schedule"),
    "attention": ("attention", "task_change", "wait", "dependency"),
    "causes": ("attention", "schedule_change", "deadline", "wait", "dependency", "progress"),
    "actions": ("attention", "deadline", "wait", "dependency", "progress"),
}
QUESTION_PATTERNS: tuple[tuple[Intent, str], ...] = (
    ("actions", r"\b(giai phap|khoi phuc|giam tre|rut ngan|cai thien|lam gi|nen lam|recover|reduce|action|fix)\b"),
    ("causes", r"\b(tai sao|vi sao|nguyen nhan|ly do|why|cause)\b"),
    ("attention", r"\b(chu y|uu tien|quan tam|priority|prioritize|attention)\b"),
    ("deadline", r"\b(han chot|dung han|qua han|tre han|tre may|tre bao nhieu|ngay ket thuc|ngay hoan thanh|"
                 r"(?:khi|ngay) nao (?:du an )?(?:hoan thanh|ket thuc|xong)|deadline|late|feasible|finish date)\b"),
    ("progress", r"\b(tien do|thuc te|da xong|con lai|thoi luong|progress|remaining|actual)\b"),
    ("dependencies", r"\b(phu thuoc|tien quyet|cho viec|cho bao lau|dependency|dependencies|prerequisite)\b"),
    ("changes", r"\b(thay doi|chuyen lich|doi lich|doi ngay|bi doi|bi doi lich|so sanh|changed|changes|moved|compare)\b"),
)
STATUS_MESSAGES = {
    "UNKNOWN": "Lần giải chưa cung cấp lịch khả thi hay bằng chứng vô nghiệm.",
    "INFEASIBLE": "Snapshot báo CP-SAT đã xác định bộ ràng buộc của lần giải không có nghiệm.",
    "INVALID_INPUT": "Dữ liệu đầu vào của lần giải không hợp lệ.",
    "MODEL_INVALID": "Mô hình của lần giải không hợp lệ.",
}


def question_intents(question: str) -> list[Intent]:
    normalized = normalize(question)
    return [intent for intent, pattern in QUESTION_PATTERNS if re.search(pattern, normalized)]


def question_focus(request: RecoveryRequest) -> set[str]:
    if request.focus_task_ids:
        return set(request.focus_task_ids)
    normalized = normalize(request.question)
    return {
        task.id
        for snapshot in (request.accepted, request.proposal) if snapshot is not None
        for task in snapshot.tasks
        if re.search(r"(?<!\w)" + re.escape(task.id) + r"(?!\w)", request.question, re.IGNORECASE if len(task.id) > 1 else 0)
        or (len(normalize(task.name)) > 2 and f" {normalize(task.name)} " in f" {normalized} ")
    }


@dataclass
class SnapshotView:
    role: Role
    snapshot: RecoveryScheduleSnapshot

    def __post_init__(self):
        self.tasks = {task.id: task for task in self.snapshot.tasks}
        self.work = {interval.task_id: interval for interval in self.snapshot.scheduled_tasks}
        self.actual = self.snapshot.actual_end_days
        self.remaining = self.snapshot.progress.remaining_durations if self.snapshot.progress else {}
        self.ends = {**self.actual, **{task_id: interval.end_day for task_id, interval in self.work.items()}}
        self.start = self.snapshot.calendar.project_start_date
        self.boundary = self.snapshot.replanning_day
        self.completed = bool(self.actual) and not self.work
        self.finish = calendar_finish(self.snapshot.calendar, max(self.ends.values()))

    def iso(self, offset: int) -> str:
        return date_at_offset(self.start, offset).isoformat()

    def start_date(self, task_id: str) -> str | None:
        return self.iso(self.work[task_id].start_day) if task_id in self.work else None

    def last_date(self, task_id: str) -> str | None:
        return self.iso(self.work[task_id].end_day - 1) if task_id in self.work else None


def _fact(kind: FactKind, role: Role | None, data: dict[str, FactValue], *task_ids: str, key: str | None = None) -> RecoveryFact:
    identity = task_ids if key is None else (key,)
    return RecoveryFact(id=fact_id(kind, role, *identity), kind=kind, role=role, task_ids=list(task_ids), data=data)


def _date_text(value: date | None) -> str | None:
    return value.isoformat() if value is not None else None


def _days_late(view: SnapshotView, deadline: date | None) -> int | None:
    final_date = view.finish.final_work_date
    assert final_date is not None
    return None if deadline is None else max(0, day_offset(deadline, final_date))


def _deadline_fact(view: SnapshotView, deadline: date | None) -> RecoveryFact:
    days_late = _days_late(view, deadline)
    assessment = "no_target"
    if days_late == 0:
        assessment = "actual_on_time" if view.completed else "schedule_on_time"
    elif days_late:
        if view.completed:
            assessment = "actual_late"
        else:
            assessment = "reported_optimal_late" if view.snapshot.status == "OPTIMAL" else "available_solution_late"
    return _fact("deadline", view.role, {
        "target_deadline_date": _date_text(deadline), "final_work_date": _date_text(view.finish.final_work_date),
        "days_late": days_late, "status": None if days_late is None else "late" if days_late else "on_time",
        "assessment": assessment,
    })


def _snapshot_facts(view: SnapshotView, deadline: date | None) -> list[RecoveryFact]:
    finish_day = view.finish.project_finish_day_exclusive
    assert finish_day is not None
    facts = [
        _fact("schedule", view.role, {
            "project_start_date": view.start.isoformat(),
            "first_scheduled_work_date": view.iso(min(item.start_day for item in view.work.values())) if view.work else None,
            "project_finish_date_exclusive": view.iso(finish_day),
            "final_work_date": view.iso(finish_day - 1),
            "completion_kind": "actual" if view.completed else "scheduled",
            "snapshot_deadline_date": _date_text(view.snapshot.calendar.target_deadline_date),
        }),
        _deadline_fact(view, deadline),
    ]
    progress = view.snapshot.progress
    if progress is not None:
        facts.append(_fact("progress", view.role, {
            "progress_as_of_date": progress.progress_as_of_date.isoformat(),
            "replanning_start_date": view.iso(view.boundary),
            "remaining_horizon_days": max(0, finish_day - view.boundary),
            "confirmed_completion_count": len(view.actual),
            "confirmed_remaining_count": len(view.remaining),
        }))

    members: dict[str, list[str]] = defaultdict(list)
    waits: dict[str, RecoveryFact] = {}
    for task_id, task in sorted(view.tasks.items()):
        interval = view.work.get(task_id)
        if task.assignee_id is not None:
            members[task.assignee_id].append(task_id)
        facts.append(_fact("task", view.role, {
            "estimated_duration": task.estimated_duration,
            "remaining_duration": view.remaining.get(task_id),
            "scheduled_duration": interval.end_day - interval.start_day if interval else None,
            "start_date": view.start_date(task_id), "final_work_date": view.last_date(task_id),
            "end_date_exclusive": view.iso(interval.end_day) if interval else None,
            "actual_finish_date": view.iso(view.actual[task_id] - 1) if task_id in view.actual else None,
            "assignee_id": task.assignee_id,
        }, task_id))

        ready = view.boundary
        for prerequisite in sorted(task.dependencies):
            end = view.ends[prerequisite]
            ready = max(ready, end)
            gap = interval.start_day - end if interval else None
            facts.append(_fact("dependency", view.role, {
                "prerequisite_end_date_exclusive": view.iso(end),
                "prerequisite_end_kind": "actual" if prerequisite in view.actual else "scheduled",
                "successor_start_date": view.start_date(task_id),
                "scheduled_gap_days": gap, "tight": gap == 0 if gap is not None else None,
            }, prerequisite, task_id))

        if interval and ready < interval.start_day:
            waits[task_id] = _fact("wait", view.role, {
                "ready_date": view.iso(ready), "start_date": view.iso(interval.start_day),
                "days": interval.start_day - ready,
            }, task_id)
            facts.append(waits[task_id])

    for member, task_ids in sorted(members.items()):
        if len(task_ids) < 2:
            continue
        ordered = sorted((view.work[task_id] for task_id in task_ids if task_id in view.work), key=lambda item: item.start_day)
        facts.append(_fact("shared_assignee", view.role, {
            "assignee_id": member, "scheduled_order": [item.task_id for item in ordered],
        }, *task_ids, key=member))
        ends = [interval.end_day for interval in ordered]
        for index, interval in enumerate(ordered):
            wait = waits.get(interval.task_id)
            if wait:
                days = wait.data["days"]
                assert isinstance(days, int)
                ready = interval.start_day - days
                first = bisect_right(ends, ready, hi=index)
                relevant = [previous.task_id for previous in ordered[first:index]]
                if relevant:
                    wait.data["same_assignee_work_during_wait"] = relevant

    active = []
    for interval in sorted(view.work.values(), key=lambda item: (item.start_day, item.task_id)):
        active = [other for other in active if other.end_day > interval.start_day]
        for other in active:
            facts.append(_fact("parallel", view.role, {
                "overlap_start_date": view.iso(interval.start_day),
                "overlap_end_date_exclusive": view.iso(min(other.end_day, interval.end_day)),
            }, *sorted((other.task_id, interval.task_id))))
        active.append(interval)
    return facts


def _delta(before: str | None, after: str | None) -> int | None:
    if before is None or after is None:
        return None
    return day_offset(date.fromisoformat(before), date.fromisoformat(after))


def _compare(before: SnapshotView, after: SnapshotView, deadline: date | None) -> list[RecoveryFact]:
    changes = []
    moved = unchanged = 0
    for task_id in sorted(before.tasks.keys() | after.tasks.keys()):
        old, new = before.tasks.get(task_id), after.tasks.get(task_id)
        old_start = before.start_date(task_id)
        start_delta = _delta(old_start, after.start_date(task_id))
        finish_delta = _delta(before.last_date(task_id), after.last_date(task_id))
        if start_delta is not None:
            if start_delta or finish_delta:
                moved += 1
            else:
                unchanged += 1
        data: dict[str, FactValue] = {
            "start_delta_days": start_delta, "finish_delta_days": finish_delta,
            "present_in_accepted": old is not None, "present_in_proposal": new is not None,
            "newly_confirmed": task_id not in before.actual and task_id in after.actual,
        }
        if old_start is not None and task_id in after.work and after.snapshot.progress is not None:
            data["prior_start_before_replanning"] = old_start < after.iso(after.boundary)
        if task_id in before.work and task_id in after.work:
            old_interval, new_interval = before.work[task_id], after.work[task_id]
            data["scheduled_duration_delta"] = (new_interval.end_day - new_interval.start_day
                                                - (old_interval.end_day - old_interval.start_day))
        if old and new:
            data.update(
                estimated_duration_delta=new.estimated_duration - old.estimated_duration,
                remaining_duration_before=before.remaining.get(task_id),
                remaining_duration_after=after.remaining.get(task_id),
                assignment_changed=old.assignee_id != new.assignee_id,
                dependencies_added=sorted(set(new.dependencies) - set(old.dependencies)),
                dependencies_removed=sorted(set(old.dependencies) - set(new.dependencies)),
            )
        changes.append(_fact("task_change", None, data, task_id))

    project_start_delta = day_offset(before.start, after.start)
    finish_delta = _delta(_date_text(before.finish.final_work_date), _date_text(after.finish.final_work_date))
    first_work_delta = _delta(
        before.iso(min(item.start_day for item in before.work.values())) if before.work else None,
        after.iso(min(item.start_day for item in after.work.values())) if after.work else None,
    )
    deadline_changed = before.snapshot.calendar.target_deadline_date != after.snapshot.calendar.target_deadline_date
    report_changed = before.snapshot.progress != after.snapshot.progress
    inputs_changed = any(
        item.data["present_in_accepted"] != item.data["present_in_proposal"]
        or any(item.data.get(key) for key in ("estimated_duration_delta", "assignment_changed", "dependencies_added", "dependencies_removed"))
        for item in changes
    )
    unchanged_schedule = not any((moved, project_start_delta, finish_delta, deadline_changed, report_changed, inputs_changed))
    late_before, late_after = _days_late(before, deadline), _days_late(after, deadline)
    return [_fact("schedule_change", None, {
        "project_start_delta_days": project_start_delta, "first_scheduled_work_delta_days": first_work_delta,
        "finish_delta_days": finish_delta, "moved_count": moved, "unchanged_interval_count": unchanged,
        "days_late_delta": late_after - late_before if late_before is not None and late_after is not None else None,
        "deadline_changed": deadline_changed, "progress_changed": report_changed, "task_inputs_changed": inputs_changed,
        "no_changes": unchanged_schedule,
    }), *changes]


def _attention(view: SnapshotView, facts: list[RecoveryFact]) -> list[RecoveryFact]:
    evidence: dict[str, list[str]] = defaultdict(list)
    deadline = _date_text(view.snapshot.calendar.target_deadline_date)
    for fact in facts:
        if fact.kind == "task_change" and isinstance(fact.data["finish_delta_days"], int) and fact.data["finish_delta_days"] > 0:
            evidence[fact.task_ids[0]].append(fact.id)
        if fact.role != view.role:
            continue
        if fact.kind == "wait" or (fact.kind == "dependency" and fact.data["tight"]):
            for task_id in fact.task_ids:
                if task_id in view.work:
                    evidence[task_id].append(fact.id)
        if fact.kind == "task":
            end = fact.data["final_work_date"]
            task_id = fact.task_ids[0]
            after_deadline = isinstance(end, str) and deadline is not None and end > deadline
            if fact.data["remaining_duration"] is not None or after_deadline:
                evidence[task_id].append(fact.id)
            if after_deadline:
                evidence[task_id].append(fact_id("deadline", view.role))
    return [_fact("attention", view.role, {"evidence_fact_ids": ids}, task_id)
            for task_id, ids in sorted(evidence.items())]


def _with_evidence(model, code: str, message: str, *facts: RecoveryFact):
    return model(
        id=f"{code}:{facts[0].id}", text=message,
        fact_ids=[fact.id for fact in facts],
        task_ids=sorted({task_id for fact in facts for task_id in fact.task_ids}),
    )


def _explain_task_change(fact: RecoveryFact, lookup: dict[str, RecoveryFact]) -> list[RecoveryExplanation]:
    task_id = fact.task_ids[0]
    data = fact.data
    explanations = []
    if data.get("prior_start_before_replanning"):
        explanations.append(_with_evidence(
            RecoveryExplanation, "replanning_boundary",
            f"Ngày bắt đầu cũ của '{task_id}' nằm trước mốc lập lại lịch. Phần việc còn lại phải bắt đầu từ mốc mới trở đi.",
            fact, lookup[fact_id("progress", "proposal")],
        ))

    if isinstance((duration_delta := data.get("scheduled_duration_delta")), int) and duration_delta:
        revised = lookup[fact_id("task", "proposal", task_id)]
        became = "tăng" if duration_delta > 0 else "giảm"
        detail = ("Khoảng mới dùng số ngày còn lại đã xác nhận." if revised.data["remaining_duration"] is not None
                  else "Khoảng mới dùng ước lượng gốc của công việc trong đề xuất.")
        explanations.append(_with_evidence(
            RecoveryExplanation, "scheduled_duration_change",
            f"Số ngày được xếp cho '{task_id}' {became} {abs(duration_delta)} ngày. {detail}", fact, revised,
        ))

    constraints = []
    if data.get("assignment_changed"):
        constraints.append("người phụ trách")
    if data.get("dependencies_added") or data.get("dependencies_removed"):
        constraints.append("công việc tiên quyết")
    if constraints and (data["start_delta_days"] or data["finish_delta_days"]):
        explanations.append(_with_evidence(
            RecoveryExplanation, "task_constraints_changed",
            f"'{task_id}' đổi {' và '.join(constraints)}. Thay đổi ràng buộc có thể góp phần làm dịch khoảng lịch.", fact,
        ))
    return explanations


def _advice(response: RecoveryResponse, view: SnapshotView | None) -> None:
    explain = response.possible_explanations
    suggest = response.suggestions
    role = view.role if view else None
    lookup = {fact.id: fact for fact in response.facts}
    for fact in response.facts:
        if fact.kind == "solver_status" and fact.data["status"] in STATUS_MESSAGES:
            explain.append(_with_evidence(RecoveryExplanation, "solve_result", STATUS_MESSAGES[fact.data["status"]], fact))
        if fact.kind == "schedule_change" and fact.data["no_changes"]:
            explain.append(_with_evidence(
                RecoveryExplanation, "no_changes", "Hai snapshot có cùng lịch, hạn và dữ liệu tiến độ dùng để đối chiếu.", fact,
            ))
        if fact.kind == "task_change":
            explain.extend(_explain_task_change(fact, lookup))
        if view is None or fact.role != role:
            continue
        if fact.kind == "deadline" and fact.data["days_late"]:
            message = f"Ngày kết thúc của bản lịch đang phân tích sau hạn {fact.data['days_late']} ngày."
            assessment = fact.data["assessment"]
            if assessment == "reported_optimal_late":
                message += (" Nếu trạng thái OPTIMAL đến từ CP-SAT của ConstraintLens cho đúng snapshot này, "
                            "mô hình đã tối thiểu hóa ngày kết thúc và ngày sớm nhất vẫn sau hạn.")
            elif assessment == "available_solution_late":
                message += " Trạng thái FEASIBLE chỉ mô tả nghiệm đang có. Có thể tồn tại nghiệm sớm hơn."
            explain.append(_with_evidence(RecoveryExplanation, "late_finish", message, fact))
        if view.completed:
            continue
        if fact.kind == "dependency" and fact.data["tight"]:
            prerequisite, task_id = fact.task_ids
            moved = lookup.get(fact_id("task_change", None, prerequisite))
            if moved and (moved.data["finish_delta_days"] or 0) > 0:
                explain.append(_with_evidence(
                    RecoveryExplanation, "tight_after_move",
                    f"'{task_id}' bắt đầu đúng mốc kết thúc của '{prerequisite}', công việc có ngày kết thúc bị dời. "
                    "Ràng buộc này có thể góp phần vào thay đổi lịch. Các ràng buộc khác cũng có thể ảnh hưởng.",
                    fact, moved,
                ))
            attention = lookup.get(fact_id("attention", role, task_id))
            if attention:
                suggest.append(_with_evidence(
                    RecoverySuggestion, "review_dependency",
                    f"Rà soát điều kiện bàn giao từ '{prerequisite}' sang '{task_id}'. "
                    "Nếu cần chỉnh phụ thuộc, kiểm tra dữ liệu và tính lại lịch trước khi đánh giá tác động.", fact,
                ))
        if fact.kind == "wait" and (other_tasks := fact.data.get("same_assignee_work_during_wait")):
            task_id = fact.task_ids[0]
            support = [lookup[fact_id("task", role, other)] for other in other_tasks]
            explain.append(_with_evidence(
                RecoveryExplanation, "shared_capacity",
                f"Trong khoảng chờ của '{task_id}', người phụ trách có lịch làm công việc khác. "
                "Ràng buộc một việc mỗi người có thể góp phần vào khoảng chờ.", fact, *support,
            ))
            suggest.append(_with_evidence(
                RecoverySuggestion, "review_assignment",
                f"Kiểm tra phân công và khả năng bàn giao cho '{task_id}'. "
                "Nếu đổi người phụ trách, tính lại lịch để đánh giá ngày kết thúc.", fact, *support,
            ))
        if fact.kind == "task" and fact.data["remaining_duration"] is not None:
            task_id = fact.task_ids[0]
            suggest.append(_with_evidence(
                RecoverySuggestion, "review_remaining",
                f"Xác nhận lại ước lượng còn lại của '{task_id}' với người phụ trách rồi tính lại lịch nếu có số liệu mới.", fact,
            ))
        elif fact.kind == "task" and isinstance((end := fact.data["final_work_date"]), str):
            deadline = lookup[fact_id("deadline", role)]
            target = deadline.data["target_deadline_date"]
            if isinstance(target, str) and end > target:
                task_id = fact.task_ids[0]
                suggest.append(_with_evidence(
                    RecoverySuggestion, "review_estimate",
                    f"Rà lại ước lượng và phạm vi của '{task_id}', hiện có ngày làm việc cuối sau hạn mục tiêu. "
                    "Nếu có dữ liệu mới, tính lại lịch để kiểm tra tác động đến hạn.", fact, deadline,
                ))
    if view and view.completed:
        explain.append(_with_evidence(
            RecoveryExplanation, "completed", "Mọi công việc đã có ngày hoàn thành xác nhận. Dự án kết thúc theo ngày thực tế muộn nhất.",
            lookup[fact_id("schedule", view.role)],
        ))


def rank_facts(response: RecoveryResponse, focus: set[str]) -> list[RecoveryFact]:
    order = {kind: index for index, kind in enumerate(FACT_ORDER[response.basis.intent])}
    return sorted(response.facts, key=lambda fact: (
        not bool(focus.intersection(fact.task_ids)), order.get(fact.kind, len(order)),
        fact.role not in (None, response.basis.selected_role), fact.id,
    ))


def analyze_recovery(request: RecoveryRequest, focus: set[str]) -> RecoveryResponse:
    intent = request.intent or next(iter(question_intents(request.question)), "overview")
    accepted = SnapshotView("accepted", request.accepted) if request.accepted is not None else None
    proposal = SnapshotView("proposal", request.proposal) if request.proposal and request.proposal.status in SOLVED else None
    selected = proposal or accepted
    deadline = selected.snapshot.calendar.target_deadline_date if selected else None
    basis = RecoveryBasis(
        accepted_ref=request.accepted.snapshot_ref if request.accepted else None,
        proposal_ref=request.proposal.snapshot_ref if request.proposal else None,
        selected_role=selected.role if selected else None,
        comparison="compared" if accepted and proposal else "single_schedule" if selected else "no_schedule",
        evaluation_deadline_date=deadline, intent=intent,
    )
    response = RecoveryResponse(context_ref=request.context_ref, basis=basis, facts=[],
                                possible_explanations=[], suggestions=[], unknowns=[])

    for role, snapshot, view in (("accepted", request.accepted, accepted), ("proposal", request.proposal, proposal)):
        if snapshot is None:
            message = "Chưa có lịch đã chấp nhận để đối chiếu." if role == "accepted" else "Chưa có lịch đề xuất để đối chiếu."
            response.unknowns.append(RecoveryUnknown(code=f"missing_{role}", text=message))
            continue
        response.facts.append(_fact("solver_status", role, {"status": snapshot.status}))
        if view:
            response.facts.extend(_snapshot_facts(view, deadline))
        else:
            response.unknowns.append(RecoveryUnknown(code="proposal_without_schedule", text=STATUS_MESSAGES[snapshot.status]))

    if accepted and proposal:
        response.facts.extend(_compare(accepted, proposal, deadline))
    if selected:
        response.facts.extend(_attention(selected, response.facts))
        if deadline is None:
            response.unknowns.append(RecoveryUnknown(code="missing_deadline", text="Bản lịch đang phân tích chưa có hạn mục tiêu."))
        if selected.snapshot.progress is None:
            response.unknowns.append(RecoveryUnknown(code="missing_confirmed_progress",
                text="Bản lịch đang phân tích thiếu báo cáo tiến độ xác nhận. Các mốc thực tế và số ngày còn lại chưa xác định."))
        if not selected.completed and intent in {"overview", "attention", "causes", "actions"}:
            response.unknowns.append(RecoveryUnknown(code="causal_impact_unverified",
                text="Chưa xác định mức đóng góp của từng ràng buộc hoặc kết quả của một phương án thay đổi."))
    known = {task_id for fact in response.facts for task_id in fact.task_ids}
    if focus - known:
        response.unknowns.append(RecoveryUnknown(code="focus_missing", text="Thiếu dữ kiện lịch cho công việc được hỏi.",
                                                 task_ids=sorted(focus - known)))
    _advice(response, selected)
    ordered = rank_facts(response, focus)
    ranks = {fact.id: i for i, fact in enumerate(ordered)}
    for items in (response.possible_explanations, response.suggestions):
        items.sort(key=lambda item: (not bool(focus.intersection(item.task_ids)), min(ranks[evidence] for evidence in item.fact_ids)))
    response.basis.highlighted_fact_ids = [fact.id for fact in ordered[:8]]
    return response
