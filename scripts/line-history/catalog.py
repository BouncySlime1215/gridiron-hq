#!/usr/bin/env python3
"""
One inventory of every table Gridiron HQ holds, across all four databases.

After the 2026-09-16 loss of the live database, the data lives in four files with
different roles and no single place that says what is where. This walks all of them and
writes docs/evidence/<date>/recovery/DATA-CATALOG.md plus a .json alongside it.

For each table: which database, row count, the time column it is keyed on, and that
column's range. The range is what tells you whether a source is complete or truncated —
a collector that died mid-backfill looks fine by row count and wrong by max(ts).

Read-only on every file, so it is safe to run while collectors are writing.

Usage: python3 scripts/line-history/catalog.py [--out DIR]
"""
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

DBS = {
    "line_history": (REPO / "data/line-history/line_history.sqlite",
                     "Market history rebuilt from free sources after the loss"),
    "nflverse": (REPO / "data/line-history/nflverse.sqlite",
                 "Full nflverse mirror: play-by-play, participation, stats, rosters"),
    "extract": (REPO / "data/line-history/extract-2026-09-16.sqlite",
                "Read-only extract taken from the live database hours before it was deleted"),
    "repo": (REPO / "server/data.sqlite",
             "Application database in the repo; the surviving restore point"),
}

# Candidate time columns, best first. The first one a table has is the one reported.
TIME_COLS = ["snapshot_at", "captured_at", "created_time", "created_at", "published_at",
             "ts_utc", "commence_time", "updated_at", "fetched_at", "gameday", "game_date",
             "start_time", "close_time", "date", "ts", "t", "season", "week"]

# Epoch-second columns, reported as dates rather than raw integers.
EPOCH_COLS = {"t", "ts"}


def human(ts, col):
    if ts is None:
        return None
    if col in EPOCH_COLS:
        try:
            return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
        except (ValueError, OSError, TypeError):
            return str(ts)
    return str(ts)[:19]


def scan(path):
    if not path.exists():
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.execute("PRAGMA query_only=1")
    out = []
    names = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    for n in names:
        try:
            rows = con.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0]
        except sqlite3.Error:
            continue
        if not rows:
            continue
        cols = [r[1] for r in con.execute(f'PRAGMA table_info("{n}")')]
        tc = next((c for c in TIME_COLS if c in cols), None)
        lo = hi = None
        if tc:
            try:
                lo, hi = con.execute(f'SELECT MIN("{tc}"), MAX("{tc}") FROM "{n}"').fetchone()
            except sqlite3.Error:
                tc = None
        out.append(dict(table=n, rows=rows, time_col=tc,
                        first=human(lo, tc or ""), last=human(hi, tc or ""), cols=len(cols)))
    con.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    today = dt.date.today().isoformat()
    outdir = Path(a.out) if a.out else REPO / "docs/evidence" / today / "recovery"
    outdir.mkdir(parents=True, exist_ok=True)

    cat, totals = {}, {}
    for key, (path, _desc) in DBS.items():
        tables = scan(path)
        if tables is None:
            cat[key] = None
            continue
        cat[key] = tables
        totals[key] = dict(tables=len(tables), rows=sum(t["rows"] for t in tables),
                           bytes=path.stat().st_size)

    L = [f"# Gridiron HQ data catalog — {today}", "",
         "Every non-empty table across all four databases, with the time range that shows",
         "whether a source is complete or truncated. Regenerate with",
         "`python3 scripts/line-history/catalog.py`.", "",
         "| Database | Tables | Rows | Size | Role |", "|---|---:|---:|---:|---|"]
    for key, (path, desc) in DBS.items():
        if cat[key] is None:
            L.append(f"| `{key}` | — | — | — | **MISSING** at `{path}` |")
            continue
        t = totals[key]
        L.append(f"| `{key}` | {t['tables']} | {t['rows']:,} | {t['bytes'] / 1e9:.2f} GB | {desc} |")
    L.append("")

    for key, (path, desc) in DBS.items():
        if not cat[key]:
            continue
        L += [f"## {key}", f"`{path.relative_to(REPO) if path.is_relative_to(REPO) else path}` — {desc}", "",
              "| Table | Rows | Keyed on | First | Last |", "|---|---:|---|---|---|"]
        for t in sorted(cat[key], key=lambda x: -x["rows"]):
            L.append(f"| {t['table']} | {t['rows']:,} | {t['time_col'] or ''} | "
                     f"{t['first'] or ''} | {t['last'] or ''} |")
        L.append("")

    (outdir / "DATA-CATALOG.md").write_text("\n".join(L) + "\n")
    json.dump(dict(generated=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                   totals=totals, tables=cat), open(outdir / "DATA-CATALOG.json", "w"), indent=1)
    print("\n".join(L[:12]))
    print(f"\nwrote {outdir / 'DATA-CATALOG.md'}")


if __name__ == "__main__":
    main()
