"""Centralized configuration. All env-var reads happen here, once, so the
rest of the app just imports `settings`."""
import os
from dotenv import load_dotenv

load_dotenv()


def _split_csv(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return default
    return [origin.strip() for origin in value.split(",") if origin.strip()]


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")

    # Explicit origins instead of "*" so allow_credentials can be safe.
    CORS_ORIGINS: list[str] = _split_csv(
        os.getenv("CORS_ORIGINS"),
        default=["http://localhost:5173", "http://127.0.0.1:5173"],
    )

    DB_POOL_MIN_SIZE: int = int(os.getenv("DB_POOL_MIN_SIZE", "2"))
    DB_POOL_MAX_SIZE: int = int(os.getenv("DB_POOL_MAX_SIZE", "10"))

    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "50"))

    # Document upload limits
    MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))  # 8MB
    ALLOWED_UPLOAD_EXTENSIONS: set[str] = {
        ".txt", ".md", ".pdf", ".docx", ".csv", ".rtf",
    }
    # Characters of extracted document text fed into the prompt. Keeps the
    # request within the model's context window regardless of source size.
    MAX_SOURCE_CHARS: int = int(os.getenv("MAX_SOURCE_CHARS", "12000"))


settings = Settings()
