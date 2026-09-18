import json

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import ai_engine
import schemas
from authn import get_current_user
from deps import get_db

router = APIRouter(prefix="/attempts", tags=["attempts"])

# Minimum number of PRIOR matching wrong answers (in addition to the current
# one) before the label escalates. This is the "don't call it a weakness
# after one question" rule from the brief — counts are of attempts actually
# stored in the database, never estimated.
MIN_PRIOR_FOR_POSSIBLE = 1   # -> 2 total occurrences of the same misconception
MIN_PRIOR_FOR_LIKELY = 2     # -> 3 total occurrences of the same misconception

CONFIDENCE_LABELS = {
    "needs_more_evidence": "Needs more evidence",
    "possible": "Possible misconception",
    "likely": "Likely weakness",
}
CONFIDENCE_SCORES = {
    "needs_more_evidence": 0.35,
    "possible": 0.6,
    "likely": 0.85,
}


async def _confidence_label(
    db: asyncpg.Pool,
    user_id: int,
    concept: str | None,
    misconception_text: str | None,
) -> str:
    """Decide how confident we are that this reflects a real, recurring gap
    rather than a single slip — using only attempts actually stored for
    this user. Never treats one wrong answer as proof of anything.

    Confidence rises when either:
    - the SAME misconception text has recurred on this concept before, or
    - the student is also generally missing OTHER questions on this
      concept (a supporting signal, similar in spirit to the brief's
      "poor performance on related prerequisite concepts" example).
    """
    if not concept:
        return "needs_more_evidence"

    prior_same = 0
    if misconception_text:
        prior_same = await db.fetchval(
            """
            SELECT COUNT(*) FROM attempts a
            JOIN questions q ON a.question_id = q.id
            WHERE a.user_id = $1
              AND q.concept = $2
              AND a.is_correct = false
              AND a.misconception = $3
            """,
            user_id,
            concept,
            misconception_text,
        ) or 0

    concept_stats = await db.fetchrow(
        """
        SELECT COUNT(*) AS attempts,
               SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept = $2
        """,
        user_id,
        concept,
    )
    concept_attempts = concept_stats["attempts"] or 0
    concept_correct = concept_stats["correct"] or 0
    concept_wrong = concept_attempts - concept_correct

    if prior_same >= MIN_PRIOR_FOR_LIKELY:
        return "likely"
    # A broader "this concept keeps going wrong" pattern (>=3 total misses,
    # i.e. this one plus 2 prior) is corroborating evidence even if the
    # exact misconception wording varies between attempts.
    if prior_same >= MIN_PRIOR_FOR_POSSIBLE or concept_wrong >= 3:
        return "possible"
    return "needs_more_evidence"


@router.post("", response_model=schemas.AnswerResult)
async def submit_answer(
    submission: schemas.AnswerSubmission,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    """Grade an answer and record it.

    This is the single choke point for both live and offline-synced
    submissions (see api.js / App.jsx sync queue): correctness is always
    recalculated here from the stored correct_answer, never trusted from
    the client, and the UNIQUE(user_id, question_id) constraint makes a
    duplicate sync retry a no-op update rather than a second row.
    """
    question = await db.fetchrow(
        """
        SELECT q.id, q.session_id, q.question, q.correct_answer, q.concept,
               q.explanation, q.misconception, q.option_insights,
               qs.user_id AS session_owner_id
        FROM questions q
        JOIN quiz_sessions qs ON qs.id = q.session_id
        WHERE q.id = $1
        """,
        submission.question_id,
    )
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    if question["session_owner_id"] != user_id:
        # A question always belongs to one session, and a session to one
        # student — this stops one student from recording (or overwriting,
        # via the ON CONFLICT upsert below) an attempt against a session
        # they don't own.
        raise HTTPException(status_code=403, detail="This question belongs to a different user's session")

    option_insights = question["option_insights"]
    if isinstance(option_insights, str):
        try:
            option_insights = json.loads(option_insights)
        except (TypeError, ValueError):
            option_insights = None

    result = await ai_engine.analyze_user_attempt(
        question_text=question["question"],
        correct_answer=question["correct_answer"],
        selected_answer=submission.selected_answer,
        stored_explanation=question["explanation"],
        stored_misconception=question["misconception"],
        option_insights=option_insights,
    )

    misconception_text = None
    confidence_label = None
    if not result.is_correct and result.misconception_analysis:
        misconception_text = result.misconception_analysis.identified_misconception
        label_key = await _confidence_label(
            db, user_id, question["concept"], misconception_text
        )
        confidence_label = CONFIDENCE_LABELS[label_key]
        result.misconception_analysis.confidence_label = confidence_label
        # Keep the numeric score consistent with the evidence-based label
        # instead of always reporting a flat 1.0 for a single wrong answer.
        result.misconception_analysis.confidence_score = CONFIDENCE_SCORES[label_key]

    await db.execute(
        """
        INSERT INTO attempts
            (user_id, question_id, answer, is_correct, misconception,
             misconception_confidence, synced_from_offline)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, question_id)
        DO UPDATE SET answer = EXCLUDED.answer,
                      is_correct = EXCLUDED.is_correct,
                      misconception = EXCLUDED.misconception,
                      misconception_confidence = EXCLUDED.misconception_confidence
        """,
        user_id,
        submission.question_id,
        submission.selected_answer,
        result.is_correct,
        misconception_text,
        confidence_label,
        submission.from_offline_sync,
    )

    remaining = await db.fetchval(
        """
        SELECT COUNT(*) FROM questions q
        WHERE q.session_id = $1
          AND NOT EXISTS (
              SELECT 1 FROM attempts a
              WHERE a.question_id = q.id AND a.user_id = $2
          )
        """,
        question["session_id"],
        user_id,
    )
    result.session_complete = remaining == 0
    if result.session_complete:
        await db.execute(
            "UPDATE quiz_sessions SET status = 'completed' WHERE id = $1",
            question["session_id"],
        )

    return result
