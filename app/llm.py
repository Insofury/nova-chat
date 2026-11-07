"""Chat engines - the part of the app that actually produces the assistant's reply.

Two engines implement the same tiny interface (`stream(job) -> async iterator of
StreamEvent`):

* `ClaudeEngine` streams real answers from the Claude API with the official
  `anthropic` SDK (async client, token-by-token streaming, adaptive thinking,
  prompt caching and server-side refusal fallbacks).
* `DemoEngine` streams a built-in reply so the site still works (and shows off
  the UI) when no API key is configured.

The web layer (`app.main`) only sees `StreamEvent`s, so it never needs to know
which engine is running.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import anthropic

from .config import MODELS_BY_ID, Settings

logger = logging.getLogger("novachat.llm")

# Beta header for the `fallbacks: "default"` form: if a safety classifier declines
# a request, the API re-runs it on a recommended fallback model in the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass
class StreamEvent:
    """One event sent to the browser over Server-Sent Events.

    event: "start" | "thinking" | "delta" | "notice" | "done" | "error"
    """

    event: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChatJob:
    """A validated, ready-to-send chat request (built by `app.chat.build_job`)."""

    model: str
    system: str
    messages: list[dict[str, Any]]
    effort: str
    show_thinking: bool


class ChatEngine(Protocol):
    name: str

    def stream(self, job: ChatJob) -> AsyncIterator[StreamEvent]: ...


# --------------------------------------------------------------------------- #
# Error mapping
# --------------------------------------------------------------------------- #
def describe_api_error(exc: Exception) -> tuple[str, str]:
    """Map an SDK exception to a (code, user-friendly message) pair.

    Ordered most-specific first so retryable problems (rate limits, overloads,
    network) stay distinguishable from permanent ones (bad key, bad request).
    """
    if isinstance(exc, anthropic.AuthenticationError):
        return "auth_error", "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY."
    if isinstance(exc, anthropic.PermissionDeniedError):
        return "permission_denied", "The server's API key is not allowed to use this model."
    if isinstance(exc, anthropic.NotFoundError):
        return "not_found", "That model is not available for this API key. Try another model."
    if isinstance(exc, anthropic.RateLimitError):
        return "rate_limited", "Claude is getting a lot of requests right now. Please wait a moment and retry."
    if isinstance(exc, anthropic.BadRequestError):
        return "bad_request", f"The request was rejected: {exc.message}"
    if isinstance(exc, anthropic.APIStatusError):
        if exc.status_code == 529 or exc.status_code >= 500:
            return "overloaded", "Claude is temporarily overloaded or unavailable. Please retry in a few seconds."
        return "api_error", f"Claude API error ({exc.status_code}): {exc.message}"
    if isinstance(exc, anthropic.APITimeoutError):
        return "timeout", "The request to Claude timed out. Please retry."
    if isinstance(exc, anthropic.APIConnectionError):
        return "connection_error", "Could not reach the Claude API. Check the server's network connection."
    return "internal_error", "Something went wrong while generating the reply."


def _model_name(ref: Any) -> str | None:
    return getattr(ref, "model", None) if ref is not None else None


# --------------------------------------------------------------------------- #
# Claude engine
# --------------------------------------------------------------------------- #
class ClaudeEngine:
    """Streams replies from the Claude Messages API."""

    name = "claude"

    def __init__(self, api_key: str, max_tokens: int = 64_000, client: Any | None = None):
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, max_retries=2)
        self._max_tokens = max_tokens

    def _request_params(self, job: ChatJob) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": job.model,
            "max_tokens": self._max_tokens,
            "system": job.system,
            "messages": job.messages,
            # Thinking is always on for current models; effort decides how much.
            # "summarized" returns a readable summary we show in the UI.
            "thinking": {"type": "adaptive", "display": "summarized" if job.show_thinking else "omitted"},
            "output_config": {"effort": job.effort},
            # Automatic prompt caching: repeated conversation prefixes are billed
            # at cache-read rates on later turns.
            "cache_control": {"type": "ephemeral"},
        }
        info = MODELS_BY_ID.get(job.model)
        if info and info.server_fallback:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = "default"
        return params

    async def stream(self, job: ChatJob) -> AsyncIterator[StreamEvent]:
        started = time.perf_counter()
        yield StreamEvent("start", {"model": job.model})
        try:
            async with self._client.beta.messages.stream(**self._request_params(job)) as stream:
                async for event in stream:
                    etype = event.type
                    if etype == "text":
                        if event.text:
                            yield StreamEvent("delta", {"text": event.text})
                    elif etype == "thinking":
                        if event.thinking:
                            yield StreamEvent("thinking", {"text": event.thinking})
                    elif etype == "content_block_start":
                        block = event.content_block
                        if getattr(block, "type", None) == "fallback":
                            yield StreamEvent(
                                "notice",
                                {
                                    "kind": "fallback",
                                    "from": _model_name(getattr(block, "from_", None)),
                                    "to": _model_name(getattr(block, "to", None)),
                                },
                            )
                final = await stream.get_final_message()
        except anthropic.APIError as exc:
            code, message = describe_api_error(exc)
            logger.warning("Claude API error (%s): %s", code, exc)
            yield StreamEvent("error", {"code": code, "message": message})
            return
        except Exception:  # noqa: BLE001 - never leak a stack trace into the stream
            logger.exception("Unexpected error while streaming from Claude")
            code, message = describe_api_error(RuntimeError())
            yield StreamEvent("error", {"code": code, "message": message})
            return

        usage = final.usage
        yield StreamEvent(
            "done",
            {
                "model": final.model,
                "stop_reason": final.stop_reason,
                "usage": {
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None) or 0,
                    "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None) or 0,
                },
                "duration_ms": int((time.perf_counter() - started) * 1000),
            },
        )


# --------------------------------------------------------------------------- #
# Demo engine (no API key needed)
# --------------------------------------------------------------------------- #
_TOKEN_RE = re.compile(r"\S+\s*|\s+")


def _chunks(text: str, words_per_chunk: int = 2) -> list[str]:
    """Split text into small word groups so it 'types out' like a real stream."""
    tokens = _TOKEN_RE.findall(text)
    return ["".join(tokens[i : i + words_per_chunk]) for i in range(0, len(tokens), words_per_chunk)]


def _last_user_text(messages: list[dict[str, Any]]) -> tuple[str, int]:
    for message in reversed(messages):
        if message["role"] != "user":
            continue
        content = message["content"]
        if isinstance(content, str):
            return content, 0
        texts = [b["text"] for b in content if b.get("type") == "text"]
        images = sum(1 for b in content if b.get("type") == "image")
        return "\n".join(texts), images
    return "", 0


DEMO_CODE_SAMPLE = '''```python
import asyncio
import anthropic

client = anthropic.AsyncAnthropic()

async def main() -> None:
    async with client.messages.stream(
        model="claude-opus-5-5",
        max_tokens=64000,
        messages=[{"role": "user", "content": "Hello, Nova!"}],
    ) as stream:
        async for text in stream.text_stream:
            print(text, end="", flush=True)

asyncio.run(main())
```'''


def build_demo_reply(user_text: str, image_count: int = 0) -> str:
    quoted = "\n".join(f"> {line}" for line in (user_text.strip()[:400] or "(no text)").splitlines())
    images_line = (
        f"\n\nYou also attached **{image_count} image{'s' if image_count != 1 else ''}** - "
        "with a real API key I would analyse them for you."
        if image_count
        else ""
    )
    return f"""### 👋 Hi! I'm Nova, running in **demo mode**

You wrote:

{quoted}{images_line}

This deployment does not have an Anthropic API key configured yet, so I am streaming a \
built-in reply to show the interface. Everything you see - live token streaming, Markdown, \
code highlighting and the thinking panel - works exactly the same with the real model.

**Switch on real AI answers in three steps:**

1. Create an API key at [console.anthropic.com](https://console.anthropic.com).
2. Set the `ANTHROPIC_API_KEY` environment variable (in `.env` locally, or in your hosting dashboard).
3. Restart the server - the *Demo* badge disappears.

Here is the core of how NovaChat streams from Claude:

{DEMO_CODE_SAMPLE}

| Feature | Status |
| --- | --- |
| Live streaming | ✅ Working |
| Markdown + code highlighting | ✅ Working |
| Conversation history | ✅ Saved in your browser |
| Real Claude answers | ⏳ Needs `ANTHROPIC_API_KEY` |
"""


class DemoEngine:
    """Streams a canned reply - used automatically when no API key is set."""

    name = "demo"

    def __init__(self, delay: float = 0.018):
        self._delay = delay

    async def stream(self, job: ChatJob) -> AsyncIterator[StreamEvent]:
        started = time.perf_counter()
        yield StreamEvent("start", {"model": "demo"})
        user_text, image_count = _last_user_text(job.messages)

        if job.show_thinking:
            thinking = (
                "The server has no API key, so I'm in demo mode. I'll acknowledge the "
                "message, explain how to enable real answers, and show off the formatting."
            )
            for piece in _chunks(thinking, 3):
                yield StreamEvent("thinking", {"text": piece})
                await asyncio.sleep(self._delay)

        reply = build_demo_reply(user_text, image_count)
        for piece in _chunks(reply):
            yield StreamEvent("delta", {"text": piece})
            await asyncio.sleep(self._delay)

        yield StreamEvent(
            "done",
            {
                "model": "demo",
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": len(user_text.split()),
                    "output_tokens": len(reply.split()),
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
                "duration_ms": int((time.perf_counter() - started) * 1000),
            },
        )


def create_engine(settings: Settings) -> ChatEngine:
    """Pick the Claude engine when an API key is configured, otherwise demo mode."""
    if settings.anthropic_api_key:
        return ClaudeEngine(settings.anthropic_api_key, settings.max_tokens)
    return DemoEngine()
