import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import settings
from database import create_pool
from routers import attempts, documents, progress, sessions, todos

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = await create_pool()
    logger.info("Database pool ready. Allowed origins: %s", settings.CORS_ORIGINS)
    yield
    await app.state.db.close()


app = FastAPI(title="AI Learning Platform", lifespan=lifespan)

# No cookies or credentials are used (identity is a plain header), so
# credentialed CORS stays off and only the headers the app needs are allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Device-Id"],
)

app.include_router(sessions.router)
app.include_router(attempts.router)
app.include_router(documents.router)
app.include_router(progress.router)
app.include_router(todos.router)


def _cors_headers_for(request: Request) -> dict:
    """CORS headers for a response built OUTSIDE CORSMiddleware.

    The catch-all 500 handler runs above CORSMiddleware, so without this the
    browser reports a misleading "CORS error" instead of the real 500."""
    origin = (request.headers.get("origin") or "").rstrip("/")
    if origin and origin in settings.CORS_ORIGINS:
        return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
    return {}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong. Please try again."},
        headers=_cors_headers_for(request),
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 405:
        logger.warning(
            "405 Method Not Allowed: %s %s. Check that the frontend's "
            "VITE_API_BASE points at this backend.",
            request.method, request.url.path,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.get("/")
async def root():
    return {"message": "AI Learning Platform API is running"}


@app.get("/health")
async def health():
    return {"ok": True}
