"""Minimal password hashing — PBKDF2-HMAC-SHA256 with a random salt per
password, using only the standard library (no extra dependency needed).
Good enough for this app's threat model; swap for passlib/bcrypt if this
ever needs to harden further.
"""
import hashlib
import hmac
import secrets

_ITERATIONS = 100_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if not stored or "$" not in stored:
        return False
    salt, digest_hex = stored.split("$", 1)
    try:
        salt_bytes = bytes.fromhex(salt)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, _ITERATIONS)
    return hmac.compare_digest(digest.hex(), digest_hex)
