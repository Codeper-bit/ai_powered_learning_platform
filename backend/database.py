import asyncpg

from config import settings

if not settings.DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set in the .env file")


async def create_pool() -> asyncpg.Pool:
    """One pooled connection set for the whole app's lifetime instead of a
    connection per request — this is what actually keeps things quick under
    concurrent users."""
    return await asyncpg.create_pool(
        settings.DATABASE_URL,
        min_size=settings.DB_POOL_MIN_SIZE,
        max_size=settings.DB_POOL_MAX_SIZE,
        command_timeout=30,
    )
