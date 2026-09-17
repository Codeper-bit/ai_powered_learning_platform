import socket

import asyncpg

from config import settings, _looks_like_placeholder_db_url

if not settings.DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set in the .env file")

_placeholder_reason = _looks_like_placeholder_db_url(settings.DATABASE_URL)
if _placeholder_reason:
    raise RuntimeError(_placeholder_reason)


async def create_pool() -> asyncpg.Pool:
    """One pooled connection set for the whole app's lifetime instead of a
    connection per request — this is what actually keeps things quick under
    concurrent users."""
    try:
        return await asyncpg.create_pool(
            settings.DATABASE_URL,
            min_size=settings.DB_POOL_MIN_SIZE,
            max_size=settings.DB_POOL_MAX_SIZE,
            command_timeout=30,
        )
    except socket.gaierror as exc:
        # This is what a bad/unreachable host in DATABASE_URL looks like —
        # turn the cryptic getaddrinfo error into something actionable.
        raise RuntimeError(
            f"Could not resolve the database host in DATABASE_URL ({exc}). "
            f"Check that DATABASE_URL in your .env points at a real, "
            f"reachable Postgres host — not a placeholder."
        ) from exc
