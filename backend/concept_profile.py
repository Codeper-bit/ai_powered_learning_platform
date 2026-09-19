"""Shared 'how is this student doing on this concept' logic.

Used by:
- routers/sessions.py -> concept-aware adaptive next-question selection
- routers/progress.py -> dashboard concept mastery + the recovery flow

Kept in one place so the definition of WEAK/MASTERED/etc and the minimum
evidence required for each never drifts between the two call sites.
"""
import re
import unicodedata

import asyncpg

# Minimum attempts on a concept before we're willing to call it WEAK or
# MASTERED at all. Below this, status is always NEW/INSUFFICIENT_DATA or
# DEVELOPING, per "do not label a concept weak after only one question."
MIN_ATTEMPTS_FOR_VERDICT = 3

WEAK_ACCURACY_CEILING = 50.0
MASTERED_ACCURACY_FLOOR = 80.0


# --- Concept-name matching ---------------------------------------------------
# Concept names come from the LLM, once per generated batch, so the same idea
# shows up as "Quadratic Equations", "quadratic equation", "Quadratic-Equations "
# etc. across sessions. Compared as raw strings, that splits one concept's
# evidence over several buckets, so it never reaches MIN_ATTEMPTS_FOR_VERDICT
# and the adaptive "steer toward a weak concept" step fails to match.
# normalize_concept() gives every such variant the same comparison key. It is
# deterministic and formatting-only (case, spacing/punctuation, simple plurals):
# it never changes the stored name and it cannot tell that two genuinely
# different phrasings ("Derivatives" vs "Differentiation") mean the same thing.

def _singular(token: str) -> str:
    if len(token) <= 3:
        return token
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith(("sses", "shes", "ches", "xes", "zes")):
        return token[:-2]
    if token.endswith(("ss", "us", "is")):
        return token
    if token.endswith("s"):
        return token[:-1]
    return token


def normalize_concept(name: str | None) -> str:
    """Comparison key for a concept name: accents/case/punctuation/spacing
    folded, a leading article dropped, and each word reduced to a simple
    singular. Only ever used to compare names, never displayed or stored."""
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = text.replace("&", " and ").replace("'", "").replace("\u2019", "")
    tokens = [t for t in re.split(r"[^a-z0-9]+", text) if t]
    if len(tokens) > 1 and tokens[0] in ("the", "a", "an"):
        tokens = tokens[1:]
    key = " ".join(_singular(t) for t in tokens)
    return key or str(name).strip().lower()   # e.g. a name that is all symbols


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
    # Merge spelling/plural variants of the same concept (see above). The
    # display name is the variant with the most attempts; `variants` lists
    # every raw name so callers can query the underlying rows.
    groups: dict[str, list] = {}
    for row in rows:
        groups.setdefault(normalize_concept(row["concept"]), []).append(row)

    out = []
    for group in groups.values():
        group.sort(key=lambda r: (-r["attempts"], r["concept"]))
        attempts = sum(r["attempts"] for r in group)
        correct = sum((r["correct"] or 0) for r in group)
        accuracy = round((correct / attempts) * 100, 1) if attempts else 0.0
        out.append(
            {
                "concept": group[0]["concept"],
                "variants": [r["concept"] for r in group],
                "attempts": attempts,
                "correct": correct,
                "accuracy": accuracy,
                "status": status_for(attempts, accuracy),
            }
        )
    out.sort(key=lambda c: c["accuracy"])
    return out


async def equivalent_concepts(db: asyncpg.Pool, user_id: int, concept: str) -> list[str]:
    """Every raw concept name this student has attempts on that is the same
    concept as `concept` (always includes `concept` itself), for use in
    `q.concept = ANY(...)` filters."""
    rows = await db.fetch(
        """
        SELECT DISTINCT q.concept
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept IS NOT NULL
        """,
        user_id,
    )
    key = normalize_concept(concept)
    names = [r["concept"] for r in rows if normalize_concept(r["concept"]) == key]
    if concept not in names:
        names.append(concept)
    return names


async def get_weak_concepts(db: asyncpg.Pool, user_id: int, limit: int = 5) -> list[str]:
    """Concept names currently in WEAK status, weakest first. Requires
    MIN_ATTEMPTS_FOR_VERDICT worth of real evidence — never returns a
    concept just because a single question on it was missed."""
    stats = await get_concept_stats(db, user_id)
    return [c["concept"] for c in stats if c["status"] == "WEAK"][:limit]


async def get_concept_misconception(
    db: asyncpg.Pool, user_id: int, concept: str, variants: list[str] | None = None
) -> tuple[str | None, str | None]:
    """The most frequently recurring stored misconception for this concept,
    plus a confidence label built the same way as the live one in
    routers/attempts.py (repetition-based, never from a single miss)."""
    if variants is None:
        variants = await equivalent_concepts(db, user_id, concept)
    row = await db.fetchrow(
        """
        SELECT a.misconception, COUNT(*) AS occurrences
        FROM attempts a
        JOIN questions q ON a.question_id = q.id
        WHERE a.user_id = $1 AND q.concept = ANY($2::text[])
          AND a.is_correct = false AND a.misconception IS NOT NULL
        GROUP BY a.misconception
        ORDER BY occurrences DESC, MAX(a.created_at) DESC
        LIMIT 1
        """,
        user_id,
        variants,
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
