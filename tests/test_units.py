from __future__ import annotations

import asyncio
from datetime import date
from types import SimpleNamespace

import anthropic
import httpx2

from app.config import Settings
from app.llm import FALLBACK_BETA, ChatJob, ClaudeEngine, _chunks, describe_api_error
from app.personas import build_system_prompt, get_persona
from app.rate_limit import SlidingWindowRateLimiter
from app.sse import KEEP_ALIVE, format_sse, with_heartbeat


# ------------------------------------------------------------------ sse
def test_format_sse_is_single_data_line():
    out = format_sse("delta", {"text": "line1\nline2 ✨"})
    assert out == 'event: delta\ndata: {"text":"line1\\nline2 ✨"}\n\n'


def test_heartbeat_emits_keep_alive_when_source_is_quiet():
    async def slow():
        await asyncio.sleep(0.05)
        yield "a"

    async def collect():
        return [item async for item in with_heartbeat(slow(), interval=0.01)]

    items = asyncio.run(collect())
    assert items[-1] == "a"
    assert KEEP_ALIVE in items


def test_heartbeat_propagates_errors():
    async def boom():
        yield "a"
        raise RuntimeError("bad")

    async def collect():
        out = []
        try:
            async for item in with_heartbeat(boom(), interval=1):
                out.append(item)
        except RuntimeError as exc:
            out.append(str(exc))
        return out

    assert asyncio.run(collect()) == ["a", "bad"]


# ------------------------------------------------------------ rate limit
def test_rate_limiter_sliding_window():
    now = [0.0]
    limiter = SlidingWindowRateLimiter(2, 60, clock=lambda: now[0])
    assert limiter.hit("ip")[0]
    assert limiter.hit("ip")[0]
    allowed, retry = limiter.hit("ip")
    assert not allowed and 59 <= retry <= 60
    assert limiter.hit("other-ip")[0]
    now[0] = 61
    assert limiter.hit("ip")[0]


def test_rate_limiter_disabled():
    limiter = SlidingWindowRateLimiter(0)
    assert all(limiter.hit("x")[0] for _ in range(100))


# ------------------------------------------------------------- personas
def test_system_prompt_composition():
    prompt = build_system_prompt("tutor", "Be brief.", today=date(2026, 1, 2))
    assert "You are Nova" in prompt
    assert "2026-01-02" in prompt
    assert "patient tutor" in prompt
    assert "Be brief." in prompt


def test_unknown_persona_falls_back_to_default():
    assert get_persona("nope").id == "assistant"
    assert "## Your role" not in build_system_prompt("assistant", "")


# --------------------------------------------------------------- config
def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("DEFAULT_MODEL", "not-a-model")
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "5")
    monkeypatch.setenv("TRUST_PROXY", "true")
    s = Settings.from_env()
    assert s.anthropic_api_key == "sk-test"
    assert s.default_model == "claude-opus-5-5"
    assert s.rate_limit_per_minute == 5
    assert s.trust_proxy is True
    assert not s.demo_mode


# ------------------------------------------------------------------ llm
def test_chunks_preserve_text():
    text = "Hello  world,\nthis is   a test."
    assert "".join(_chunks(text)) == text


def _status_error(cls, status):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(status, request=request)
    return cls("boom", response=response, body=None)


def test_describe_api_error_mapping():
    assert describe_api_error(_status_error(anthropic.AuthenticationError, 401))[0] == "auth_error"
    assert describe_api_error(_status_error(anthropic.RateLimitError, 429))[0] == "rate_limited"
    assert describe_api_error(_status_error(anthropic.InternalServerError, 500))[0] == "overloaded"
    assert describe_api_error(RuntimeError())[0] == "internal_error"


def _job(model="claude-opus-5-5", show_thinking=True):
    return ChatJob(
        model=model,
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
        effort="low",
        show_thinking=show_thinking,
    )


def test_claude_request_params_opus_uses_fallbacks_and_adaptive_thinking():
    engine = ClaudeEngine("sk-test", max_tokens=1234, client=object())
    params = engine._request_params(_job())
    assert params["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert params["output_config"] == {"effort": "low"}
    assert params["fallbacks"] == "default"
    assert params["betas"] == [FALLBACK_BETA]
    assert params["max_tokens"] == 1234
    assert params["cache_control"] == {"type": "ephemeral"}


def test_claude_request_params_haiku_has_no_fallbacks():
    engine = ClaudeEngine("sk-test", client=object())
    params = engine._request_params(_job("claude-haiku-5-5", show_thinking=False))
    assert "fallbacks" not in params and "betas" not in params
    assert params["thinking"]["display"] == "omitted"


class _FakeStream:
    """Mimics the SDK's async MessageStream context manager."""

    def __init__(self, events, final):
        self._events = events
        self._final = final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        async def gen():
            for e in self._events:
                yield e

        return gen()

    async def get_final_message(self):
        return self._final


def test_claude_engine_translates_stream_events():
    events = [
        SimpleNamespace(type="message_start"),
        SimpleNamespace(type="thinking", thinking="Let me think"),
        SimpleNamespace(
            type="content_block_start",
            content_block=SimpleNamespace(
                type="fallback", from_=SimpleNamespace(model="claude-opus-5-5"), to=SimpleNamespace(model="claude-opus-4-8")
            ),
        ),
        SimpleNamespace(type="text", text="Hi"),
        SimpleNamespace(type="text", text=" there"),
    ]
    final = SimpleNamespace(
        model="claude-opus-4-8",
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=10, output_tokens=3, cache_read_input_tokens=None, cache_creation_input_tokens=5),
    )
    captured = {}

    def stream(**params):
        captured.update(params)
        return _FakeStream(events, final)

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    engine = ClaudeEngine("sk-test", client=client)

    async def collect():
        return [e async for e in engine.stream(_job())]

    out = asyncio.run(collect())
    assert [e.event for e in out] == ["start", "thinking", "notice", "delta", "delta", "done"]
    assert out[2].data == {"kind": "fallback", "from": "claude-opus-5-5", "to": "claude-opus-4-8"}
    assert out[-1].data["usage"]["output_tokens"] == 3
    assert out[-1].data["usage"]["cache_read_input_tokens"] == 0
    assert captured["model"] == "claude-opus-5-5"


def test_claude_engine_reports_api_errors_as_events():
    def stream(**params):
        raise _status_error(anthropic.RateLimitError, 429)

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    engine = ClaudeEngine("sk-test", client=client)

    async def collect():
        return [e async for e in engine.stream(_job())]

    out = asyncio.run(collect())
    assert [e.event for e in out] == ["start", "error"]
    assert out[1].data["code"] == "rate_limited"
