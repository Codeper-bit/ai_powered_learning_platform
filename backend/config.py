"""Centralized configuration. All env-var reads happen here, once, so the
rest of the app just imports `settings`."""
import os

from dotenv import load_dotenv

load_dotenv()

_PLACEHOLDER_DB_HOSTS = {"host", "hostname", "your-host", "localhost-placeholder"}


def _split_csv(value: str | None, default: list[str]) -> list[str]:
    """Comma-separated list -> clean list. Trailing slashes are dropped
    because a browser's Origin header never has one, so 'https://x.app/'
    would otherwise silently never match."""
    if not value:
        return default
    items = [item.strip().rstrip("/") for item in value.split(",")]
    return [item for item in items if item] or default


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")

    # Explicit origins (never "*"). Comma-separated in the env var.
    CORS_ORIGINS: list[str] = _split_csv(
        os.getenv("CORS_ORIGINS"),
        default=["http://localhost:5173", "http://127.0.0.1:5173"],
    )

    DB_POOL_MIN_SIZE: int = int(os.getenv("DB_POOL_MIN_SIZE", "2"))
    DB_POOL_MAX_SIZE: int = int(os.getenv("DB_POOL_MAX_SIZE", "10"))

    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "50"))

    # Question-batch reuse: before calling the LLM, look for a recent batch
    # with the same subject/exam/difficulty and copy it instead.
    QUESTION_REUSE_WINDOW_DAYS: int = int(os.getenv("QUESTION_REUSE_WINDOW_DAYS", "14"))
    QUESTION_REUSE_MAX_COUNT: int = int(os.getenv("QUESTION_REUSE_MAX_COUNT", "25"))

    # Hard ceiling on a single LLM call.
    AI_TIMEOUT_SECONDS: int = int(os.getenv("AI_TIMEOUT_SECONDS", "45"))

    # Document uploads
    MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))  # 8MB
    ALLOWED_UPLOAD_EXTENSIONS: set[str] = {".txt", ".md", ".pdf", ".docx", ".csv", ".rtf"}
    MAX_SOURCE_CHARS: int = int(os.getenv("MAX_SOURCE_CHARS", "12000"))  # chars sent to the LLM
    MAX_STORED_CHARS: int = int(os.getenv("MAX_STORED_CHARS", "500000"))  # chars kept in the DB
    MAX_PDF_PAGES: int = int(os.getenv("MAX_PDF_PAGES", "300"))
    MAX_DOCX_UNZIPPED_BYTES: int = int(os.getenv("MAX_DOCX_UNZIPPED_BYTES", str(50 * 1024 * 1024)))

    # There is no login, so the endpoints that spend LLM tokens or CPU are
    # rate-limited per client instead (requests per minute).
    RATE_LIMIT_GENERATE_PER_MIN: int = int(os.getenv("RATE_LIMIT_GENERATE_PER_MIN", "8"))
    RATE_LIMIT_UPLOAD_PER_MIN: int = int(os.getenv("RATE_LIMIT_UPLOAD_PER_MIN", "10"))


settings = Settings()


def _looks_like_placeholder_db_url(url: str) -> str | None:
    """Human-readable reason if DATABASE_URL is empty or still the template."""
    if not url:
        return "DATABASE_URL is empty."
    try:
        after_at = url.split("@", 1)[-1]
        host = after_at.split(":", 1)[0].split("/", 1)[0]
    except Exception:
        return None
    if host.lower() in _PLACEHOLDER_DB_HOSTS:
        return (
            f"DATABASE_URL still has the placeholder host '{host}'. Replace it "
            f"with your real Postgres connection string."
        )
    return None
