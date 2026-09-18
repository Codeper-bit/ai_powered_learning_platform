"""Shared 'how is this student doing on this concept' logic.

Used by:
- routers/sessions.py -> concept-aware adaptive next-question selection
- routers/progress.py -> dashboard concept mastery + the recovery flow

Kept in one place so the definition of WEAK/MASTERED/etc and the minimum
evidence required for each never drifts between the two call sites.
"""
import asyncpg

# Minimum attempts on a concept before we're willing to call it WEAK or
# MASTERED at all. Below this, status is always NEW/INSUFFICIENT_DATA or
# DEVELOPING, per "do not label a concept weak after only one question."
MIN_ATTEMPTS_FOR_VERDICT = 3

WEAK_ACCURACY_CEILING = 50.0
MASTERED_ACCURACY_FLOOR = 80.0


def status_for(attempts: int, accuracy: float) -> str:
    if attempts < MIN_ATTEMPTS_FOR_VERDICT:
        return "NEW"
    if accuracy >= MASTERED_ACCURACY_FLOOR:
        return "MASTERED"
    if accuracy <= WEAK_ACCURACY_CEILING:
        return "WEAK"
    return "DEVELOPING"


async def get_concept_stats(db: asyncpg.Pool, user_id: int) -> list[dict]:
    """Every concept the student has ever attempted, with attempts/correct/
    accuracy/status, worst accuracy first. Pulled fresh from `attempts` each
    time rather than cached, so it's always consistent with what's actually
    stored — this app has no separate mastery table to go stale."""
    rows = await db.fetch(
        """
        SELECT q.concept,
               COUNT(a.id) AS attempts,
               SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept IS NOT NULL
        GROUP BY q.concept
        """,
        user_id,
    )
    out = []
    for row in rows:
        attempts = row["attempts"]
        correct = row["correct"] or 0
        accuracy = round((correct / attempts) * 100, 1) if attempts else 0.0
        out.append(
            {
                "concept": row["concept"],
                "attempts": attempts,
                "correct": correct,
                "accuracy": accuracy,
                "status": status_for(attempts, accuracy),
            }
        )
    out.sort(key=lambda c: c["accuracy"])
    return out


async def get_weak_concepts(db: asyncpg.Pool, user_id: int, limit: int = 5) -> list[str]:
    """Concept names currently in WEAK status, weakest first. Requires
    MIN_ATTEMPTS_FOR_VERDICT worth of real evidence — never returns a
    concept just because a single question on it was missed."""
    stats = await get_concept_stats(db, user_id)
    return [c["concept"] for c in stats if c["status"] == "WEAK"][:limit]


async def get_concept_misconception(
    db: asyncpg.Pool, user_id: int, concept: str
) -> tuple[str | None, str | None]:
    """The most frequently recurring stored misconception for this concept,
    plus a confidence label built the same way as the live one in
    routers/attempts.py (repetition-based, never from a single miss)."""
    row = await db.fetchrow(
        """
        SELECT misconception, COUNT(*) AS occurrences
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept = $2
          AND a.is_correct = false AND a.misconception IS NOT NULL
        GROUP BY misconception
        ORDER BY occurrences DESC, MAX(a.created_at) DESC
        LIMIT 1
        """,
        user_id,
        concept,
    )
    if row is None:
        return None, None
    occurrences = row["occurrences"]
    if occurrences >= 3:
        label = "Likely weakness"
    elif occurrences >= 2:
        label = "Possible misconception"
    else:
        label = "Needs more evidence"
    return row["misconception"], label
