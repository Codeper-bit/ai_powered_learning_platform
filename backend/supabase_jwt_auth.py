"""FastAPI dependency that turns a Supabase Auth access token
(`Authorization: Bearer <token>`) into a trusted current-user UUID.

This replaces authn.get_current_user as the auth dependency for every
endpoint that touches a specific user's data. The old file (authn.py,
plus auth.py and tokens.py) is kept on disk untouched during the
migration and removed only in a later cleanup step — see MIGRATION.md.

Verification is local (no network call to Supabase): Supabase signs
access tokens with the project's JWT secret (HS256), so we can verify
the signature and read claims directly, the same way the old
tokens.decode_access_token did for the custom JWTs it minted. The only
difference that matters to callers is the type of the identity claim:
it's now a UUID string (Supabase's `auth.users.id`) instead of an
integer.
"""
from uuid import UUID

import asyncpg
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import settings
from deps import get_db

_bearer = HTTPBearer(auto_error=False)


def decode_supabase_token(token: str) -> UUID:
    """Returns the Supabase user id (the `sub` claim) as a UUID, or raises
    jwt.PyJWTError (expired, malformed, wrong audience, or signed with a
    different secret than SUPABASE_JWT_SECRET)."""
    payload = jwt.decode(
        token,
        settings.SUPABASE_JWT_SECRET,
        algorithms=["HS256"],
        audience=settings.SUPABASE_JWT_AUD,
    )
    return UUID(payload["sub"])


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: asyncpg.Pool = Depends(get_db),
) -> UUID:
    if creds is None:
        raise HTTPException(status_code=401, detail="Log in to continue.")

    if not settings.SUPABASE_JWT_SECRET:
        # Misconfiguration, not a client error — fail loudly rather than
        # silently rejecting every request with a confusing 401.
        raise HTTPException(
            status_code=500,
            detail="Server is not configured to verify Supabase sessions "
                   "(SUPABASE_JWT_SECRET is not set).",
        )

    try:
        user_id = decode_supabase_token(creds.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Your session expired. Please log in again.")
    except (jwt.PyJWTError, ValueError, KeyError):
        # ValueError/KeyError: malformed `sub` claim (not a UUID) or a
        # token missing it entirely — treat the same as an invalid token.
        raise HTTPException(status_code=401, detail="Invalid session. Please log in again.")

    # Mirrors the old authn.get_current_user's existence check: a token can
    # still be validly signed and unexpired after the account behind it is
    # gone, so confirm the profile row still exists rather than trusting
    # the token alone. (See schema.sql — profiles rows are created by a
    # trigger on auth.users insert.)
    exists = await db.fetchval("SELECT 1 FROM profiles WHERE id = $1", user_id)
    if not exists:
        raise HTTPException(status_code=401, detail="Account no longer exists. Please log in again.")
    return user_id
