#!/usr/bin/env python3
"""
Per-game sportsbook opener table for the model lab (C1, C2, H4), read-only
from nfl_odds_archive, 2022-2025, spreads and totals.

Reference opener = repaired game_lines opener (migration 055 evidence file).
"Window" books = books whose opener was posted within 48 h of Pinnacle's own
opener posting time (the same window migration 055 uses). Pinnacle itself is
excluded from dispersion/best-line when its opener was repaired or suspect.

Per game, per market:
  dispersion      stdev of window-book openers (home spread / total)
  best_home       best home spread among window books (largest), with book, price
  best_away       best away spread (largest, away perspective)
  best_over       lowest total; best_under highest total
  stale           window books that posted AT OR AFTER Pinnacle and differ by
                  >= 1 pt from the reference opener: [{book, line, price}]
Usage: python3 scripts/model-lab/books.py
"""
import json, sqlite3, statistics as st
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIVE = "/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite"
EV = REPO / "docs/evidence/2026-09-16"
WINDOW_H = 48


def ts(x):
    return datetime.fromisoformat(x.replace("Z", "+00:00")).timestamp() if x else None


def main():
    ref = {(g["season"], g["week"], g["home"]): g for g in json.load(open(EV / "opener-repair/repaired-openers.json"))["games"]}
    con = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    q = defaultdict(lambda: defaultdict(dict))
    for s, w, h, a, book, market, side, line, price, upd in con.execute(
            """SELECT season, week, home, away, book, market, side, line, price, book_updated_at
               FROM nfl_odds_archive WHERE phase='open' AND season BETWEEN 2022 AND 2025
               AND market IN ('spreads','totals') AND line IS NOT NULL"""):
        q[(s, w, h)][(market, side)][book] = dict(line=line, price=price, t=ts(upd), away=a)
    out = []
    for key, sides in q.items():
        g = ref.get(key)
        if g is None:
            continue
        s, w, h = key
        a = g["away"]
        rec = dict(season=s, week=w, home=h, away=a)
        pin_bad = g["open_spread_source"] != "pinnacle_archive_reopen_2022_2025"
        for market, hs, as_, refline, pbad in (
                ("spreads", h, a, g["open_spread"], pin_bad),
                ("totals", "Over", "Under", g["open_total"], g.get("open_total_source") is not None)):
            home_q, away_q = sides.get((market, hs), {}), sides.get((market, as_), {})
            pin = home_q.get("pinnacle")
            if not pin or pin["t"] is None or refline is None:
                continue
            tP = pin["t"]
            def window(qs):
                return {b: v for b, v in qs.items() if v["t"] is not None and abs(v["t"] - tP) <= WINDOW_H * 3600
                        and not (b == "pinnacle" and pbad)}
            wh, wa = window(home_q), window(away_q)
            m = {}
            if len(wh) >= 2:
                m["dispersion"] = st.pstdev(v["line"] for v in wh.values())
                m["n_books"] = len(wh)
            if market == "spreads":
                if wh:
                    b = max(wh, key=lambda k: (wh[k]["line"], wh[k]["price"]))
                    m["best_home"] = dict(book=b, line=wh[b]["line"], price=wh[b]["price"])
                if wa:
                    b = max(wa, key=lambda k: (wa[k]["line"], wa[k]["price"]))
                    m["best_away"] = dict(book=b, line=wa[b]["line"], price=wa[b]["price"])
            else:
                if wh:
                    b = min(wh, key=lambda k: (wh[k]["line"], -wh[k]["price"]))
                    m["best_over"] = dict(book=b, line=wh[b]["line"], price=wh[b]["price"])
                if wa:
                    b = max(wa, key=lambda k: (wa[k]["line"], wa[k]["price"]))
                    m["best_under"] = dict(book=b, line=wa[b]["line"], price=wa[b]["price"])
            m["stale"] = [dict(book=b, line=v["line"], price=v["price"]) for b, v in wh.items()
                          if b != "pinnacle" and v["t"] >= tP and abs(v["line"] - refline) >= 1.0]
            rec[market] = m
        out.append(rec)
    path = EV / "model-lab/books.jsonl"
    with open(path, "w") as fh:
        for r in sorted(out, key=lambda r: (r["season"], r["week"], r["home"])):
            fh.write(json.dumps(r) + "\n")
    n_stale = sum(len(r.get("spreads", {}).get("stale", [])) > 0 for r in out)
    n_stale_t = sum(len(r.get("totals", {}).get("stale", [])) > 0 for r in out)
    print(f"{len(out)} games; games with a stale-book spread opener: {n_stale}; totals: {n_stale_t}; wrote {path.relative_to(REPO)}")


if __name__ == "__main__":
    main()
