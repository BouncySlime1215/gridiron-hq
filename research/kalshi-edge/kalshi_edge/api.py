"""Polite async client for Kalshi's public (unauthenticated) market-data API.

The public endpoints are rate limited per IP at roughly 4-5 requests/second
(measured 2026-11-17; the docs only say "separate limits" and "back off on
429"). This client keeps one shared token bucket for the whole process, backs
off on 429/5xx, and never retries a 4xx other than 429.
"""
from __future__ import annotations

import asyncio
import random
import time

import httpx

BASE = "https://api.elections.kalshi.com/trade-api/v2"


class RateLimiter:
    """Token bucket with multiplicative back-off on throttling."""

    def __init__(self, rate: float = 4.0, min_rate: float = 1.0, max_rate: float = 5.0):
        self.rate = rate
        self.min_rate = min_rate
        self.max_rate = max_rate
        self._next = time.monotonic()
        self._lock = asyncio.Lock()
        self._ok_streak = 0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if self._next < now:
                self._next = now
            delay = self._next - now
            self._next += 1.0 / self.rate
        if delay > 0:
            await asyncio.sleep(delay)

    def throttled(self) -> None:
        self.rate = max(self.min_rate, self.rate * 0.7)
        self._ok_streak = 0

    def ok(self) -> None:
        self._ok_streak += 1
        if self._ok_streak >= 200:
            self.rate = min(self.max_rate, self.rate * 1.05)
            self._ok_streak = 0


class KalshiPublic:
    def __init__(self, rate: float = 4.0, max_rate: float = 5.0, timeout: float = 60.0):
        self.limiter = RateLimiter(rate=rate, max_rate=max_rate)
        self.client = httpx.AsyncClient(
            timeout=timeout,
            http2=True,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
            headers={"Accept": "application/json", "User-Agent": "kalshi-edge-research/0.1"},
        )
        self.n_requests = 0
        self.n_throttled = 0

    async def aclose(self) -> None:
        await self.client.aclose()

    async def get(self, path: str, params: dict | None = None, max_tries: int = 12) -> dict:
        """GET with rate limiting and retry. Raises on a non-retryable error."""
        last = None
        for attempt in range(max_tries):
            await self.limiter.wait()
            try:
                r = await self.client.get(BASE + path, params=params)
            except (httpx.TransportError, httpx.TimeoutException) as e:  # network blip: retry
                last = e
                await asyncio.sleep(min(30.0, 1.5 ** attempt) + random.random())
                continue
            self.n_requests += 1
            if r.status_code == 200:
                self.limiter.ok()
                return r.json()
            if r.status_code == 429 or r.status_code >= 500:
                self.n_throttled += 1
                self.limiter.throttled()
                last = RuntimeError(f"{r.status_code} {path}")
                await asyncio.sleep(min(30.0, 0.5 * 1.6 ** attempt) + random.random())
                continue
            raise RuntimeError(f"GET {path} {params} -> {r.status_code}: {r.text[:300]}")
        raise RuntimeError(f"GET {path} {params} failed after {max_tries} tries: {last!r}")

    async def paginate(self, path: str, params: dict, key: str, limit: int = 1000):
        """Yield pages (lists) following the opaque cursor until it is empty."""
        cursor = ""
        p = dict(params)
        p["limit"] = limit
        while True:
            if cursor:
                p["cursor"] = cursor
            d = await self.get(path, p)
            rows = d.get(key) or []
            yield rows
            cursor = d.get("cursor") or ""
            if not cursor or not rows:
                return
