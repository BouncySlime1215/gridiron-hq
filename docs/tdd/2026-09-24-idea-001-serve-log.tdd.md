# TDD evidence: serve-log, the served number kept as served (IDEA-001)

Unit IDEA-001. Branch `claude/cloud-serve-log-8qp6e3`, base `origin/main` `d861c11`.
The spec is the task prompt (IDEA-001 is not on the handoff branch).

**Before:** four routes computed a trade-card, title-odds or range number, sent
it and kept nothing. On `d861c11`:

- `server/routes/model.js:483` `res.json(tradeImpact(...))` (TradeCard's title block)
- `server/routes/model.js:470` `res.json(withRandomSeed(... simulateSeason ...))` (title odds, 95% intervals)
- `server/routes/trades.js:663` `res.json(titleOddsTrades(...))` (Title-impact tab)
- `server/routes/trades.js:736` `res.json(findTrades(...))` (trade cards: ppg, value, p10/p90 lineup delta)

`git grep -n served_numbers d861c11 -- server` → 0 hits. Control, same command
for a table that does exist: `git grep -c trade_outcomes d861c11 -- server/migrations`
→ `067_outcome_ledgers.js:21`. `trade_outcomes` holds the proposals slate only.

## What changed

| Piece | Where |
|---|---|
| Table `served_numbers` (additive; one table, two indexes) | `server/migrations/079_served_numbers.js` |
| Queue, extractors, flush, reader, weekly job | `server/services/serve-log.js` |
| Writer (the only INSERT) | `serve-log.js` `writeRows` |
| Request-path call: `recordServed` (one header + one push, no SQL) | `model.js` trade-impact and simulate; `trades.js` title-trades and find |
| Flush loop (1 s, ≤2,000 rows a tick), started unconditionally | `server/index.js` after `startScheduler` |
| Weekly job `served_numbers_weekly` (growth, offThread, 12 h maxAge, idempotent per league/season/week) | `scheduler.js` JOBS; `scripts/refresh-live-data.mjs` FANTASY_LIVE_JOBS |
| Read-back + queue state | `GET /api/trades/:leagueId/served-numbers` |

Row: `league_id, surface, entity, field, value, model, model_version, as_of,
served_at, request_id, trigger, season, week`. `entity` is
`deal:<me>|<partner>|<sorted give ids>><sorted get ids>` or `team:<roster id>`.
Ranges are stored as their own fields: `title_delta_lo/hi` (±2 paired SE, what
TradeCard prints at `client/src/components/TradeCard.tsx:369`), `title_odds_lo/hi`
and `playoff_odds_lo/hi` (the simulator's `binomial95`), `floor_delta/ceiling_delta`.

## RED → GREEN

- RED `aa65f7f` `test: RED for IDEA-001 serve-log (...)`. Failing on the unfixed tree:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/serve-log.js'`,
  `# tests 1 # pass 0 # fail 1`. A module-not-found RED proves only absence; the
  per-behaviour liveness is the mutation sweep below.
- GREEN `384c31b` `feat: serve-log — snapshot every served ...`: 19/19.
- Follow-up test (error payload) added after M12 survived, in the commit carrying this file: 20/20.

## Liveness: mutation sweep (test/serve-log.test.js, 20 tests)

| Mutant | Kind | Result |
|---|---|---|
| M1 `recordServed` also flushes (write on request thread) | unit | killed (5 fail) |
| M2 trade-impact route drops `recordServed` | call site | killed (2) |
| M3 find route drops `recordServed` | call site | killed (1) |
| M4 band width 1 SE instead of 2 | unit | killed (3) |
| M5 deal ids unsorted | unit | killed (2) |
| M6 no drop at queue cap | unit | killed (1) |
| M7 failed flush does not re-queue | unit | killed (1) |
| M8 weekly job not idempotent | unit | killed (1) |
| M9 row budget ignored | unit | killed (1) |
| M10 null value stored as 0 | unit | killed (1) |
| M11 title-trades call site drops `myTeamId` | call site | killed (1) |
| M12 error payload recorded | unit | **survived first**, test added, then killed (1) |
| C1 comment edit (designed survivor) | control | survived, as designed |
| C2 pattern absent (designed not-applied) | control | reported NOT APPLIED, as designed |

## Benchmarks (this branch, temp DB, 3 runs each)

- `recordServed`: 3.88–5.97 µs per call (500 calls, 300-deal payload).
- Before the row budget: 500 queued 300-deal `/find` payloads = 900,000 rows in
  one flush, 12.3–13.9 s on the main thread. Found by this benchmark, fixed in GREEN.
- With the budget: one tick = 2 entries, 3,600 rows, 23.5–24.7 ms.

## Nick's five questions

1. **Well built?** Request path does one header and one array push; SQL only in the
   flush and the weekly job; parameterised; no bare catch (extract errors, drops and
   write failures are counted in `serveLogState()` and served on the read route).
2. **Stats or made up?** No statistics. It records what the existing models produced.
3. **How we know:** tests with fixtures and the mutation sweep. No backtest applies.
   Hand-set constants: queue cap 500, 2,000 rows a tick, 1 s tick, 12 h job maxAge,
   weekly `simulateSeason` at 2,000 runs, finder snapshot `limit: 20`. All guesses
   sized by the benchmark, not fitted.
4. **Pointed anywhere else?** Nothing reads `served_numbers` yet except the
   read-back route. The grader that compares served numbers to outcomes is not built.
5. **How it unifies:** one entity key for a deal on every surface (TradeCard,
   Title-impact tab, finder), so one deal's numbers line up across surfaces and weeks.

- Gap fixed: served numbers were not kept (call sites above, `d861c11`).
- Incumbent: none (`git grep served_numbers d861c11` → 0).
- Does NOT cover: `/find/sequences`, `/offer`, `/offer-many`, `/evaluate`,
  `/sense-check`'s own simulation, proposals (`trade_outcomes` covers those).
- Would make it wrong: `model_version` is the run config (runs, seed, from_week;
  engine + cutoff for the finder), not a code version. There is no build/commit id
  at runtime, so a code change between two rows with the same config is invisible.
  The in-memory queue is lost on a crash or restart (up to one second of rows, more
  if the flush is failing).
