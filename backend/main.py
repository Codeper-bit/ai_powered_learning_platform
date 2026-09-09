import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import settings
from database import create_pool
from routers import sessions, attempts, documents

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = await create_pool()
    logger.info("Database pool ready")
    # Loud, explicit startup log so a misconfigured deploy is obvious from
    # the Render log tail instead of showing up as a mystery "Failed to
    # fetch" in the browser.
    if settings.CORS_ORIGINS == ["http://localhost:5173", "http://127.0.0.1:5173"]:
        logger.warning(
            "CORS_ORIGINS is still the localhost default. If your frontend "
            "is deployed, set CORS_ORIGINS on this service to its exact "
            "URL (e.g. https://your-frontend.onrender.com) or every "
            "request from it will be blocked by the browser."
        )
    else:
        logger.info("CORS_ORIGINS = %s", settings.CORS_ORIGINS)
    yield
    await app.state.db.close()


app = FastAPI(title="AI Learning Platform", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(attempts.router)
app.include_router(documents.router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong. Please try again."})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 405:
        # The #1 cause of a 405 here is the frontend's VITE_API_BASE
        # pointing at the wrong host (e.g. the static frontend site itself,
        # which only serves GET) instead of this backend service.
        logger.warning(
            "405 Method Not Allowed: %s %s from origin=%s — check that "
            "VITE_API_BASE on the frontend points at THIS backend's URL.",
            request.method,
            request.url.path,
            request.headers.get("origin"),
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/")
async def root():
    return {"message": "AI Learning Platform API is running"}
