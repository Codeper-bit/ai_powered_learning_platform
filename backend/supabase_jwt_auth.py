"""FastAPI dependency that turns a Supabase Auth access token
(`Authorization: Bearer <token>`) into a trusted current-user UUID.

This replaces authn.get_current_user as the auth dependency for every
endpoint that touches a specific user's data. The old file (authn.py,
plus auth.py and tokens.py) is kept on disk untouched during the
migration and removed only in a later cleanup step — see MIGRATION.md.

Verification: Supabase projects now sign access tokens asymmetrically
(ES256, an ECC P-256 key) by default, so the correct way to verify them
is against the project's public JWKS endpoint
(<SUPABASE_URL>/auth/v1/.well-known/jwks.json) — no secret required,
and PyJWKClient below caches/refreshes that automatically. Projects
that haven't rotated their signing key still issue (or have live,
unexpired) tokens signed the old way, with the project's HS256 shared
secret (SUPABASE_JWT_SECRET) — decode_supabase_token() tries JWKS/ES256
first and falls back to the HS256 secret so both verify correctly
during and after the transition.
"""
from uuid import UUID

import asyncpg
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import settings
from deps import get_db

_bearer = HTTPBearer(auto_error=False)

# Lazily built on first use (not at import time) so a bad/missing
# SUPABASE_URL doesn't crash app startup — it just makes every request
# fail with a clear 401/500 instead, same as a bad JWT secret would.
_jwks_client: "jwt.PyJWKClient | None" = None


def _get_jwks_client() -> "jwt.PyJWKClient":
    global _jwks_client
    if _jwks_client is None:
        jwks_url = settings.SUPABASE_URL.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        _jwks_client = jwt.PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_client


def decode_supabase_token(token: str) -> UUID:
    """Returns the Supabase user id (the `sub` claim) as a UUID, or raises
    jwt.PyJWTError (expired, malformed, wrong audience, or signed with a
    key/secret we can't verify against)."""
    # New-style tokens: asymmetric (ES256), verified against the project's
    # public JWKS. This is the primary path — try it first.
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token).key
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["ES256"],
            audience=settings.SUPABASE_JWT_AUD,
        )
        return UUID(payload["sub"])
    except jwt.ExpiredSignatureError:
        raise
    except jwt.PyJWTError:
        pass  # not a JWKS-verifiable/ES256 token — fall through to legacy path

    # Legacy fallback: old-style tokens signed with the project's HS256
    # shared secret, still valid until they naturally expire post-rotation.
    if not settings.SUPABASE_JWT_SECRET:
        raise jwt.InvalidTokenError("no legacy secret configured to fall back to")
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

    if not settings.SUPABASE_URL:
        # Misconfiguration, not a client error — fail loudly rather than
        # silently rejecting every request with a confusing 401.
        raise HTTPException(
            status_code=500,
            detail="Server is not configured to verify Supabase sessions "
                   "(SUPABASE_URL is not set).",
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

