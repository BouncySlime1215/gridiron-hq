---
name: gridiron-asset-universe-cannot-go-offthread
description: trade_asset_universe_warm is the one Gridiron HQ job whose entire product is in-process memory, so it can never run in a worker; and the main-thread allow-list only held on the boot path until PR #77.
metadata:
  type: project
  modified: 2026-09-20T04:10:00.000Z
---

PR **#77**, head `3902ba7`, draft, **based on #63's branch**
(`claude/project-thread-o3wt2p-timer-tier`), branch
`claude/project-thread-o3wt2p-mainthread-holds`. Local check in full:
**2989 tests / 0 fail / 41 skipped**, build and start:smoke clean. Not in the
morning merge list unless Nick wants it; #63 lands first either way.

## The job that can never move

`trade_asset_universe_warm` (`refreshTradeAssetUniverse`, growth, every 20 min)
calls `assetUniverse(lg, formatKey)` for every league someone has a membership
in. **It writes nothing.** Its only product is a warm entry in
`compute-cache.js`'s `store` — `compute-cache.js:24`, `const store = new Map()`,
no table, no INSERT — so Trade Lab does not pay a 5–6 s cold build.

`job-worker.js` gives each run a **fresh module graph and exits when the job
returns**. Off-thread this job would do all the work, fill a Map in a thread
about to disappear, post `{ leagues_warmed: 5 }` and exit: job succeeds,
`sync_log` reads `ok`, nothing served faster.
[[gridiron-failure-modes]] exactly.

**Structural, not a flag.** A cache in one process cannot be warmed from
another. The only real lift is persisting the asset universe the way
`report-cache.js` persists reports to `nfl_cached_reports` (`:179`) — which is
what lets `nfl_reports` run off-thread today. Until then the job still blocks
the request thread 5–6 s per league every 20 min, and moving it would hide that
from the job's own status while users still waited.

Checked: none of the 8 already-off-thread jobs has this shape; `nfl_reports`
persists, `fantasy_coordinator_refit` persists.

## The allow-list held by coincidence

`MAIN_THREAD_ONLY` was read only by `bootOffThread`, i.e. the boot pass.
`resolveOffThread` never looked at it. All three book-feeds entries are
`live`-tier with no flag, so the old rule answered false anyway — verified by
running it. Flag one, or move one to the heavy tier (off-thread by default),
and the timer path would send it to a worker. **Same shape #63 fixed one layer
up.** #77 makes `resolveOffThread` consult the map on every path, ahead of both
the flag and the override, matched **by identity against `JOBS`** so no
signature or call site changes.

## Audit result for the other 18 on-thread growth/metered jobs

62 jobs total: 23 live / 13 growth / 6 metered on-thread, 8 off-thread, 12
heavy (gated). A transitive module-state scan is **useless here** — 1,460
"shared" mutable bindings across 19 closures, nearly all memos
([[offthread-fix-misses-background-tick]]). The criterion that decides it,
given a fresh worker per run:
- **memo** → cold per run, costs CPU, no correctness change. Safe.
- **cross-run coordination** (rate limiter, backoff, warn-once) → resets every
  run. `sportsgameodds.js:36 _lastCallAt` and `odds-api.js:63 _lastHold` are
  the only two found; the odds-api credit **reserve itself is DB-backed
  (`odds_usage`)**, so only the `last_hold` diagnostic in `reserveStatus()`
  would go blank. Betting-side, scheduling-only, not touched.
- **the job's product IS the memo** → can never move. One instance, above.

Evidence: `docs/tdd/main-thread-only-holds.tdd.md`, 9 rules, 9 mutations.
Sweep: [[gridiron-tdd-evidence-sweep-o3wt2p]]. Stack:
[[gridiron-scheduler-stack-state]].
