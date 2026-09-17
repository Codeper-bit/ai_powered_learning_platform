"""FastAPI dependency that turns an `Authorization: Bearer <token>` header
into a trusted current-user id. Every endpoint that touches a specific
user's data should depend on `get_current_user` instead of accepting
`user_id` from the request body/query — a client-supplied user_id can't be
trusted (see tokens.py for why)."""
import asyncpg
import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from deps import get_db
from tokens import decode_access_token

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: asyncpg.Pool = Depends(get_db),
) -> int:
    if creds is None:
        raise HTTPException(status_code=401, detail="Log in to continue.")
    try:
        user_id = decode_access_token(creds.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Your session expired. Please log in again.")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid session. Please log in again.")

    exists = await db.fetchval("SELECT 1 FROM users WHERE id = $1", user_id)
    if not exists:
        raise HTTPException(status_code=401, detail="Account no longer exists. Please log in again.")
    return user_id
