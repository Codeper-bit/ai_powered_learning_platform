import re
from datetime import date
from uuid import UUID

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
    """Registration/setup form payload -> creates a quiz_session + batch of questions.
    The owner is always the authenticated caller (see authn.get_current_user) —
    never taken from the request body, so one student can't create or read
    sessions under another student's id."""
    exam_type: str = "General"          # e.g. WAEC / NECO / JAMB
    subject: str = "Mathematics"
    topic: Optional[str] = None
    time_limit: int = 30                # minutes
    total_questions: int = 20           # capped server-side
    min_difficulty: str = "Easy"
    max_difficulty: str = "Hard"
    custom_request: Optional[str] = None
    # set to generate from an uploaded document
    document_id: Optional[int] = None

    @field_validator("exam_type", "subject", "min_difficulty", "max_difficulty", mode="before")
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
    # Optional map of option text -> what selecting it suggests the student
    # is confused about. Richer than the single `misconception` string when
    # the model provides it; absent/empty for older or reused questions.
    option_insights: Optional[dict] = None

    model_config = ConfigDict(extra="ignore")


class SessionResponse(BaseModel):
    session_id: int
    user_id: UUID
    subject: str
    exam_type: str
    total_questions: int
    time_limit: int
    source: str = "topic"               # "topic" | "document" | "cached"
    first_question: Optional[DynamicQuestion] = None


class AnswerSubmission(BaseModel):
    question_id: int
    selected_answer: str
    # Set by the client when this submission is being replayed from the
    # offline sync queue rather than answered live. Purely informational —
    # grading and dedup work identically either way, so this can never be
    # used to bypass validation.
    from_offline_sync: bool = False
    # Idempotency token for this ONE attempt (a client-minted UUID). The same
    # key re-sent = a duplicate of the same attempt (stored result returned,
    # nothing new recorded); a new key on an already-answered question = a
    # genuinely new attempt. Omitted = "one live answer per question" (see
    # routers/attempts.py). It only ever decides duplicate-or-not — grading
    # is always done server-side.
    attempt_key: Optional[str] = None

    @field_validator("attempt_key", mode="before")
    @classmethod
    def clean_attempt_key(cls, v):
        if v is None:
            return None
        v = str(v).strip()
        if not v:
            return None
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", v):
            raise ValueError("attempt_key must be 8-64 characters: letters, digits, '-' or '_'")
        return v

    model_config = ConfigDict(extra="ignore")


class MisconceptionFeedback(BaseModel):
    identified_misconception: Optional[str] = None
    confidence_score: Optional[float] = 0.0
    targeted_explanation: Optional[str] = None
    # Human-readable evidence label so the UI never overstates a single
    # wrong answer as a proven weakness. One of:
    # "Needs more evidence" | "Possible misconception" | "Likely weakness"
    confidence_label: Optional[str] = None


class AnswerResult(BaseModel):
    is_correct: bool
    correct_answer: str
    misconception_analysis: Optional[MisconceptionFeedback] = None
    session_complete: bool = False


class RegisterRequest(BaseModel):
    name: str
    password: str
    email: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, v):
        return _clean_str(v)

    @field_validator("email", mode="before")
    @classmethod
    def clean_email(cls, v):
        cleaned = _clean_str(v)
        return cleaned or None

    model_config = ConfigDict(extra="ignore")


class LoginRequest(BaseModel):
    name: str
    password: str

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, v):
        return _clean_str(v)

    model_config = ConfigDict(extra="ignore")


class AuthResponse(BaseModel):
    user_id: int
    name: str
    access_token: str
    token_type: str = "bearer"


class TodoCreateRequest(BaseModel):
    title: str
    subject: Optional[str] = None
    due_date: Optional[date] = None     # parsed from an ISO date string, e.g. "2026-09-20"
    priority: str = "medium"            # low | medium | high

    @field_validator("title", mode="before")
    @classmethod
    def clean_title(cls, v):
        return _clean_str(v)

    @field_validator("due_date", mode="before")
    @classmethod
    def blank_due_date_to_none(cls, v):
        return v or None

    @field_validator("priority", mode="after")
    @classmethod
    def check_priority(cls, v):
        v = (v or "medium").strip().lower()
        return v if v in ("low", "medium", "high") else "medium"

    model_config = ConfigDict(extra="ignore")


class TodoUpdateRequest(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    due_date: Optional[date] = None
    priority: Optional[str] = None
    is_complete: Optional[bool] = None

    @field_validator("due_date", mode="before")
    @classmethod
    def blank_due_date_to_none(cls, v):
        return v or None

    model_config = ConfigDict(extra="ignore")


class Todo(BaseModel):
    id: int
    title: str
    subject: Optional[str] = None
    due_date: Optional[str] = None
    priority: str
    is_complete: bool
    created_at: str


class DocumentUploadResponse(BaseModel):
    document_id: int
    filename: str
    word_count: int
    preview: str                        # short snippet so the UI can confirm content


class ConceptMastery(BaseModel):
    """Accuracy on one concept, aggregated across every session the student
    has ever done (not just the most recent one)."""
    concept: str
    attempts: int
    correct: int
    accuracy: float
    # One of: "NEW" | "DEVELOPING" | "WEAK" | "MASTERED". Requires a minimum
    # amount of evidence before ever being NEW/MASTERED/WEAK — see
    # routers/progress.py for the thresholds.
    status: str = "NEW"
    # The most frequently recurring likely misconception for this concept,
    # drawn only from attempts actually stored — never fabricated.
    suspected_misconception: Optional[str] = None
    misconception_confidence: Optional[str] = None


class RecoveryRecommendation(BaseModel):
    """The single most actionable 'what to study next' recommendation,
    built only from stored attempts — never fabricated numbers."""
    concept: str
    status: str
    evidence: str                      # e.g. "4 of your last 6 attempts were incorrect"
    recent_incorrect: int
    recent_total: int
    suspected_misconception: Optional[str] = None
    misconception_confidence: Optional[str] = None
    recommended_question_count: int = 5
    # Real before/after accuracy on this concept, only populated once there
    # are genuinely two distinct time windows of attempts to compare —
    # never fabricated or estimated.
    accuracy_before: Optional[float] = None
    accuracy_after: Optional[float] = None


class LearningCurvePoint(BaseModel):
    """One point on the learning-curve chart: a completed session's raw
    accuracy plus a smoothed trailing-average `trend` value, so the chart
    can show both the noisy per-session number and the overall direction."""
    session_id: int
    date: str
    subject: str
    attempts: int
    accuracy: float
    trend: float


class ProgressOverview(BaseModel):
    """Everything the dashboard needs in one call: the student's overall
    'impression' snapshot plus the full learning-curve series."""
    overall_accuracy: float
    total_attempts: int
    total_sessions: int
    current_streak_days: int
    best_concept: Optional[ConceptMastery] = None
    weakest_concept: Optional[ConceptMastery] = None
    concept_mastery: List[ConceptMastery]
    learning_curve: List[LearningCurvePoint]
