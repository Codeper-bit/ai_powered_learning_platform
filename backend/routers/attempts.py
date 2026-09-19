import json

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import ai_engine
import concept_profile
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

    # Same concept under any spelling/plural variant the student has met it as.
    concept_names = await concept_profile.equivalent_concepts(db, user_id, concept)

    prior_same = 0
    if misconception_text:
        prior_same = await db.fetchval(
            """
            SELECT COUNT(*) FROM attempts a
            JOIN questions q ON a.question_id = q.id
            WHERE a.user_id = $1
              AND q.concept = ANY($2::text[])
              AND a.is_correct = false
              AND a.misconception = $3
            """,
            user_id,
            concept_names,
            misconception_text,
        ) or 0

    concept_stats = await db.fetchrow(
        """
        SELECT COUNT(*) AS attempts,
               SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept = ANY($2::text[])
        """,
        user_id,
        concept_names,
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


_ATTEMPT_COLUMNS = "id, question_id, is_correct, misconception, misconception_confidence"


async def _find_existing_attempt(
    db: asyncpg.Pool, user_id: int, question_id: int, attempt_key: str | None
):
    """The stored attempt this submission duplicates, or None if it's new.

    - With a key: a duplicate is the same (user, key). Anything else — even
      the same question answered again — is a genuinely new attempt.
    - Without a key: one live answer per question (the old rule). A repeat
      keyless submission is a duplicate of the first keyless one.
    """
    if attempt_key:
        return await db.fetchrow(
            f"SELECT {_ATTEMPT_COLUMNS} FROM attempts WHERE user_id = $1 AND attempt_key = $2",
            user_id,
            attempt_key,
        )
    return await db.fetchrow(
        f"SELECT {_ATTEMPT_COLUMNS} FROM attempts "
        "WHERE user_id = $1 AND question_id = $2 AND attempt_key IS NULL",
        user_id,
        question_id,
    )


def _stored_result(question, attempt, session_complete: bool) -> schemas.AnswerResult:
    """Rebuild the response for an attempt that's already on record, from
    what was stored then — a duplicate is never re-graded or re-analysed."""
    if attempt["is_correct"]:
        return schemas.AnswerResult(
            is_correct=True,
            correct_answer=question["correct_answer"],
            session_complete=session_complete,
        )
    analysis = None
    if attempt["misconception"]:
        label = attempt["misconception_confidence"]
        analysis = schemas.MisconceptionFeedback(
            identified_misconception=attempt["misconception"],
            confidence_score=next(
                (CONFIDENCE_SCORES[k] for k, v in CONFIDENCE_LABELS.items() if v == label), None
            ),
            targeted_explanation=question["explanation"]
            or "Review the concept and try a similar question.",
            confidence_label=label,
        )
    return schemas.AnswerResult(
        is_correct=False,
        correct_answer=question["correct_answer"],
        misconception_analysis=analysis,
        session_complete=session_complete,
    )


async def _session_complete(db: asyncpg.Pool, session_id: int, user_id: int) -> bool:
    remaining = await db.fetchval(
        """
        SELECT COUNT(*) FROM questions q
        WHERE q.session_id = $1
          AND NOT EXISTS (
              SELECT 1 FROM attempts a
              WHERE a.question_id = q.id AND a.user_id = $2
          )
        """,
        session_id,
        user_id,
    )
    if remaining == 0:
        await db.execute(
            "UPDATE quiz_sessions SET status = 'completed' WHERE id = $1", session_id
        )
        return True
    return False


@router.post("", response_model=schemas.AnswerResult)
async def submit_answer(
    submission: schemas.AnswerSubmission,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    """Grade an answer and record it as a NEW attempt row.

    This is the single choke point for both live and offline-synced
    submissions (see api.js / App.jsx sync queue): correctness is always
    recalculated here from the stored correct_answer, never trusted from
    the client.

    Attempts are append-only history: nothing here updates or deletes an
    existing attempt. A submission is a *duplicate* (and records nothing new,
    returning the stored result) only when it repeats an attempt already on
    record — same attempt_key, or, for keyless submissions, same question.
    Answering a question again under a new attempt_key (e.g. replaying an
    offline bank) is a new attempt and gets its own row.
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

    # Duplicate check FIRST: a duplicate must not be re-graded, must not call
    # the AI again, and must not count itself as prior evidence when the
    # confidence label is computed below.
    existing = await _find_existing_attempt(
        db, user_id, submission.question_id, submission.attempt_key
    )
    if existing is not None and existing["question_id"] != submission.question_id:
        raise HTTPException(
            status_code=409, detail="attempt_key was already used for a different question"
        )
    if existing is not None:
        complete = await _session_complete(db, question["session_id"], user_id)
        return _stored_result(question, existing, complete)

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

    # Append-only insert. The conflict target is whichever unique index this
    # submission falls under (see schema.sql); DO NOTHING — never DO UPDATE —
    # so losing a race with an identical concurrent request can't overwrite
    # anything either.
    conflict_target = (
        "(user_id, attempt_key) WHERE attempt_key IS NOT NULL"
        if submission.attempt_key
        else "(user_id, question_id) WHERE attempt_key IS NULL"
    )
    inserted = await db.fetchval(
        f"""
        INSERT INTO attempts
            (user_id, question_id, answer, is_correct, misconception,
             misconception_confidence, synced_from_offline, attempt_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT {conflict_target} DO NOTHING
        RETURNING id
        """,
        user_id,
        submission.question_id,
        submission.selected_answer,
        result.is_correct,
        misconception_text,
        confidence_label,
        submission.from_offline_sync,
        submission.attempt_key,
    )

    if inserted is None:
        # An identical request committed between our check and our insert.
        # Return what was stored, exactly as for any other duplicate.
        existing = await _find_existing_attempt(
            db, user_id, submission.question_id, submission.attempt_key
        )
        if existing is None or existing["question_id"] != submission.question_id:
            raise HTTPException(
                status_code=409, detail="attempt_key was already used for a different question"
            )
        complete = await _session_complete(db, question["session_id"], user_id)
        return _stored_result(question, existing, complete)

    result.session_complete = await _session_complete(db, question["session_id"], user_id)
    return result
