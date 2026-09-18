import json

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import ai_engine
import concept_profile
import schemas
from authn import get_current_user
from config import settings
from deps import get_db

router = APIRouter(prefix="/sessions", tags=["sessions"])

DIFFICULTY_RANK = {"easy": 1, "medium": 2, "hard": 3}

# How many of the (adaptively) next-picked questions in a row we're willing
# to steer toward a weak concept before letting normal difficulty-based
# selection take over again for a bit. Keeps the loop from just hammering
# one concept forever ("do not make the system endlessly give the student
# the same type of question") while still surfacing it repeatedly enough to
# reassess whether the student has actually improved.
WEAK_CONCEPT_STREAK_CAP = 3


def difficulty_rank(label: str) -> int:
    return DIFFICULTY_RANK.get((label or "").strip().lower(), 2)


def parse_options(raw_options):
    if isinstance(raw_options, str):
        return json.loads(raw_options)
    return raw_options


def parse_insights(raw_insights):
    if raw_insights is None:
        return None
    if isinstance(raw_insights, str):
        try:
            return json.loads(raw_insights)
        except (TypeError, ValueError):
            return None
    return raw_insights


async def _require_session_owner(db: asyncpg.Pool, session_id: int, user_id: int) -> None:
    """Every session-scoped endpoint below depends on this. A student can
    only ever read/act on their own session — never taken on faith from the
    URL alone."""
    owner = await db.fetchval(
        "SELECT user_id FROM quiz_sessions WHERE id = $1", session_id
    )
    if owner is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if owner != user_id:
        raise HTTPException(status_code=403, detail="This session belongs to a different user")


async def _find_reusable_batch(
    db: asyncpg.Pool,
    subject: str,
    exam_type: str,
    min_difficulty: str,
    max_difficulty: str,
    custom_request: str | None,
    total_questions: int,
) -> int | None:
    """The caching layer: look for a recent topic-based (non-document)
    batch that already matches these exact generation parameters and has
    at least as many questions as requested. If found, its questions get
    copied into the new session instead of calling the LLM again — this is
    what keeps token spend from scaling linearly with traffic on popular
    subject/difficulty combinations.

    Deliberately excludes document-based sessions (each document's content
    is unique, so there's nothing to reuse) and caps how many times any one
    batch can be reused (QUESTION_REUSE_MAX_COUNT) so content still
    refreshes periodically under sustained load rather than one batch
    circulating forever.
    """
    row = await db.fetchrow(
        """
        SELECT id FROM quiz_sessions
        WHERE document_id IS NULL
          AND subject = $1
          AND exam_type = $2
          AND min_difficulty = $3
          AND max_difficulty = $4
          AND custom_request IS NOT DISTINCT FROM $5
          AND total_questions >= $6
          AND reuse_count < $7
          AND created_at > now() - make_interval(days => $8)
        ORDER BY created_at DESC
        LIMIT 1
        """,
        subject,
        exam_type,
        min_difficulty,
        max_difficulty,
        custom_request,
        total_questions,
        settings.QUESTION_REUSE_MAX_COUNT,
        settings.QUESTION_REUSE_WINDOW_DAYS,
    )
    return row["id"] if row else None


async def _clone_batch(
    conn: asyncpg.Connection,
    source_session_id: int,
    new_session_id: int,
    total_questions: int,
) -> None:
    """Copy another session's questions into a brand-new session — no LLM
    call, just a DB-side copy. Runs inside the same transaction as the new
    session's own INSERT, so a failure here can't leave a session with a
    mismatched or empty question set."""
    await conn.execute(
        """
        INSERT INTO questions
            (session_id, position, question, options, correct_answer,
             concept, difficulty, explanation, misconception, option_insights)
        SELECT $1, position, question, options, correct_answer,
               concept, difficulty, explanation, misconception, option_insights
        FROM questions
        WHERE session_id = $2
        ORDER BY position ASC
        LIMIT $3
        """,
        new_session_id,
        source_session_id,
        total_questions,
    )
    await conn.execute(
        "UPDATE quiz_sessions SET reuse_count = reuse_count + 1 WHERE id = $1",
        source_session_id,
    )


@router.post("", response_model=schemas.SessionResponse)
async def create_session(
    payload: schemas.SessionCreateRequest,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    source_text = None
    subject = payload.subject
    if payload.document_id is not None:
        doc = await db.fetchrow(
            "SELECT filename, content, user_id FROM documents WHERE id = $1",
            payload.document_id,
        )
        if doc is None:
            raise HTTPException(status_code=404, detail="Uploaded document not found")
        # A document's content is study material the uploader chose to
        # share with the AI, not with other students — quizzing on it must
        # stay confined to whoever uploaded it.
        if doc["user_id"] is not None and doc["user_id"] != user_id:
            raise HTTPException(status_code=403, detail="This document belongs to a different user")
        source_text = doc["content"]
        # Let the document drive the subject label when the user didn't set one
        if payload.subject in ("", "Mathematics"):
            subject = doc["filename"]

    reused_from = None
    if payload.document_id is None:
        reused_from = await _find_reusable_batch(
            db,
            subject=subject,
            exam_type=payload.exam_type,
            min_difficulty=payload.min_difficulty,
            max_difficulty=payload.max_difficulty,
            custom_request=payload.custom_request,
            total_questions=payload.total_questions,
        )

    batch = None
    if reused_from is None:
        try:
            batch = await ai_engine.generate_question_batch(
                exam_type=payload.exam_type,
                subject=subject,
                topic=payload.topic,
                min_difficulty=payload.min_difficulty,
                max_difficulty=payload.max_difficulty,
                total_questions=payload.total_questions,
                custom_request=payload.custom_request,
                source_text=source_text,
            )
        except ValueError as e:
            raise HTTPException(status_code=502, detail=str(e))

    async with db.acquire() as conn:
        async with conn.transaction():
            session_row = await conn.fetchrow(
                """
                INSERT INTO quiz_sessions
                    (user_id, document_id, exam_type, subject, topic, time_limit,
                     total_questions, min_difficulty, max_difficulty, custom_request)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id
                """,
                user_id,
                payload.document_id,
                payload.exam_type,
                subject,
                payload.topic,
                payload.time_limit,
                payload.total_questions if reused_from is not None else len(batch),
                payload.min_difficulty,
                payload.max_difficulty,
                payload.custom_request,
            )
            session_id = session_row["id"]

            if reused_from is not None:
                # Cache hit — copy an existing batch's questions instead of
                # generating new ones. No LLM call happens on this path.
                await _clone_batch(conn, reused_from, session_id, payload.total_questions)
                inserted_ids = await conn.fetch(
                    "SELECT id FROM questions WHERE session_id = $1 ORDER BY position ASC",
                    session_id,
                )
            else:
                # Bulk insert the whole batch in one round trip instead of N
                # sequential awaits — this is the main win for "no delay" at
                # session-start time.
                rows = [
                    (
                        session_id,
                        position,
                        q.question,
                        json.dumps(q.options),
                        q.correct_answer,
                        q.concept,
                        q.difficulty,
                        q.explanation,
                        q.misconception,
                        json.dumps(q.option_insights) if q.option_insights else None,
                    )
                    for position, q in enumerate(batch, start=1)
                ]
                inserted_ids = await conn.fetch(
                    """
                    INSERT INTO questions
                        (session_id, position, question, options, correct_answer,
                         concept, difficulty, explanation, misconception, option_insights)
                    SELECT * FROM unnest(
                        $1::int[], $2::int[], $3::text[], $4::jsonb[], $5::text[],
                        $6::text[], $7::text[], $8::text[], $9::text[], $10::jsonb[]
                    )
                    RETURNING id
                    """,
                    [session_id] * len(rows),
                    [r[1] for r in rows],
                    [r[2] for r in rows],
                    [r[3] for r in rows],
                    [r[4] for r in rows],
                    [r[5] for r in rows],
                    [r[6] for r in rows],
                    [r[7] for r in rows],
                    [r[8] for r in rows],
                    [r[9] for r in rows],
                )

    if reused_from is not None:
        first_row = await db.fetchrow(
            """
            SELECT id, question, options, correct_answer, concept, difficulty,
                   explanation, misconception, option_insights
            FROM questions WHERE session_id = $1 ORDER BY position ASC LIMIT 1
            """,
            session_id,
        )
        first_question = schemas.DynamicQuestion(
            id=first_row["id"],
            question=first_row["question"],
            options=parse_options(first_row["options"]),
            correct_answer=first_row["correct_answer"],
            concept=first_row["concept"],
            difficulty=first_row["difficulty"],
            explanation=first_row["explanation"],
            misconception=first_row["misconception"],
            option_insights=parse_insights(first_row["option_insights"]),
        )
        total_generated = len(inserted_ids)
    else:
        first_question = batch[0]
        first_question.id = inserted_ids[0]["id"]
        total_generated = len(batch)

    return schemas.SessionResponse(
        session_id=session_id,
        user_id=user_id,
        subject=subject,
        exam_type=payload.exam_type,
        total_questions=total_generated,
        time_limit=payload.time_limit,
        source="document" if source_text else ("cached" if reused_from is not None else "topic"),
        first_question=first_question,
    )


@router.get("/{session_id}/next-question")
async def get_next_question(
    session_id: int,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    await _require_session_owner(db, session_id, user_id)

    # NOT EXISTS (indexed anti-join) instead of NOT IN: scales better as
    # attempts grow and sidesteps NOT IN's NULL-handling footgun.
    unattempted = await db.fetch(
        """
        SELECT q.id, q.question, q.options, q.correct_answer, q.concept,
               q.difficulty, q.explanation, q.misconception, q.position
        FROM questions q
        WHERE q.session_id = $1
          AND NOT EXISTS (
              SELECT 1 FROM attempts a
              WHERE a.question_id = q.id AND a.user_id = $2
          )
        ORDER BY q.position ASC
        """,
        session_id,
        user_id,
    )

    if not unattempted:
        return {"message": "No more questions in this session", "session_complete": True}

    last_attempt = await db.fetchrow(
        """
        SELECT q.difficulty, a.is_correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.session_id = $2
        ORDER BY a.created_at DESC
        LIMIT 1
        """,
        user_id,
        session_id,
    )

    # Adaptive pick: nudge difficulty up after a correct answer, down after a
    # wrong one; fall back to the easiest remaining question at the start.
    if last_attempt is None:
        target_rank = 1
    else:
        current_rank = difficulty_rank(last_attempt["difficulty"])
        target_rank = current_rank + 1 if last_attempt["is_correct"] else current_rank - 1
        target_rank = max(1, min(3, target_rank))

    # --- Concept-aware layer ---------------------------------------------
    # On top of difficulty, steer toward a concept the student's OVERALL
    # profile (across every session, not just this one) shows as WEAK —
    # requires real evidence (see concept_profile.MIN_ATTEMPTS_FOR_VERDICT),
    # so this never kicks in off a single missed question. Capped at
    # WEAK_CONCEPT_STREAK_CAP consecutive picks so the loop still varies
    # instead of drilling one concept forever, and only used when a
    # scaffolding-appropriate question on that concept actually remains.
    candidate_pool = unattempted
    weak_concepts = await concept_profile.get_weak_concepts(db, user_id)
    if weak_concepts:
        recent_weak_streak = await db.fetchval(
            """
            SELECT COUNT(*) FROM (
                SELECT q.concept
                FROM attempts a
                JOIN questions q ON a.question_id = q.id
                WHERE a.user_id = $1 AND q.session_id = $2
                ORDER BY a.created_at DESC
                LIMIT $3
            ) recent
            WHERE recent.concept = ANY($4::text[])
            """,
            user_id,
            session_id,
            WEAK_CONCEPT_STREAK_CAP,
            weak_concepts,
        )
        if (recent_weak_streak or 0) < WEAK_CONCEPT_STREAK_CAP:
            targeted = [row for row in unattempted if row["concept"] in weak_concepts]
            if targeted:
                candidate_pool = targeted

    best = min(
        candidate_pool,
        key=lambda row: (abs(difficulty_rank(row["difficulty"]) - target_rank), row["position"]),
    )

    return {
        "id": best["id"],
        "question": best["question"],
        "options": parse_options(best["options"]),
        "concept": best["concept"],
        "difficulty": best["difficulty"],
        "session_complete": False,
        "targeting_weak_concept": candidate_pool is not unattempted,
    }


@router.get("/{session_id}/progress")
async def get_session_progress(
    session_id: int,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    await _require_session_owner(db, session_id, user_id)

    rows = await db.fetch(
        """
        SELECT
            q.concept,
            COUNT(a.id) AS attempts,
            SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.session_id = $2
        GROUP BY q.concept
        ORDER BY q.concept
        """,
        user_id,
        session_id,
    )

    progress = []
    for row in rows:
        attempts = row["attempts"]
        correct = row["correct"]
        accuracy = (correct / attempts) * 100 if attempts else 0
        progress.append(
            {
                "concept": row["concept"],
                "attempts": attempts,
                "correct": correct,
                "accuracy": round(accuracy, 2),
            }
        )

    return progress


@router.get("/{session_id}/questions", response_model=list[schemas.DynamicQuestion])
async def get_session_questions(
    session_id: int,
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    """Return the whole question batch (including correct answers and
    explanations) for local caching. Used by the frontend to build an
    offline practice bank: since the whole batch was already generated
    and stored at session-creation time, no AI call happens here — this
    just hands back what's already in Postgres so the client can replay
    the quiz later with zero network calls, even with no internet.
    """
    await _require_session_owner(db, session_id, user_id)

    rows = await db.fetch(
        """
        SELECT id, question, options, correct_answer, concept, difficulty,
               explanation, misconception, option_insights
        FROM questions
        WHERE session_id = $1
        ORDER BY position ASC
        """,
        session_id,
    )

    return [
        schemas.DynamicQuestion(
            id=row["id"],
            question=row["question"],
            options=parse_options(row["options"]),
            correct_answer=row["correct_answer"],
            concept=row["concept"],
            difficulty=row["difficulty"],
            explanation=row["explanation"],
            misconception=row["misconception"],
            option_insights=parse_insights(row["option_insights"]),
        )
        for row in rows
    ]
