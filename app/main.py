"""FastAPI application: HTTP routes, middleware and static website hosting.

Routes
------
GET  /              the chat website (static/index.html)
GET  /api/health    liveness probe for hosting platforms
GET  /api/config    models, personas, limits and mode for the UI
POST /api/chat      streams the assistant's reply as Server-Sent Events
GET  /api/docs      interactive API docs (Swagger UI)

Run locally with:  uvicorn app.main:app --reload
"""

from __future__ import annotations

import logging
import math

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .chat import ChatValidationError, build_job
from .config import EFFORT_LEVELS, MODELS, STATIC_DIR, Settings
from .llm import ChatEngine, create_engine
from .personas import DEFAULT_PERSONA_ID, PERSONAS
from .rate_limit import SlidingWindowRateLimiter
from .schemas import ChatRequest
from .security import BodySizeLimitMiddleware, SecurityHeadersMiddleware, access_code_ok, client_ip
from .sse import format_sse, with_heartbeat

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("novachat")

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",  # stop nginx-style proxies from buffering the stream
    "Connection": "keep-alive",
}


def create_app(settings: Settings | None = None, engine: ChatEngine | None = None) -> FastAPI:
    """Application factory - tests pass their own settings and a fake engine."""
    settings = settings or Settings.from_env()
    engine = engine or create_engine(settings)
    limiter = SlidingWindowRateLimiter(settings.rate_limit_per_minute, 60.0)

    app = FastAPI(
        title=f"{settings.app_name} API",
        version=__version__,
        description="Real-time streaming chatbot API powered by Claude.",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.engine = engine
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(SecurityHeadersMiddleware)

    logger.info(
        "%s v%s starting in %s mode", settings.app_name, __version__, "DEMO" if settings.demo_mode else "CLAUDE"
    )

    # ------------------------------------------------------------------ API
    @app.get("/api/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": __version__, "mode": engine.name}

    @app.get("/api/config", tags=["meta"])
    async def config() -> dict:
        return {
            "app_name": settings.app_name,
            "version": __version__,
            "mode": engine.name,
            "models": [{"id": m.id, "label": m.label, "tagline": m.tagline} for m in MODELS],
            "default_model": settings.default_model,
            "efforts": [{"id": k, "label": v} for k, v in EFFORT_LEVELS.items()],
            "default_effort": settings.default_effort,
            "personas": [
                {"id": p.id, "name": p.name, "emoji": p.emoji, "description": p.description} for p in PERSONAS
            ],
            "default_persona": DEFAULT_PERSONA_ID,
            "access_code_required": bool(settings.access_code),
            "limits": {
                "max_images_per_message": settings.max_images_per_message,
                "max_image_bytes": settings.max_image_bytes,
                "max_message_chars": settings.max_message_chars,
                "max_custom_instructions_chars": settings.max_custom_instructions_chars,
            },
        }

    @app.post("/api/chat", tags=["chat"])
    async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
        if not access_code_ok(request.headers.get("x-access-code"), settings.access_code):
            raise HTTPException(status_code=401, detail="A valid access code is required to chat.")

        allowed, retry_after = limiter.hit(client_ip(request, settings.trust_proxy))
        if not allowed:
            wait = max(1, math.ceil(retry_after))
            raise HTTPException(
                status_code=429,
                detail=f"You're sending messages too quickly. Please wait {wait}s and try again.",
                headers={"Retry-After": str(wait)},
            )

        try:
            job = build_job(payload, settings)
        except ChatValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        async def event_source():
            async for event in engine.stream(job):
                yield format_sse(event.event, event.data)

        return StreamingResponse(with_heartbeat(event_source()), media_type="text/event-stream", headers=SSE_HEADERS)

    # ------------------------------------------------------------ website
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> FileResponse:
        return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")

    return app


app = create_app()
