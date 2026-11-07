"""A small in-memory sliding-window rate limiter.

Protects the server's API key (and your bill) on a public deployment by capping
how many chat requests each client IP can make per minute. State lives in the
process, which is right for a single-instance app; use Redis or similar if you
scale out to several instances.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable


class SlidingWindowRateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._last_sweep = clock()

    @property
    def enabled(self) -> bool:
        return self.limit > 0

    def hit(self, key: str) -> tuple[bool, float]:
        """Record a request for `key`.

        Returns `(allowed, retry_after_seconds)`. A limit of 0 or less disables
        limiting entirely.
        """
        if not self.enabled:
            return True, 0.0

        now = self._clock()
        hits = self._hits.setdefault(key, deque())
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()

        if len(hits) >= self.limit:
            return False, max(0.0, hits[0] + self.window - now)

        hits.append(now)
        self._maybe_sweep(now)
        return True, 0.0

    def _maybe_sweep(self, now: float) -> None:
        """Forget idle clients now and then so memory stays bounded."""
        if now - self._last_sweep < self.window:
            return
        self._last_sweep = now
        cutoff = now - self.window
        for key in [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]:
            del self._hits[key]
