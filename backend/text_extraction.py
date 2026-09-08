"""Turn an uploaded file's raw bytes into plain text, and shrink long text
down to a bounded, representative sample for the AI prompt.

Supported formats are dispatched by extension. Each extractor takes raw
bytes and returns plain text; unsupported/corrupt files raise ValueError
with a message safe to show the user.
"""
from __future__ import annotations

import io
from typing import Callable

from config import settings


def _extract_txt(data: bytes) -> str:
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Could not decode this file as text.")


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise ValueError("PDF support is not installed on the server.") from exc

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise ValueError("This PDF could not be read (it may be corrupted or scanned images only).") from exc

    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            continue
    text = "\n".join(pages).strip()
    if not text:
        raise ValueError(
            "No selectable text found in this PDF. Scanned/image-only PDFs aren't supported yet."
        )
    return text


def _extract_docx(data: bytes) -> str:
    try:
        import docx
    except ImportError as exc:  # pragma: no cover
        raise ValueError("DOCX support is not installed on the server.") from exc

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ValueError("This Word document could not be read.") from exc

    parts = [p.text for p in document.paragraphs if p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    text = "\n".join(parts).strip()
    if not text:
        raise ValueError("This Word document appears to be empty.")
    return text


EXTRACTORS: dict[str, Callable[[bytes], str]] = {
    ".txt": _extract_txt,
    ".md": _extract_txt,
    ".csv": _extract_txt,
    ".rtf": _extract_txt,  # best-effort: readable but keeps RTF control words
    ".pdf": _extract_pdf,
    ".docx": _extract_docx,
}


def extract_text(filename: str, data: bytes) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in EXTRACTORS:
        supported = ", ".join(sorted(settings.ALLOWED_UPLOAD_EXTENSIONS))
        raise ValueError(f"Unsupported file type '{ext or filename}'. Supported: {supported}")
    return EXTRACTORS[ext](data)


def sample_for_prompt(text: str, max_chars: int = settings.MAX_SOURCE_CHARS) -> str:
    """Bound the text sent to the AI without just truncating the tail.

    For long documents, an even set of evenly-spaced windows across the
    whole document gives the model coverage of the beginning, middle, and
    end (better question diversity) instead of only ever seeing the intro.
    Short documents pass through untouched.
    """
    text = text.strip()
    if len(text) <= max_chars:
        return text

    num_windows = 4
    window_size = max_chars // num_windows
    step = len(text) // num_windows

    windows = []
    for i in range(num_windows):
        start = i * step
        windows.append(text[start:start + window_size])

    return "\n\n[...]\n\n".join(windows)
