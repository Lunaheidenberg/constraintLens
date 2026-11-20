"""Separate request, Gemini output, and review contracts for AI planning."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator

from project_draft import DraftModel, ExtractedTask, Label, ProjectDraft, TaskID


QuestionID = Literal["Q1", "Q2", "Q3"]
Quote = Annotated[str, StringConstraints(min_length=1, max_length=500)]


class ClarifyPlanningRequest(DraftModel):
    prompt: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12_000)]


class ClarificationQuestion(DraftModel):
    id: QuestionID
    text: Label


class ClarificationResult(DraftModel):
    goal: Label | None
    questions: list[ClarificationQuestion] = Field(max_length=3)


class ClarificationAnswer(DraftModel):
    id: QuestionID
    question: Label
    answer: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1_000)] | None = None

    @field_validator("answer")
    @classmethod
    def normalize_skipped_answer(cls, answer: str | None) -> str | None:
        return answer or None


class GeneratePlanningRequest(ClarifyPlanningRequest):
    clarifications: list[ClarificationAnswer] = Field(default_factory=list, max_length=3)

    @field_validator("clarifications")
    @classmethod
    def unique_questions(cls, clarifications: list[ClarificationAnswer]) -> list[ClarificationAnswer]:
        if len({item.id for item in clarifications}) != len(clarifications):
            raise ValueError("Mã câu hỏi làm rõ phải khác nhau.")
        return clarifications


class GeminiClarification(DraftModel):
    goal: Label | None
    questions: list[Label] = Field(max_length=3)

    @field_validator("questions")
    @classmethod
    def unique_questions(cls, questions: list[str]) -> list[str]:
        if len({question.casefold() for question in questions}) != len(questions):
            raise ValueError("Các câu hỏi làm rõ phải khác nhau.")
        return questions


class PlannedTask(ExtractedTask):
    name_quote: Quote | None = None
    category_quote: Quote | None = None


class GeminiPlan(DraftModel):
    goal: Label
    goal_quote: Quote | None = None
    project_name: Label
    project_name_quote: Quote | None = None
    tasks: list[PlannedTask] = Field(min_length=1, max_length=100)
    assumptions: list[Label] = Field(max_length=12)
    uncertainties: list[Label] = Field(max_length=12)


class FieldSource(DraftModel):
    kind: Literal["description", "answer", "ai", "unknown"]
    question_id: QuestionID | None = None


class TaskSources(DraftModel):
    name: FieldSource
    category: FieldSource
    duration: FieldSource
    dependencies: FieldSource


class PlanningSources(DraftModel):
    goal: FieldSource
    project_name: FieldSource
    tasks: dict[TaskID, TaskSources]


class PlanningResult(DraftModel):
    goal: Label
    draft: ProjectDraft
    assumptions: list[Label]
    uncertainties: list[Label]
    sources: PlanningSources
