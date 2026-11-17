#!/usr/bin/env python3
"""Paper-mode live scanner for the frozen early-longshot-offer rule. Places no orders.

    python scripts/scan_live.py scan  [--bankroll 1000] [--risk 0.01] [--lead 60]
        Reads public milestones and quotes, prints the order tickets a person could place
        (buy NO at a limit, good until 45 minutes after the scheduled start) and appends
        them to forward/ledger.jsonl.

    python scripts/scan_live.py grade
        For every logged ticket whose window has closed, reads the public trade tape to
        see whether the resting price was traded through (pessimistic) or touched
        (optimistic), and the settled result once there is one. Writes forward/graded.jsonl.

Public endpoints only (about one request a second from a shared address), so a scan of
a busy evening takes a few minutes. An authenticated key would be far faster; this
script does not use one.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import fees, live, rules, taxonomy  # noqa: E402
from kalshi_edge.api import KalshiPublic  # noqa: E402

UTC = dt.timezone.utc
LEDGER = ROOT / "forward" / "ledger.jsonl"
GRADED = ROOT / "forward" / "graded.jsonl"


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()]


async def fetch_games(api: KalshiPublic, now: dt.datetime, lead: int) -> list[dict]:
    window_open = now - dt.timedelta(minutes=rules.EARLY_LONGSHOT_OFFER["max_mins_in"])
    window_close = now + dt.timedelta(minutes=lead)
    games = []
    async for page in api.paginate("/milestones", {"minimum_start_date": iso(window_open), "category": "Sports"}, "milestones", limit=500):
        stop = False
        for m in page:
            start = parse(m["start_date"])
            if start > window_close:
                stop = True
                continue
            det = m.get("details") or {}
            for ev in dict.fromkeys((m.get("primary_event_tickers") or []) + (m.get("related_event_tickers") or [])):
                series = ev.split("-")[0]
                if taxonomy.family_of(series) == "winner" and not taxonomy.is_period(series):
                    games.append({"id": m["id"], "title": m.get("title"), "start": start, "event_ticker": ev,
                                  "sport": taxonomy.sport_of(m.get("type")), "status": det.get("status") or ""})
        if stop:
            break
    return games


async def fetch_markets(api: KalshiPublic, games: list[dict], maker_series: set[str]) -> list[dict]:
    wanted = {g["event_ticker"] for g in games}
    series = sorted({ev.split("-")[0] for ev in wanted})
    out: list[dict] = []
    sem = asyncio.Semaphore(3)

    async def one(s: str) -> None:
        async with sem:
            async for page in api.paginate("/markets", {"series_ticker": s, "status": "open"}, "markets", limit=1000):
                for m in page:
                    if m.get("event_ticker") in wanted:
                        out.append({"ticker": m["ticker"], "event_ticker": m["event_ticker"], "series": s, "status": m.get("status"),
                                    "yes_ask": m.get("yes_ask_dollars"), "yes_bid": m.get("yes_bid_dollars"),
                                    "yes_ask_size": m.get("yes_ask_size_fp"), "yes_bid_size": m.get("yes_bid_size_fp"),
                                    "volume": m.get("volume_fp"), "title": m.get("yes_sub_title") or m.get("title"),
                                    "maker_rate": fees.MAKER_BASE if s in maker_series else 0.0})

    await asyncio.gather(*[one(s) for s in series])
    return out


async def scan(a) -> None:
    api = KalshiPublic(rate=2.0, max_rate=3.0)
    try:
        now = dt.datetime.now(UTC)
        sd = await api.get("/series", {"category": "Sports"})
        maker_series = {s["ticker"] for s in sd.get("series", []) if s.get("fee_type") == "quadratic_with_maker_fees"}
        games = await fetch_games(api, now, a.lead)
        markets = await fetch_markets(api, games, maker_series)
        tickets = live.longshot_tickets(games, markets, now=now, bankroll=a.bankroll, risk_per_position=a.risk, lead_minutes=a.lead,
                                        include_in_game=a.include_in_game)
        seen = {(r["ticker"], r["expires"]) for r in read_jsonl(LEDGER)}
        fresh = []
        LEDGER.parent.mkdir(exist_ok=True)
        with LEDGER.open("a") as f:
            for t in tickets:
                row = dict(t, placed_at=iso(now), start=iso(t["start"]), expires=iso(t["expires"]), mode="paper")
                if (row["ticker"], row["expires"]) in seen:
                    continue
                f.write(json.dumps(row) + "\n")
                fresh.append(row)
        print(f"{iso(now)}  games in window: {len({g['id'] for g in games})}  winner markets quoted: {len(markets)}  "
              f"tickets: {len(tickets)} ({len(fresh)} new)  requests: {api.n_requests} ({api.n_throttled} throttled)")
        for t in sorted(tickets, key=lambda t: t["start"]):
            print(f"  BUY NO {t['contracts']:>7.2f} @ {t['limit_price']:.2f}  good until {iso(t['expires'])[11:16]}Z  "
                  f"{t['ticker']:<46} {str(t['game'])[:38]:<38} starts in {t['mins_to_start']:>6.1f} min  "
                  f"risk ${t['max_loss']:.2f} to win ${t['max_gain']:.2f}")
    finally:
        await api.aclose()


async def grade(a) -> None:
    api = KalshiPublic(rate=2.0, max_rate=3.0)
    try:
        now = dt.datetime.now(UTC)
        done = {(r["ticker"], r["expires"]) for r in read_jsonl(GRADED) if r.get("final")}
        rows = [r for r in read_jsonl(LEDGER) if (r["ticker"], r["expires"]) not in done and parse(r["expires"]) <= now]
        graded_now = []
        for r in rows:
            lo, hi = int(parse(r["placed_at"]).timestamp()), int(parse(r["expires"]).timestamp())
            top, n = None, 0
            async for page in api.paginate("/markets/trades", {"ticker": r["ticker"], "min_ts": lo, "max_ts": hi}, "trades", limit=1000):
                for t in page:
                    px = float(t.get("yes_price_dollars") or 0)
                    top = px if top is None else max(top, px)
                    n += 1
            offer = round(r["yes_offer"] * 1000)
            through = top is not None and round(top * 1000) > offer
            touch = top is not None and round(top * 1000) >= offer
            mk = (await api.get(f"/markets/{r['ticker']}")).get("market", {})
            result, sv = mk.get("result"), mk.get("settlement_value_dollars")
            final = result in ("yes", "no", "scalar") and sv not in (None, "")
            out = dict(r, trades_in_window=n, top_yes_price=top, filled_through=through, filled_touch=touch, result=result or None, final=final)
            if final:
                y = float(sv)
                per = (1.0 - y) - r["limit_price"]
                out["pnl_if_filled"] = round(r["contracts"] * per - r["maker_fee"], 2)
                out["pnl_through"] = out["pnl_if_filled"] if through else 0.0
                out["pnl_touch"] = out["pnl_if_filled"] if touch else 0.0
            graded_now.append(out)
        keep = [r for r in read_jsonl(GRADED) if r.get("final")]
        final_keys = {(r["ticker"], r["expires"]) for r in keep}
        merged = keep + [r for r in graded_now if (r["ticker"], r["expires"]) not in final_keys]
        GRADED.write_text("".join(json.dumps(r) + "\n" for r in merged))
        fin = [r for r in merged if r.get("final")]
        print(f"{iso(now)}  tickets past their window: {len(merged)}  settled: {len(fin)}  awaiting settlement: {len(merged) - len(fin)}")
        for phase in ("pre", "in-game"):
            sub = [r for r in fin if r.get("phase_at_placement", "pre" if r["mins_to_start"] > 0 else "in-game") == phase]
            print(f"  placed {phase}: {len(sub)} settled tickets")
            for label, fkey, key in (("filled if traded through (pessimistic)", "filled_through", "pnl_through"),
                                     ("filled if touched (optimistic)", "filled_touch", "pnl_touch")):
                xs = [r for r in sub if r[fkey]]
                staked = sum(r["max_loss"] for r in xs)
                pnl = sum(r[key] for r in xs)
                wins = sum(1 for r in xs if r[key] > 0)
                print(f"    {label}: {len(xs)} positions, {wins} won, staked ${staked:.2f}, profit ${pnl:+.2f}"
                      + (f" ({100 * pnl / staked:+.2f}%)" if staked else ""))
    finally:
        await api.aclose()


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("--bankroll", type=float, default=1000.0)
    s.add_argument("--risk", type=float, default=0.01, help="share of bankroll at risk per position")
    s.add_argument("--lead", type=int, default=60, help="minutes before the scheduled start to begin")
    s.add_argument("--include-in-game", action="store_true", help="also ticket games already under way (the form that lost on the holdout)")
    sub.add_parser("grade")
    a = ap.parse_args()
    asyncio.run(scan(a) if a.cmd == "scan" else grade(a))


if __name__ == "__main__":
    main()
