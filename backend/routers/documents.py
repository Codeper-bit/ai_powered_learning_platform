import os
import re
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

import schemas
from config import settings
from deps import get_db, get_learner, limit_upload
from text_extraction import extract_text

router = APIRouter(prefix="/documents", tags=["documents"])

_READ_CHUNK = 64 * 1024


def _safe_filename(name: str | None) -> str:
    """Display-safe filename: no path parts, no control characters, bounded
    length (it later becomes a quiz subject label inside an LLM prompt)."""
    base = os.path.basename((name or "").replace("\\", "/"))
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip()
    return (base or "document")[:120]


async def _read_limited(file: UploadFile, limit: int) -> bytes:
    """Read the upload in chunks and stop as soon as it exceeds `limit`, so an
    oversized file is rejected without ever being held fully in memory."""
    chunks, size = [], 0
    while True:
        chunk = await file.read(_READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            max_mb = limit // (1024 * 1024)
            raise HTTPException(status_code=413, detail=f"File is too large (max {max_mb}MB).")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/upload",
    response_model=schemas.DocumentUploadResponse,
    dependencies=[Depends(limit_upload)],
)
async def upload_document(
    file: UploadFile = File(...),
    db: asyncpg.Pool = Depends(get_db),
    user_id: UUID = Depends(get_learner),
):
    """Accept a supported document, extract its text, and store it so a quiz
    can be generated from it. The file itself is never kept, only the
    extracted text. The document is stamped with the uploader's learner id,
    so it can only be quizzed on by that same learner (see the ownership
    check in routers/sessions.py)."""
    filename = _safe_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in settings.ALLOWED_UPLOAD_EXTENSIONS:
        supported = ", ".join(sorted(settings.ALLOWED_UPLOAD_EXTENSIONS))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Supported: {supported}",
        )

    data = await _read_limited(file, settings.MAX_UPLOAD_BYTES)
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    try:
        text = extract_text(filename, data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    words = text.split()
    word_count = len(words)
    preview = " ".join(words[:60]) + ("…" if word_count > 60 else "")

    row = await db.fetchrow(
        """
        INSERT INTO documents (user_id, filename, content, word_count)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        """,
        user_id,
        filename,
        text,
        word_count,
    )

    return schemas.DocumentUploadResponse(
        document_id=row["id"],
        filename=filename,
        word_count=word_count,
        preview=preview,
    )
