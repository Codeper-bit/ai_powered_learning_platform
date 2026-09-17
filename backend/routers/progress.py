from datetime import date, timedelta

import asyncpg
from fastapi import APIRouter, Depends

import schemas
from authn import get_current_user
from deps import get_db

router = APIRouter(prefix="/users", tags=["progress"])


def _rolling_average(values: list[float], window: int = 3) -> list[float]:
    """Trailing moving average — smooths session-to-session noise so the
    learning-curve trend line reads as a direction instead of a zigzag."""
    out = []
    for i in range(len(values)):
        chunk = values[max(0, i - window + 1): i + 1]
        out.append(round(sum(chunk) / len(chunk), 2))
    return out


def _current_streak(attempt_dates: list[date]) -> int:
    """Count consecutive practice days, ending today or yesterday (so the
    streak doesn't zero out the moment someone hasn't practiced *yet* today).
    `attempt_dates` must be distinct calendar dates, sorted descending."""
    if not attempt_dates:
        return 0
    today = date.today()
    if attempt_dates[0] not in (today, today - timedelta(days=1)):
        return 0
    streak = 1
    for i in range(1, len(attempt_dates)):
        if attempt_dates[i - 1] - attempt_dates[i] == timedelta(days=1):
            streak += 1
        else:
            break
    return streak


@router.get("/me/overview", response_model=schemas.ProgressOverview)
async def get_progress_overview(
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    """Cross-session dashboard data: the student's overall 'impression'
    snapshot (accuracy, streak, strongest/weakest concept) plus the full
    learning-curve series, aggregated across every session they've ever
    done — not just the last one (that's what /sessions/{id}/progress is
    for). Always the authenticated caller's own data — there is no path
    parameter to swap in someone else's id."""
    concept_rows = await db.fetch(
        """
        SELECT q.concept,
               COUNT(a.id) AS attempts,
               SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1
        GROUP BY q.concept
        ORDER BY (SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::float
                  / NULLIF(COUNT(a.id), 0)) ASC
        """,
        user_id,
    )

    session_rows = await db.fetch(
        """
        SELECT qs.id AS session_id, qs.subject, qs.created_at,
               COUNT(a.id) AS attempts,
               SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM quiz_sessions qs
        JOIN questions q ON q.session_id = qs.id
        JOIN attempts a ON a.question_id = q.id AND a.user_id = qs.user_id
        WHERE qs.user_id = $1
        GROUP BY qs.id, qs.subject, qs.created_at
        HAVING COUNT(a.id) > 0
        ORDER BY qs.created_at ASC
        """,
        user_id,
    )

    date_rows = await db.fetch(
        "SELECT DISTINCT created_at::date AS d FROM attempts WHERE user_id = $1 ORDER BY d DESC",
        user_id,
    )

    concept_mastery = [
        schemas.ConceptMastery(
            concept=row["concept"] or "General",
            attempts=row["attempts"],
            correct=row["correct"],
            accuracy=round((row["correct"] / row["attempts"]) * 100, 1) if row["attempts"] else 0.0,
        )
        for row in concept_rows
    ]

    session_accuracies = [
        round((row["correct"] / row["attempts"]) * 100, 1) if row["attempts"] else 0.0
        for row in session_rows
    ]
    trend = _rolling_average(session_accuracies)

    learning_curve = [
        schemas.LearningCurvePoint(
            session_id=row["session_id"],
            date=row["created_at"].date().isoformat(),
            subject=row["subject"],
            attempts=row["attempts"],
            accuracy=session_accuracies[i],
            trend=trend[i],
        )
        for i, row in enumerate(session_rows)
    ]

    total_attempts = sum(c.attempts for c in concept_mastery)
    total_correct = sum(c.correct for c in concept_mastery)
    overall_accuracy = round((total_correct / total_attempts) * 100, 1) if total_attempts else 0.0

    # Prefer concepts with >=2 attempts for "best/weakest" so a single lucky
    # or unlucky guess on a brand-new concept doesn't dominate the headline.
    qualifying = [c for c in concept_mastery if c.attempts >= 2] or concept_mastery
    best_concept = max(qualifying, key=lambda c: c.accuracy) if qualifying else None
    weakest_concept = min(qualifying, key=lambda c: c.accuracy) if qualifying else None

    streak = _current_streak([row["d"] for row in date_rows])

    return schemas.ProgressOverview(
        overall_accuracy=overall_accuracy,
        total_attempts=total_attempts,
        total_sessions=len(session_rows),
        current_streak_days=streak,
        best_concept=best_concept,
        weakest_concept=weakest_concept,
        concept_mastery=concept_mastery,
        learning_curve=learning_curve,
    )
