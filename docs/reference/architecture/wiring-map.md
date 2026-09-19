# Wiring map — what's live vs. what's a lab experiment

Read this before touching code or proposing a "new" signal. This repo has two kinds of
code that look similar but are not: the live, wired application, and standalone research
scripts that test one idea and are never imported by it. Confusing the two is the easiest
way to think a rejected idea is still running, or to miss that a live path already exists.

## 1. The live, wired path (production)

```
client/ (React)  →  server/routes/*.js  →  server/services/*.js  →  server/data.sqlite
                                              ↑
                                        server/services/scheduler.js
                                        (cron-style jobs: collectors, weekly learning,
                                         line snapshots, decision tape)
```

- **Full inventory, file:line entry points, per-model measured results and live/shadow/dead
  status** — [docs/betting-model/registry/MODEL-REGISTRY.csv](../../betting-model/registry/MODEL-REGISTRY.csv)
  (360 rows, last verified 2026-09-16). This is the single source of truth for "is X actually
  running, and where."
- **Which file belongs to fantasy vs. betting vs. shared code** —
  [domain-ownership.md](domain-ownership.md).
- **The rules the live system must obey** (gates, calibration, news verification) —
  [docs/reference/model-governance-manual.md](../model-governance-manual.md).
- **Folder-by-folder inventory** — [folder-map.csv](folder-map.csv).

## 2. Research / lab scripts — NOT wired into the app

Standalone scripts. Run manually from a terminal (`python3 scripts/model-lab/whatever.py`),
never imported by `server/` or `client/`, never registered in `package.json`'s `scripts`
block. Each one tests a single hypothesis against real historical data and dumps its raw
output under `docs/evidence/<date>/<lab-name>/`; the git commit message states the verdict.

| Folder | What it tests |
|---|---|
| `scripts/model-lab/` | Forecasting-signal experiments — Kalman filters, totals deep dives, the confidence meta-model, "unwired dataset" survivorship, the CLV+Kelly scorecard |
| `scripts/opener-lab/` | Whether/how the opening line is predictable or beatable, and at which market tier |
| `scripts/line-history/` | Backfills historical odds/line-movement data (Action Network, Covers, Polymarket) that the labs above consume |
| `scripts/board/` | Ad hoc weekly board generation, used for spot checks |
| `research/` | Older, broader statistical research modules (drift, leakage, market_lab, tree_lab, expert_selector_lab) with their own pytest suite (`research/test_*.py`) |

**If a lab finding is promoted to production, it gets ported into `server/services/` and
added as a real row (with `status: live`) in `MODEL-REGISTRY.csv`. The lab script itself is
never the shipped code — do not wire a page or job directly to something under
`scripts/model-lab/`, `scripts/opener-lab/`, or `research/`.**

## 3. Before building anything new

Check **[docs/HISTORICAL-TESTS.md](../../HISTORICAL-TESTS.md)** first. A large fraction of
plausible-sounding ideas — Kalman smoothing, a real-time news-speed edge, confidence-weighted
bet sizing, most of the "unwired dataset" candidates — have already been run against real
data and rejected. Re-running one from scratch reliably reproduces the same null and costs a
day; narrowing or extending a test that already found a partial signal (the opener-CLV result
is the one from 2026-09-16) is more productive than starting over.

## 4. Data

- **Live database**: `server/data.sqlite`. The app always reads/writes this exact file.
- **`server/data.sqlite.pre-migration-*.bak`**: automatic snapshots the migration runner
  takes before each schema change. Not a second copy of the project — just rollback
  insurance for the one live database. Safe to prune the oldest ones once you've confirmed
  the current schema is stable; do not delete the most recent one without checking first.
- **Off-repo historical backups**: `~/Documents/gridiron-db-backups` (outside this repo,
  not code — a separate manual backup habit).
