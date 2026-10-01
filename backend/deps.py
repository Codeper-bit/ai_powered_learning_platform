"""Shared FastAPI dependencies.

There is no login. Each browser generates a random UUID once and sends it as
`X-Device-Id`; that id owns the quizzes, attempts, documents and tasks that
browser creates, so visitors never see each other's data. This is data
separation, NOT authentication: whoever holds a given id can act as that
learner (ids are random v4 UUIDs, so they can't be guessed).
"""
import time
from collections import deque
from uuid import UUID

import asyncpg
from fastapi import Depends, HTTPException, Request

from config import settings

DEVICE_HEADER = "x-device-id"

# Learner ids already known to exist, so most requests skip the upsert.
# Bounded so a flood of random ids can't grow it without limit.
_known_learners: set[UUID] = set()
_KNOWN_LEARNERS_MAX = 20_000


async def get_db(request: Request) -> asyncpg.Pool:
    """The shared connection pool created at startup (see main.lifespan)."""
    return request.app.state.db


def parse_device_id(raw: str | None) -> UUID:
    """Strictly parse the X-Device-Id header into a UUID (400 if bad)."""
    if not raw:
        raise HTTPException(status_code=400, detail="Missing X-Device-Id header.")
    try:
        return UUID(raw.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid X-Device-Id header.")


async def get_learner(
    request: Request,
    db: asyncpg.Pool = Depends(get_db),
) -> UUID:
    """The id every router uses to scope reads/writes to one learner."""
    learner_id = parse_device_id(request.headers.get(DEVICE_HEADER))
    if learner_id not in _known_learners:
        await db.execute(
            "INSERT INTO learners (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            learner_id,
        )
        if len(_known_learners) >= _KNOWN_LEARNERS_MAX:
            _known_learners.clear()
        _known_learners.add(learner_id)
    return learner_id


class RateLimiter:
    """Small in-memory sliding-window limiter, applied per client IP and per
    device id. Per-process: with several workers each keeps its own window,
    which is fine as a cost guard (not a security boundary)."""

    def __init__(self, calls: int, per_seconds: int = 60):
        self.calls = max(1, calls)
        self.per = per_seconds
        self._hits: dict[str, deque[float]] = {}

    async def __call__(self, request: Request) -> None:
        now = time.monotonic()
        ip = request.client.host if request.client else "unknown"
        device = (request.headers.get(DEVICE_HEADER) or "")[:36]
        keys = [f"ip:{ip}"] + ([f"dev:{device}"] if device else [])

        for key in keys:
            window = self._hits.setdefault(key, deque())
            while window and now - window[0] > self.per:
                window.popleft()
            if len(window) >= self.calls:
                retry_after = max(1, int(self.per - (now - window[0])))
                raise HTTPException(
                    status_code=429,
                    detail="You're going a bit fast. Please wait a moment and try again.",
                    headers={"Retry-After": str(retry_after)},
                )
        for key in keys:
            self._hits[key].append(now)

        if len(self._hits) > 5000:  # drop idle clients
            for key in [k for k, w in self._hits.items() if not w or now - w[-1] > self.per]:
                self._hits.pop(key, None)


limit_generate = RateLimiter(settings.RATE_LIMIT_GENERATE_PER_MIN)
limit_upload = RateLimiter(settings.RATE_LIMIT_UPLOAD_PER_MIN)
