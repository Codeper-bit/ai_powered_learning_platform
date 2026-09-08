"""Shared FastAPI dependencies."""
from fastapi import Request
import asyncpg


async def get_db(request: Request) -> asyncpg.Pool:
    """Yield the shared connection pool created at startup (see main.lifespan)."""
    return request.app.state.db
