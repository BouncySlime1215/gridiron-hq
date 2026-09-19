# Free NFL line-history collectors

Built 2026-09-16. All three write to one SQLite file, `data/line-history/line_history.sqlite`
(gitignored; override with `LINE_HISTORY_DB`). None touch `server/data.sqlite`.

| Collector | Source | What you get | Depth | Run |
|---|---|---|---|---|
| `covers_backfill.py` | covers.com line-history modal (undocumented HTML) | every line change with a minute timestamp (Eastern) for bet365, BetVictor, William Hill, Betway; spread, moneyline, total; open row flagged | 2019 season to today, verified | once for history, then weekly for the current season |
| `polymarket_backfill.py` | Polymarket Gamma + CLOB public APIs | one mid price per minute for the winner market (2024+), and the spread and game-total markets (2025+) | 2024-08 to today | once, then weekly (`--refetch-open` refreshes markets still trading) |
| `actionnetwork_capture.py` | Action Network web API (undocumented) | every tick for Consensus, Open, Caesars, DraftKings, FanDuel, BetRivers, BetMGM, bet365; spread, moneyline, total, team totals | only the current and previous week are served; older games return empty history | at least weekly, forever |

Facts that cost time to learn, so they are written down:

- Polymarket `prices-history` returns nothing for a closed market with `interval=max`. Pass `startTs`/`endTs`.
- Action Network's scoreboard ignores `date=`; use `season=YYYY&week=N&period=game`.
- Covers and SBR share game ids (same owner) but SBR's Next.js route ignores past dates; Covers' `matchups?selectedDate=` does not.
- Covers rows carry month and day only; the year is inferred from the game date (December moves for a January game roll back one year; rows a few days after the game are post-game quotes and keep the game's year).
- Covers team codes differ from nflverse: `JAC` -> `JAX`, `LA` -> `LAR`.
- Covers pages run 0.5 to 17 MB each; keep the 1.2 s sleep. Three workers in parallel finished eight seasons in about an hour.

Row counts at the end of the first run: Covers 2,529 games / 1,914,688 rows; Polymarket 3,049 markets / 16.6M points; Action Network 31 games / 36,078 ticks.
