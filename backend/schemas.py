from pydantic import BaseModel, ConfigDict, field_validator
from typing import List, Optional

from config import settings


def _clean_str(v):
    """Shared cleaner: unwrap accidental arrays, coerce None to ''."""
    if isinstance(v, list):
        return v[0] if len(v) > 0 else ""
    if v is None:
        return ""
    return str(v).strip()


class SessionCreateRequest(BaseModel):
    """Registration/setup form payload -> creates a quiz_session + batch of questions."""
    name: str = "Student"
    exam_type: str = "General"          # e.g. WAEC / NECO / JAMB
    subject: str = "Mathematics"
    topic: Optional[str] = None
    time_limit: int = 30                # minutes
    total_questions: int = 20           # capped server-side
    min_difficulty: str = "Easy"
    max_difficulty: str = "Hard"
    custom_request: Optional[str] = None
    document_id: Optional[int] = None   # set to generate from an uploaded document

    @field_validator("name", "exam_type", "subject", "min_difficulty", "max_difficulty", mode="before")
    @classmethod
    def clean_fields(cls, v):
        return _clean_str(v)

    @field_validator("total_questions", mode="after")
    @classmethod
    def clamp_total_questions(cls, v):
        return max(1, min(v, settings.MAX_BATCH_SIZE))

    @field_validator("time_limit", mode="after")
    @classmethod
    def clamp_time_limit(cls, v):
        return max(1, min(v, 180))

    model_config = ConfigDict(extra="ignore")


class DynamicQuestion(BaseModel):
    id: Optional[int] = None
    question: str
    options: List[str]
    correct_answer: str
    concept: str
    difficulty: str
    explanation: Optional[str] = None
    misconception: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class SessionResponse(BaseModel):
    session_id: int
    user_id: int
    subject: str
    exam_type: str
    total_questions: int
    time_limit: int
    source: str = "topic"               # "topic" | "document"
    first_question: Optional[DynamicQuestion] = None


class AnswerSubmission(BaseModel):
    user_id: int
    question_id: int
    selected_answer: str

    model_config = ConfigDict(extra="ignore")


class MisconceptionFeedback(BaseModel):
    identified_misconception: Optional[str] = None
    confidence_score: Optional[float] = 0.0
    targeted_explanation: Optional[str] = None


class AnswerResult(BaseModel):
    is_correct: bool
    correct_answer: str
    misconception_analysis: Optional[MisconceptionFeedback] = None
    session_complete: bool = False


class DocumentUploadResponse(BaseModel):
    document_id: int
    filename: str
    word_count: int
    preview: str                        # short snippet so the UI can confirm content
