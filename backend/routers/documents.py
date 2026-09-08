import os

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

import schemas
from config import settings
from deps import get_db
from text_extraction import extract_text

router = APIRouter(prefix="/documents", tags=["documents"])


@router.post("/upload", response_model=schemas.DocumentUploadResponse)
async def upload_document(
    file: UploadFile = File(...),
    db: asyncpg.Pool = Depends(get_db),
):
    """Accept any supported document, extract its text, and store it so a
    quiz session can be generated from it. The file itself is never kept —
    only the extracted text, which is all the AI needs."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in settings.ALLOWED_UPLOAD_EXTENSIONS:
        supported = ", ".join(sorted(settings.ALLOWED_UPLOAD_EXTENSIONS))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Supported: {supported}",
        )

    data = await file.read()
    if len(data) > settings.MAX_UPLOAD_BYTES:
        max_mb = settings.MAX_UPLOAD_BYTES // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File is too large (max {max_mb}MB).")
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    try:
        text = extract_text(file.filename, data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    word_count = len(text.split())
    preview = " ".join(text.split()[:60])
    if len(text.split()) > 60:
        preview += "…"

    row = await db.fetchrow(
        """
        INSERT INTO documents (filename, content, word_count)
        VALUES ($1, $2, $3)
        RETURNING id
        """,
        file.filename,
        text,
        word_count,
    )

    return schemas.DocumentUploadResponse(
        document_id=row["id"],
        filename=file.filename,
        word_count=word_count,
        preview=preview,
    )
