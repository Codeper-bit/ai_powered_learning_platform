"""Centralized configuration. All env-var reads happen here, once, so the
rest of the app just imports `settings`."""
import os
import secrets
from dotenv import load_dotenv

load_dotenv()

# Placeholder hosts from the .env.example template — if any of these are
# still in DATABASE_URL, the app hasn't been configured yet. Failing fast
# here with a clear message replaces a raw `socket.gaierror: getaddrinfo
# failed` traceback (which looks like a code bug) with an actionable one.
_PLACEHOLDER_DB_HOSTS = {"host", "hostname", "your-host", "localhost-placeholder"}


def _split_csv(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return default
    return [origin.strip() for origin in value.split(",") if origin.strip()]


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")

    # Signs access tokens issued at /auth/login and /auth/register. Falls
    # back to a random per-process secret so local dev never crashes for
    # lack of one — but that means tokens won't survive a restart, so
    # production MUST set a real JWT_SECRET_KEY in the environment.
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY") or secrets.token_hex(32)
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = int(os.getenv("JWT_EXPIRE_MINUTES", str(60 * 24 * 7)))  # 7 days

    # Explicit origins instead of "*" so allow_credentials can be safe.
    CORS_ORIGINS: list[str] = _split_csv(
        os.getenv("CORS_ORIGINS"),
        default=["http://localhost:5173", "http://127.0.0.1:5173"],
    )

    DB_POOL_MIN_SIZE: int = int(os.getenv("DB_POOL_MIN_SIZE", "2"))
    DB_POOL_MAX_SIZE: int = int(os.getenv("DB_POOL_MAX_SIZE", "10"))

    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "50"))

    # Question-batch reuse (the app's caching layer): before generating a
    # fresh batch with the LLM, check for a recent batch matching the same
    # subject/exam/difficulty and copy it instead. This is what keeps LLM
    # token spend roughly flat as concurrent traffic grows on popular
    # subjects, instead of scaling 1:1 with request volume.
    QUESTION_REUSE_WINDOW_DAYS: int = int(os.getenv("QUESTION_REUSE_WINDOW_DAYS", "14"))
    QUESTION_REUSE_MAX_COUNT: int = int(os.getenv("QUESTION_REUSE_MAX_COUNT", "25"))

    # Hard ceiling on a single LLM call so a slow/stuck provider response
    # can't tie up a request (and its DB connection) indefinitely under load.
    AI_TIMEOUT_SECONDS: int = int(os.getenv("AI_TIMEOUT_SECONDS", "45"))

    # Document upload limits
    MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))  # 8MB
    ALLOWED_UPLOAD_EXTENSIONS: set[str] = {
        ".txt", ".md", ".pdf", ".docx", ".csv", ".rtf",
    }
    # Characters of extracted document text fed into the prompt. Keeps the
    # request within the model's context window regardless of source size.
    MAX_SOURCE_CHARS: int = int(os.getenv("MAX_SOURCE_CHARS", "12000"))


settings = Settings()

if not settings.JWT_SECRET_KEY or os.getenv("JWT_SECRET_KEY") is None:
    import logging
    logging.getLogger("config").warning(
        "JWT_SECRET_KEY is not set — using a random secret for this process "
        "only. Every login token will become invalid on restart, and if you "
        "ever run more than one server process, tokens issued by one won't "
        "verify on another. Set JWT_SECRET_KEY in the environment for any "
        "real deployment."
    )


def _looks_like_placeholder_db_url(url: str) -> str | None:
    """Returns a human-readable reason if DATABASE_URL is clearly still the
    .env.example template, else None."""
    if not url:
        return "DATABASE_URL is empty."
    try:
        # Cheap parse: postgresql://user:pass@host:port/db
        after_at = url.split("@", 1)[-1]
        host = after_at.split(":", 1)[0].split("/", 1)[0]
    except Exception:
        return None
    if host.lower() in _PLACEHOLDER_DB_HOSTS:
        return (
            f"DATABASE_URL still has the placeholder host '{host}' from the "
            f".env template. Replace it with your real Postgres connection "
            f"string (e.g. from Render/Supabase/local Postgres)."
        )
    return None
