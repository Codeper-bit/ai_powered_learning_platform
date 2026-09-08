import json

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import ai_engine
import schemas
from deps import get_db

router = APIRouter(prefix="/sessions", tags=["sessions"])

DIFFICULTY_RANK = {"easy": 1, "medium": 2, "hard": 3}


def difficulty_rank(label: str) -> int:
    return DIFFICULTY_RANK.get((label or "").strip().lower(), 2)


def parse_options(raw_options):
    if isinstance(raw_options, str):
        return json.loads(raw_options)
    return raw_options


async def _get_or_create_user(db: asyncpg.Pool, name: str) -> int:
    row = await db.fetchrow("SELECT id FROM users WHERE name = $1 LIMIT 1", name)
    if row is None:
        row = await db.fetchrow(
            "INSERT INTO users (name) VALUES ($1) RETURNING id", name
        )
    return row["id"]


@router.post("", response_model=schemas.SessionResponse)
async def create_session(
    payload: schemas.SessionCreateRequest,
    db: asyncpg.Pool = Depends(get_db),
):
    user_id = await _get_or_create_user(db, payload.name)

    source_text = None
    subject = payload.subject
    if payload.document_id is not None:
        doc = await db.fetchrow(
            "SELECT filename, content FROM documents WHERE id = $1", payload.document_id
        )
        if doc is None:
            raise HTTPException(status_code=404, detail="Uploaded document not found")
        source_text = doc["content"]
        # Let the document drive the subject label when the user didn't set one
        if payload.subject in ("", "Mathematics"):
            subject = doc["filename"]

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
                len(batch),
                payload.min_difficulty,
                payload.max_difficulty,
                payload.custom_request,
            )
            session_id = session_row["id"]

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
                )
                for position, q in enumerate(batch, start=1)
            ]
            inserted_ids = await conn.fetch(
                """
                INSERT INTO questions
                    (session_id, position, question, options, correct_answer,
                     concept, difficulty, explanation, misconception)
                SELECT * FROM unnest(
                    $1::int[], $2::int[], $3::text[], $4::jsonb[], $5::text[],
                    $6::text[], $7::text[], $8::text[], $9::text[]
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
            )

    first_question = batch[0]
    first_question.id = inserted_ids[0]["id"]

    return schemas.SessionResponse(
        session_id=session_id,
        user_id=user_id,
        subject=subject,
        exam_type=payload.exam_type,
        total_questions=len(batch),
        time_limit=payload.time_limit,
        source="document" if source_text else "topic",
        first_question=first_question,
    )


@router.get("/{session_id}/next-question")
async def get_next_question(session_id: int, user_id: int, db: asyncpg.Pool = Depends(get_db)):
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

    best = min(
        unattempted,
        key=lambda row: (abs(difficulty_rank(row["difficulty"]) - target_rank), row["position"]),
    )

    return {
        "id": best["id"],
        "question": best["question"],
        "options": parse_options(best["options"]),
        "concept": best["concept"],
        "difficulty": best["difficulty"],
        "session_complete": False,
    }


@router.get("/{session_id}/progress")
async def get_session_progress(session_id: int, user_id: int, db: asyncpg.Pool = Depends(get_db)):
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
