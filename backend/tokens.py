"""Access-token issuing/verification (JWT, HS256).

Previously /auth/login just handed back a user_id and every other endpoint
trusted whatever user_id the client sent with each request — meaning anyone
could read or write another student's data by changing a number. Tokens fix
that: the server is the only thing that can produce a valid token for a
given user_id, so `get_current_user` (see authn.py) can trust it.
"""
from datetime import datetime, timedelta, timezone

import jwt

from config import settings

ALGORITHM = settings.JWT_ALGORITHM


def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> int:
    """Returns the user_id encoded in the token, or raises jwt.PyJWTError
    (expired, malformed, or signed with a different secret)."""
    payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
    return int(payload["sub"])
