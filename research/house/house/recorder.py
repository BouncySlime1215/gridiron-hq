"""Photograph every order book that carries a liquidity reward.

Per sweep, for every market with an active reward programme:
  scores/DATE/HHMMSS.parquet  one row per side: the formula's verdict on that book
  books/DATE/HHMMSS.parquet   the raw levels, only for books that changed (all of them every keyframe)
and, every few minutes:
  meta/DATE/HHMMSS.parquet    volume, open interest, status
  trades/DATE.jsonl           public trades in markets whose volume moved (off by default: one request each)
  programs.jsonl              every programme row the first time it is seen
  grids.jsonl                 each market's price grid the first time it is seen
  sweeps.jsonl                one line per sweep: what was fetched, what failed, the totals

Reads public endpoints only. It cannot place an order.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from house import lip
from house.client import ApiError
from house.grid import UNIT, Grid, to_units

BATCH = 100
YES, NO = 1, 0


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


@dataclass(frozen=True)
class Program:
    id: str
    ticker: str
    reward: float      # dollars for the whole period
    start: float
    end: float
    target: float
    discount: float

    @classmethod
    def from_row(cls, r: dict) -> "Program":
        return cls(
            id=r["id"], ticker=r["market_ticker"], reward=r["period_reward"] / 10_000.0,
            start=_epoch(r["start_date"]), end=_epoch(r["end_date"]),
            target=float(r.get("target_size_fp") or 0), discount=(r.get("discount_factor_bps") or 0) / 10_000.0,
        )

    @property
    def per_day(self) -> float:
        return self.reward / ((self.end - self.start) / 86_400.0)


def parse_book(fp: dict) -> tuple[list, list]:
    yes = [(to_units(p), float(s)) for p, s in (fp or {}).get("yes_dollars") or []]
    no = [(to_units(p), float(s)) for p, s in (fp or {}).get("no_dollars") or []]
    return yes, no


def score_rows(ts: float, prog: Program, grid: Grid, yes: list, no: list) -> list[dict]:
    ys, ns = lip.qualify(yes, prog.target, prog.discount, grid), lip.qualify(no, prog.target, prog.discount, grid)
    rows = []
    for side, levels, s in ((YES, yes, ys), (NO, no, ns)):
        rows.append(dict(
            ts=ts, ticker=prog.ticker, side=side, ok=s.ok, valid=ys.ok and ns.ok,
            ref=s.reference or 0, best=max((p for p, _ in levels), default=0),
            low=s.levels[-1][0] if s.levels else 0,          # the lowest price that still qualifies
            score=s.total, qsize=s.size, full=s.full_credit_size, cap=s.collateral,
            depth=sum(z for _, z in levels), nlev=len(s.levels), perday=prog.per_day, target=prog.target,
        ))
    return rows


class Recorder:
    def __init__(self, root, api, now=time.time, programs_every=900, meta_every=900, keyframe_every=24, trades=False, log=print):
        self.root, self.api, self.now, self.log = Path(root), api, now, log
        self.programs_every, self.meta_every, self.keyframe_every = programs_every, meta_every, keyframe_every
        self.trades = trades      # one request per traded market: affordable for a watch list, not for 5,700 markets
        self.programs: dict[str, Program] = {}
        self.grids: dict[str, Grid] = {}
        self.volume: dict[str, float] = {}
        self.trades_from: dict[str, float] = {}
        self.book_seen: dict[str, int] = {}
        self.known_program_ids: set[str] = set()
        self.sweeps = 0
        self.t_programs = self.t_meta = float("-inf")
        self.root.mkdir(parents=True, exist_ok=True)
        seen = self.root / "programs.jsonl"
        if seen.exists():
            self.known_program_ids = {json.loads(line)["id"] for line in seen.open() if line.strip()}
        grids = self.root / "grids.jsonl"
        if grids.exists():           # a restarted recorder need not ask again for grids it already has
            for line in grids.open():
                if line.strip():
                    r = json.loads(line)
                    self.grids[r["ticker"]] = Grid.from_market(r["price_ranges"])

    # ---- files -------------------------------------------------------------
    def _path(self, kind: str, ts: float, ext: str = "parquet") -> Path:
        t = datetime.fromtimestamp(ts, timezone.utc)
        p = self.root / kind / t.strftime("%Y-%m-%d") / f"{t.strftime('%H%M%S')}.{ext}"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _write(self, kind: str, ts: float, rows: list[dict]) -> None:
        if rows:
            path = self._path(kind, ts)
            tmp = path.with_suffix(".tmp")
            pq.write_table(pa.Table.from_pylist(rows), tmp, compression="zstd")
            tmp.rename(path)

    def _append(self, name: str, rows: list[dict]) -> None:
        if rows:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                for r in rows:
                    f.write(json.dumps(r, separators=(",", ":")) + "\n")

    # ---- programmes and market facts ----------------------------------------
    def refresh_programs(self) -> None:
        ts, fresh, active = self.now(), [], {}
        for status in ("active", "upcoming"):
            rows, complete = self.api.pages(
                "/incentive_programs", {"status": status, "type": "liquidity", "limit": 10_000}, "incentive_programs")
            if not complete:
                self.log(f"programme list for {status} was cut short at {len(rows)} rows")
            for r in rows:
                if r["id"] not in self.known_program_ids:
                    self.known_program_ids.add(r["id"])
                    fresh.append({**r, "status": status, "first_seen": ts})
                if status == "active":
                    p = Program.from_row(r)
                    if p.target > 0 and p.end > p.start and (p.ticker not in active or p.start > active[p.ticker].start):
                        active[p.ticker] = p
        self._append("programs.jsonl", fresh)
        self.programs, self.t_programs = active, ts

    def refresh_meta(self, tickers: list[str], record: bool = True) -> list[str]:
        """Market facts for ``tickers``. Returns the ones whose volume has grown since last seen."""
        ts, rows, moved = self.now(), [], []
        for i in range(0, len(tickers), BATCH):
            chunk = tickers[i:i + BATCH]
            try:
                markets = self.api.get("/markets", {"tickers": ",".join(chunk), "limit": 1000})["markets"]
            except ApiError as e:
                self.log(f"market facts failed for {len(chunk)} markets: {e}")
                continue
            for m in markets:
                t = m["ticker"]
                if t not in self.grids:          # tick sizes are needed to value an order against a later book
                    self._append("grids.jsonl", [{"ticker": t, "price_ranges": m.get("price_ranges") or []}])
                self.grids[t] = Grid.from_market(m.get("price_ranges"))
                vol = float(m.get("volume_fp") or 0)
                if t in self.volume and vol > self.volume[t]:
                    moved.append(t)
                if t not in self.volume:
                    self.trades_from[t] = ts
                self.volume[t] = vol
                rows.append(dict(
                    ts=ts, ticker=t, event=m.get("event_ticker") or "", status=m.get("status") or "",
                    close=m.get("close_time") or "", volume=vol, oi=float(m.get("open_interest_fp") or 0),
                    last=to_units(m.get("last_price_dollars") or 0), title=(m.get("title") or "")[:120],
                    sub=(m.get("yes_sub_title") or "")[:80], result=m.get("result") or "",
                ))
        if record:
            self._write("meta", ts, rows)
        return moved

    def fetch_trades(self, tickers: list[str]) -> int:
        ts, n = self.now(), 0
        day = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
        for t in tickers:
            try:
                trades, complete = self.api.pages(
                    "/markets/trades", {"ticker": t, "min_ts": int(self.trades_from.get(t, ts)) - 5, "limit": 1000},
                    "trades", max_pages=5)
            except ApiError as e:
                self.log(f"trades failed for {t}: {e}")
                continue
            self._append(f"trades/{day}.jsonl", [{**tr, "fetched": ts, "complete": complete} for tr in trades])
            self.trades_from[t] = ts
            n += len(trades)
        return n

    # ---- the sweep -----------------------------------------------------------
    def sweep(self) -> dict:
        t0 = self.now()
        tickers = sorted(self.programs)
        unknown = [t for t in tickers if t not in self.grids]
        if unknown:
            self.refresh_meta(unknown)
        keyframe = self.sweeps % self.keyframe_every == 0
        scores, books, failed, unscored, changed = [], [], [], 0, 0
        for i in range(0, len(tickers), BATCH):
            chunk = tickers[i:i + BATCH]
            try:
                got = self.api.get("/markets/orderbooks", [("tickers", t) for t in chunk])["orderbooks"]
            except ApiError as e:
                failed += chunk
                self.log(f"books failed for {len(chunk)} markets: {e}")
                continue
            ts = self.now()
            for ob in got:
                t = ob["ticker"]
                prog = self.programs.get(t)
                if prog is None:
                    continue
                yes, no = parse_book(ob.get("orderbook_fp"))
                try:
                    scores += score_rows(ts, prog, self.grids.get(t, Grid()), yes, no)
                except ValueError as e:      # a price off the market's grid: keep the book, say so, score nothing
                    unscored += 1
                    self.log(f"{t} not scored: {e}")
                mark = hash((tuple(yes), tuple(no)))
                if keyframe or self.book_seen.get(t) != mark:
                    changed += self.book_seen.get(t) != mark
                    self.book_seen[t] = mark
                    books += [dict(ts=ts, ticker=t, side=YES, price=p, size=s) for p, s in yes]
                    books += [dict(ts=ts, ticker=t, side=NO, price=p, size=s) for p, s in no]
                    if not yes and not no:
                        books.append(dict(ts=ts, ticker=t, side=-1, price=0, size=0.0))   # an empty book is a fact too
        self._write("scores", t0, scores)
        self._write("books", t0, books)
        valid = [r for r in scores if r["valid"]]
        line = dict(
            t0=t0, t1=self.now(), sweep=self.sweeps, keyframe=keyframe, programs=len(tickers),
            scored=len(scores) // 2, changed=int(changed), failed=failed, unscored=unscored,
            pool_day=sum(p.per_day for p in self.programs.values()),
            pool_day_valid=sum(r["perday"] for r in valid) / 2,
            collateral=sum(r["cap"] for r in valid),
            requests=getattr(self.api, "requests", 0), throttled=getattr(self.api, "throttled", 0),
        )
        self._append("sweeps.jsonl", [line])
        self.sweeps += 1
        return line

    def step(self) -> dict:
        if self.now() - self.t_programs >= self.programs_every:
            self.refresh_programs()
        line = self.sweep()
        if self.now() - self.t_meta >= self.meta_every:
            self.t_meta = self.now()
            moved = self.refresh_meta(sorted(self.programs))
            line["moved"] = len(moved)
            if self.trades:
                line["trades"] = self.fetch_trades(moved)
        return line
