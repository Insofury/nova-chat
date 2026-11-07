"""Security helpers: client IP detection, optional access code, and ASGI middleware
that adds security headers and rejects oversized request bodies."""

from __future__ import annotations

import hmac
import json

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Content Security Policy: scripts only from this site and the two CDNs the UI uses,
# no inline scripts, and the page may only talk to its own API. Combined with
# DOMPurify on the client this neutralises HTML injected into model output.
CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

BASE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

# Swagger UI (/api/docs) relies on inline scripts, so it gets no CSP.
_NO_CSP_PREFIXES = ("/api/docs", "/api/openapi.json")


def client_ip(request: Request, trust_proxy: bool) -> str:
    """Best-effort client IP. Only trust X-Forwarded-For behind a known proxy."""
    if trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def access_code_ok(provided: str | None, expected: str | None) -> bool:
    """Constant-time comparison; always true when no access code is configured."""
    if not expected:
        return True
    return hmac.compare_digest((provided or "").encode(), expected.encode())


class SecurityHeadersMiddleware:
    """Pure ASGI middleware (safe for streaming responses) that adds security headers."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        add_csp = not scope.get("path", "").startswith(_NO_CSP_PREFIXES)

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in BASE_HEADERS.items():
                    headers.setdefault(name, value)
                if add_csp:
                    headers.setdefault("Content-Security-Policy", CSP)
            await send(message)

        await self.app(scope, receive, send_with_headers)


class BodySizeLimitMiddleware:
    """Reject requests whose declared Content-Length exceeds `max_bytes` with HTTP 413."""

    def __init__(self, app: ASGIApp, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            for name, value in scope.get("headers", []):
                if name == b"content-length":
                    try:
                        too_big = int(value) > self.max_bytes
                    except ValueError:
                        too_big = False
                    if too_big:
                        body = json.dumps({"detail": "Request is too large."}).encode()
                        await send(
                            {
                                "type": "http.response.start",
                                "status": 413,
                                "headers": [
                                    (b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode()),
                                ],
                            }
                        )
                        await send({"type": "http.response.body", "body": body})
                        return
                    break
        await self.app(scope, receive, send)
