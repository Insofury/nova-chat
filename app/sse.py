"""Server-Sent Events (SSE) helpers.

SSE is a simple text protocol for pushing a stream of events over one HTTP
response:

    event: delta
    data: {"text": "Hello"}

    (blank line ends the event)

`format_sse` builds one event; `with_heartbeat` interleaves keep-alive comments
so proxies and load balancers don't close the connection while the model is
thinking silently.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from typing import Any

KEEP_ALIVE = ": keep-alive\n\n"


def format_sse(event: str, data: dict[str, Any]) -> str:
    """Encode one SSE event. JSON never contains raw newlines, so one data line is enough."""
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


async def with_heartbeat(source: AsyncIterator[str], interval: float = 15.0) -> AsyncIterator[str]:
    """Yield everything from `source`, plus a keep-alive comment after each quiet `interval`.

    The source runs in a background task feeding a queue, so waiting for the next
    item can time out without cancelling the source itself. If the client
    disconnects, the task is cancelled, which closes the upstream Claude stream.
    """
    queue: asyncio.Queue[Any] = asyncio.Queue()
    end = object()

    async def pump() -> None:
        try:
            async for item in source:
                queue.put_nowait(item)
        except Exception as exc:  # noqa: BLE001 - re-raised in the consumer
            queue.put_nowait(exc)
        finally:
            queue.put_nowait(end)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
            except TimeoutError:
                yield KEEP_ALIVE
                continue
            if item is end:
                break
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
