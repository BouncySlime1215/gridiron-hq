"""Every open event on Kalshi with its markets, top of book and rules, from the public API.

  python scripts/pull_board.py            -> data/board/<UTC stamp>/{markets.parquet, rules.parquet, pages.json}
Public reads only. One request about every 1.5 seconds.
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pandas as pd

B = "https://api.elections.kalshi.com/trade-api/v2"
ROOT = Path(__file__).resolve().parents[1] / "data" / "board"
stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
out = ROOT / stamp
out.mkdir(parents=True)
c = httpx.Client(timeout=60, headers={"User-Agent": "research-client"})


def get(path, params):
    for attempt in range(8):
        try:
            r = c.get(B + path, params=params)
            if r.status_code == 200:
                return r.json()
        except httpx.HTTPError:
            pass
        time.sleep(min(30, 2 ** attempt))
    raise SystemExit(f"gave up on {path}")


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


rows, rules, cursor, pages, t0 = [], [], None, 0, time.time()
while True:
    params = {"status": "open", "with_nested_markets": "true", "limit": 200}
    if cursor:
        params["cursor"] = cursor
    d = get("/events", params)
    now = time.time()
    for e in d.get("events", []):
        for m in e.get("markets") or []:
            rows.append(dict(
                ts=now, ticker=m["ticker"], event=e["event_ticker"], series=e.get("series_ticker"), category=e.get("category"),
                exclusive=bool(e.get("mutually_exclusive")), event_title=e.get("title"), event_sub=e.get("sub_title"),
                title=m.get("title"), yes_sub=m.get("yes_sub_title"), no_sub=m.get("no_sub_title"), status=m.get("status"),
                market_type=m.get("market_type"), strike_type=m.get("strike_type"), floor=f(m.get("floor_strike")), cap=f(m.get("cap_strike")),
                custom_strike=json.dumps(m.get("custom_strike")) if m.get("custom_strike") else None,
                yes_bid=f(m.get("yes_bid_dollars")), yes_ask=f(m.get("yes_ask_dollars")), no_bid=f(m.get("no_bid_dollars")), no_ask=f(m.get("no_ask_dollars")),
                yes_bid_size=f(m.get("yes_bid_size_fp")), yes_ask_size=f(m.get("yes_ask_size_fp")),
                volume=f(m.get("volume_fp")), volume_24h=f(m.get("volume_24h_fp")), oi=f(m.get("open_interest_fp")),
                open_time=m.get("open_time"), close_time=m.get("close_time"), expected_expiration=m.get("expected_expiration_time"),
                latest_expiration=m.get("latest_expiration_time"), can_close_early=m.get("can_close_early"),
                structure=m.get("price_level_structure"), collateral_return=e.get("collateral_return_type"),
            ))
            rules.append(dict(ticker=m["ticker"], rules_primary=m.get("rules_primary"), rules_secondary=m.get("rules_secondary"),
                              early_close=m.get("early_close_condition")))
    pages += 1
    cursor = d.get("cursor")
    if pages % 20 == 0:
        print(pages, "pages", len(rows), "markets", round(now - t0), "s", flush=True)
    if not cursor or not d.get("events"):
        break
    time.sleep(1.5)
pd.DataFrame(rows).to_parquet(out / "markets.parquet", compression="zstd")
pd.DataFrame(rules).to_parquet(out / "rules.parquet", compression="zstd")
(out / "pages.json").write_text(json.dumps(dict(pages=pages, markets=len(rows), seconds=round(time.time() - t0), stamp=stamp)))
print("done", pages, "pages", len(rows), "markets ->", out, flush=True)
