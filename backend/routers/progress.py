from datetime import date, timedelta
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends

import concept_profile
import schemas
from authn import get_current_user
from deps import get_db

router = APIRouter(prefix="/users", tags=["progress"])

# How many of the concept's most recent attempts count as "recent" for the
# recovery flow's evidence line (e.g. "4 of your last 6 attempts").
RECENT_WINDOW = 6
# Need at least this many total attempts on a concept before we're willing
# to show a real before/after split — each half must itself meet the same
# minimum-evidence bar used for a WEAK verdict in the first place.
MIN_ATTEMPTS_FOR_BEFORE_AFTER = concept_profile.MIN_ATTEMPTS_FOR_VERDICT * 2


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
    snapshot (accuracy, streak, strongest/weakest concept, per-concept
    status + suspected misconception) plus the full learning-curve series,
    aggregated across every session they've ever done — not just the last
    one (that's what /sessions/{id}/progress is for). Always the
    authenticated caller's own data — there is no path parameter to swap in
    someone else's id."""
    concept_stats = await concept_profile.get_concept_stats(db, user_id)

    concept_mastery = []
    for c in concept_stats:
        misconception, confidence = (None, None)
        if c["correct"] < c["attempts"]:
            misconception, confidence = await concept_profile.get_concept_misconception(
                db, user_id, c["concept"], c["variants"]
            )
        concept_mastery.append(
            schemas.ConceptMastery(
                concept=c["concept"] or "General",
                attempts=c["attempts"],
                correct=c["correct"],
                accuracy=c["accuracy"],
                status=c["status"],
                suspected_misconception=misconception,
                misconception_confidence=confidence,
            )
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


@router.get("/me/recovery", response_model=Optional[schemas.RecoveryRecommendation])
async def get_recovery_recommendation(
    db: asyncpg.Pool = Depends(get_db),
    user_id: int = Depends(get_current_user),
):
    """'What should I study next, and why' — the learning-recovery flow.

    Only ever surfaces a concept once its status is WEAK (i.e. it already
    has enough evidence — see concept_profile.MIN_ATTEMPTS_FOR_VERDICT).
    Returns null when there's no such concept yet, rather than inventing
    one. Every number here (evidence counts, before/after accuracy) is
    read directly from stored attempts — nothing is estimated or guessed.
    """
    stats = await concept_profile.get_concept_stats(db, user_id)
    weak = [c for c in stats if c["status"] == "WEAK"]
    if not weak:
        return None

    target = min(weak, key=lambda c: c["accuracy"])
    concept = target["concept"]

    recent_rows = await db.fetch(
        """
        SELECT a.is_correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept = ANY($2::text[])
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3
        """,
        user_id,
        target["variants"],
        RECENT_WINDOW,
    )
    recent_total = len(recent_rows)
    recent_incorrect = sum(1 for r in recent_rows if not r["is_correct"])

    misconception, confidence = await concept_profile.get_concept_misconception(
        db, user_id, concept, target["variants"]
    )

    accuracy_before = None
    accuracy_after = None
    if target["attempts"] >= MIN_ATTEMPTS_FOR_BEFORE_AFTER:
        all_rows = await db.fetch(
            """
            SELECT a.is_correct
            FROM attempts a
            JOIN questions q ON a.question_id = q.id
            WHERE a.user_id = $1 AND q.concept = ANY($2::text[])
            ORDER BY a.created_at ASC, a.id ASC
            """,
            user_id,
            target["variants"],
        )
        mid = len(all_rows) // 2
        first_half, second_half = all_rows[:mid], all_rows[mid:]
        if len(first_half) >= concept_profile.MIN_ATTEMPTS_FOR_VERDICT and \
           len(second_half) >= concept_profile.MIN_ATTEMPTS_FOR_VERDICT:
            accuracy_before = round(
                100 * sum(1 for r in first_half if r["is_correct"]) / len(first_half), 1
            )
            accuracy_after = round(
                100 * sum(1 for r in second_half if r["is_correct"]) / len(second_half), 1
            )

    return schemas.RecoveryRecommendation(
        concept=concept,
        status=target["status"],
        evidence=f"{recent_incorrect} of your last {recent_total} attempts on this concept were incorrect",
        recent_incorrect=recent_incorrect,
        recent_total=recent_total,
        suspected_misconception=misconception,
        misconception_confidence=confidence,
        recommended_question_count=5,
        accuracy_before=accuracy_before,
        accuracy_after=accuracy_after,
    )
