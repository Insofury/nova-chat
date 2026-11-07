from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm import ChatJob, DemoEngine, StreamEvent
from app.main import create_app


class RecordingEngine:
    """Fake engine: records the job it receives and streams fixed events."""

    name = "fake"

    def __init__(self) -> None:
        self.jobs: list[ChatJob] = []

    async def stream(self, job: ChatJob) -> AsyncIterator[StreamEvent]:
        self.jobs.append(job)
        yield StreamEvent("start", {"model": job.model})
        yield StreamEvent("thinking", {"text": "hmm"})
        yield StreamEvent("delta", {"text": "Hello "})
        yield StreamEvent("delta", {"text": "world"})
        yield StreamEvent("done", {"model": job.model, "stop_reason": "end_turn", "usage": {"output_tokens": 2}})


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for chunk in body.split("\n\n"):
        event, data = None, None
        for line in chunk.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        if event and data is not None:
            events.append((event, data))
    return events


@pytest.fixture
def engine() -> RecordingEngine:
    return RecordingEngine()


@pytest.fixture
def make_client(engine):
    def _make(**overrides) -> TestClient:
        return TestClient(create_app(settings=Settings(**overrides), engine=engine))

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def demo_client() -> TestClient:
    return TestClient(create_app(settings=Settings(), engine=DemoEngine(delay=0)))
