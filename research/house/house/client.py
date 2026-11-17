"""A slow, polite reader of Kalshi's public API. No key, no orders."""
from __future__ import annotations

import time

import httpx

BASE = "https://api.elections.kalshi.com/trade-api/v2"


class ApiError(RuntimeError):
    pass


class Kalshi:
    def __init__(self, rate: float = 1.0, timeout: float = 30.0, http=None, sleep=time.sleep, clock=time.monotonic):
        self.http = http or httpx.Client(timeout=timeout, headers={"User-Agent": "research-client"})
        self.floor = 1.0 / rate
        self.gap = self.floor
        self.sleep, self.clock = sleep, clock
        self.last = -1e9
        self.requests = self.throttled = 0

    def get(self, path: str, params=None, tries: int = 6):
        problem = None
        for attempt in range(tries):
            wait = self.last + self.gap - self.clock()
            if wait > 0:
                self.sleep(wait)
            self.last = self.clock()
            self.requests += 1
            try:
                r = self.http.get(BASE + path, params=params)
            except httpx.HTTPError as e:
                problem = repr(e)
                self.sleep(min(30, 2 ** attempt))
                continue
            if r.status_code == 200:
                self.gap = max(self.floor, self.gap * 0.98)
                return r.json()
            problem = f"{r.status_code} {r.text[:200]}"
            if r.status_code == 429 or r.status_code >= 500:
                self.throttled += 1
                self.gap = min(5.0, self.gap * 1.3)
                self.sleep(min(30, 2 ** attempt))
                continue
            break
        raise ApiError(f"{path}: {problem}")

    def pages(self, path: str, params: dict, key: str, max_pages: int = 50):
        params, out = dict(params), []
        for _ in range(max_pages):
            d = self.get(path, params)
            out += d.get(key) or []
            cursor = d.get("cursor") or d.get("next_cursor")
            if not cursor:
                return out, True
            params["cursor"] = cursor
        return out, False
