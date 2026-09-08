import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import ai_engine
import schemas
from deps import get_db

router = APIRouter(prefix="/attempts", tags=["attempts"])


@router.post("", response_model=schemas.AnswerResult)
async def submit_answer(
    submission: schemas.AnswerSubmission,
    db: asyncpg.Pool = Depends(get_db),
):
    question = await db.fetchrow(
        """
        SELECT id, session_id, question, correct_answer, explanation, misconception
        FROM questions
        WHERE id = $1
        """,
        submission.question_id,
    )
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")

    result = await ai_engine.analyze_user_attempt(
        question_text=question["question"],
        correct_answer=question["correct_answer"],
        selected_answer=submission.selected_answer,
        stored_explanation=question["explanation"],
        stored_misconception=question["misconception"],
    )

    # ON CONFLICT makes a double-submit (double click, retry after a slow
    # network) safe: it just re-records the same answer instead of creating
    # a second attempt row that would skew progress stats.
    await db.execute(
        """
        INSERT INTO attempts (user_id, question_id, answer, is_correct)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, question_id)
        DO UPDATE SET answer = EXCLUDED.answer, is_correct = EXCLUDED.is_correct
        """,
        submission.user_id,
        submission.question_id,
        submission.selected_answer,
        result.is_correct,
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
        submission.user_id,
    )
    result.session_complete = remaining == 0
    if result.session_complete:
        await db.execute(
            "UPDATE quiz_sessions SET status = 'completed' WHERE id = $1",
            question["session_id"],
        )

    return result
