"""HTTP endpoint and optional evidence ranking for Recovery."""

import asyncio
import json
from collections.abc import Callable, Sequence
from typing import TypeVar

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from google import genai
from google.genai import types
from google.genai.errors import APIError
from pydantic import Field

from recovery_analysis import DIRECT_INTENTS, analyze_recovery, question_focus, question_intents, rank_facts
from recovery_models import (
    SOLVED, RecoveryExplanation, RecoveryFact, RecoveryModel, RecoveryRequest, RecoveryResponse, fact_id,
)


AI_TIMEOUT_SECONDS = 8.0
MAX_PROVIDER_FACTS = 30
MAX_PROVIDER_CANDIDATES = 10
PRIVATE_FACT_FIELDS = {
    "assignee_id", "scheduled_order", "same_assignee_work_during_wait", "dependencies_added",
    "dependencies_removed", "evidence_fact_ids",
}


class Highlight(RecoveryModel):
    fact_id: str
    task_ids: list[str] = Field(max_length=30)


class RecoverySelection(RecoveryModel):
    highlights: list[Highlight] = Field(max_length=8)
    explanation_ids: list[str] = Field(max_length=6)
    suggestion_ids: list[str] = Field(max_length=6)


_Item = TypeVar("_Item")


def _indexed(items: Sequence[_Item], prefix: str) -> dict[str, _Item]:
    return {f"{prefix}{index}": item for index, item in enumerate(items, start=1)}


def _provider_context(request: RecoveryRequest, response: RecoveryResponse, focus: set[str]):
    facts_by_id = {fact.id: fact for fact in response.facts}
    selected: dict[str, RecoveryFact] = {}

    def candidates(items: Sequence[RecoveryExplanation], prefix: str) -> dict[str, RecoveryExplanation]:
        offered = []
        for item in items:
            if len(item.fact_ids) > 8 or len(set(selected) | set(item.fact_ids)) > MAX_PROVIDER_FACTS:
                continue
            selected.update((evidence, facts_by_id[evidence]) for evidence in item.fact_ids)
            offered.append(item)
            if len(offered) == MAX_PROVIDER_CANDIDATES:
                break
        return _indexed(offered, prefix)

    explanations = candidates(response.possible_explanations, "e")
    suggestions = candidates(response.suggestions, "s")
    for fact in rank_facts(response, focus):
        if len(selected) == MAX_PROVIDER_FACTS:
            break
        if len(fact.task_ids) <= 12:
            selected[fact.id] = fact
    facts: dict[str, RecoveryFact] = _indexed(list(selected.values()), "f")
    aliases = {task: f"t{index}" for index, task in enumerate(sorted({
        task for fact in facts.values() for task in fact.task_ids
    }), start=1)}
    fact_aliases = {fact.id: alias for alias, fact in facts.items()}

    def summarize(items: dict[str, RecoveryExplanation]) -> dict:
        return {
            alias: {"type": item.id.split(":", 1)[0], "fact_ids": [fact_aliases[ref] for ref in item.fact_ids]}
            for alias, item in items.items()
        }

    # Only locally inferred topics and per-request aliases cross the provider boundary.
    contents = json.dumps({
        "intent": response.basis.intent,
        "question_topics": question_intents(request.question),
        "focus_task_ids": sorted(aliases[task] for task in focus if task in aliases),
        "facts": {
            alias: {
                "kind": fact.kind, "role": fact.role, "task_ids": [aliases[task] for task in fact.task_ids],
                "data": {key: value for key, value in fact.data.items() if key not in PRIVATE_FACT_FIELDS},
            }
            for alias, fact in facts.items()
        },
        "explanations": summarize(explanations),
        "suggestions": summarize(suggestions),
    }, ensure_ascii=False, separators=(",", ":"))
    return contents, facts, aliases, explanations, suggestions


async def _select_evidence(contents: str, api_key: str, model: str) -> RecoverySelection:
    timeout_ms = int(AI_TIMEOUT_SECONDS * 1000)
    config = types.GenerateContentConfig(
        system_instruction=(
            "Chọn và sắp xếp bằng chứng, giải thích có thể và gợi ý phù hợp với chủ đề và mã công việc. "
            "Chỉ trả mã được cung cấp trong đúng danh sách. Mỗi highlight chỉ dùng mã công việc của dữ kiện đó. "
            "Nếu thiếu căn cứ, dùng danh sách rỗng. Không tính lịch hoặc tạo nội dung mới."
        ),
        response_mime_type="application/json",
        response_json_schema=RecoverySelection.model_json_schema(),
        max_output_tokens=1024,
        thinking_config=types.ThinkingConfig(thinking_level="LOW") if model.startswith("gemini-3") else None,
    )
    with genai.Client(api_key=api_key, enterprise=False, http_options=types.HttpOptions(
        timeout=timeout_ms, retry_options=types.HttpRetryOptions(attempts=1),
    )) as client:
        async with client.aio as provider:
            reply = await provider.models.generate_content(model=model, contents=contents, config=config)
    if reply.candidates and reply.candidates[0].finish_reason not in (None, "STOP"):
        raise ValueError("Incomplete selection")
    return RecoverySelection.model_validate_json(reply.text or "")


def _validated_ids(ids: list[str], allowed: dict) -> None:
    if len(set(ids)) != len(ids) or any(item not in allowed for item in ids):
        raise ValueError("Invalid Recovery references")


def _apply_selection(
    response: RecoveryResponse, selection: RecoverySelection, facts: dict[str, RecoveryFact],
    aliases: dict[str, str], explanations: dict, suggestions: dict,
) -> None:
    highlighted = [item.fact_id for item in selection.highlights]
    _validated_ids(highlighted, facts)
    _validated_ids(selection.explanation_ids, explanations)
    _validated_ids(selection.suggestion_ids, suggestions)
    for item in selection.highlights:
        allowed_tasks = {aliases[task] for task in facts[item.fact_id].task_ids}
        if len(set(item.task_ids)) != len(item.task_ids) or not set(item.task_ids) <= allowed_tasks:
            raise ValueError("Invalid Recovery task references")

    if not (highlighted or selection.explanation_ids or selection.suggestion_ids):
        return
    if highlighted:
        chosen = [facts[alias].id for alias in highlighted]
        response.basis.highlighted_fact_ids = list(dict.fromkeys(chosen + response.basis.highlighted_fact_ids))[:8]
    for items, ids, choices in (
        (response.possible_explanations, selection.explanation_ids, explanations),
        (response.suggestions, selection.suggestion_ids, suggestions),
    ):
        chosen = [choices[alias] for alias in ids]
        chosen_ids = {item.id for item in chosen}
        items[:] = chosen + [item for item in items if item.id not in chosen_ids]
    response.ai_status = "used"


async def _enrich(
    request: RecoveryRequest, response: RecoveryResponse, focus: set[str],
    get_api_key: Callable[[], str], get_model: Callable[[], str],
) -> None:
    selected_role = response.basis.selected_role
    if (
        response.basis.intent in DIRECT_INTENTS or selected_role is None
        or (request.proposal and request.proposal.status not in SOLVED)
        or not (response.possible_explanations or response.suggestions)
    ):
        return
    facts_by_id = {fact.id: fact for fact in response.facts}
    schedule = facts_by_id[fact_id("schedule", selected_role)]
    comparison = facts_by_id.get(fact_id("schedule_change", None))
    if schedule.data["completion_kind"] == "actual" or (comparison and comparison.data["no_changes"]):
        return

    try:
        async with asyncio.timeout(AI_TIMEOUT_SECONDS):
            api_key = get_api_key().strip()
            if not api_key:
                response.ai_status = "missing_key"
                return
            contents, facts, aliases, explanations, suggestions = _provider_context(request, response, focus)
            selection = await _select_evidence(contents, api_key, get_model())
            _apply_selection(response, selection, facts, aliases, explanations, suggestions)
    except APIError as error:
        response.ai_status = "timeout" if error.code == 504 else "unavailable"
    except (TimeoutError, httpx.TimeoutException):
        response.ai_status = "timeout"
    except (httpx.TransportError, OSError):
        response.ai_status = "unavailable"
    except (ValueError, TypeError):
        response.ai_status = "invalid_output"


class RecoveryRoute(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()

        async def handle_recovery(request: Request):
            try:
                return await handle(request)
            except RequestValidationError as error:
                # Validation errors may contain the original request body and non-JSON exception objects.
                messages = [{"loc": issue["loc"], "msg": issue["msg"], "type": issue["type"]} for issue in error.errors()]
                raise HTTPException(status_code=422, detail=messages) from None

        return handle_recovery


def create_recovery_router(get_api_key: Callable[[], str], get_model: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api/recovery", route_class=RecoveryRoute)

    @router.post("/explain", response_model=RecoveryResponse)
    async def explain(payload: RecoveryRequest):
        focus = question_focus(payload)
        response = analyze_recovery(payload, focus)
        await _enrich(payload, response, focus, get_api_key, get_model)
        return response

    return router
