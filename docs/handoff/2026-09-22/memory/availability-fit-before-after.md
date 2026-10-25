---
name: availability-fit-before-after
description: How the availability fit reaches the running app — two code paths, no deploy needed — plus the one cache that goes stale instead of repricing, and which Trade Brain pieces move with it.
metadata:
  type: project
  modified: 2026-09-19T20:15:46.116Z
---

Verified in code 2026-09-19. The fit lands in the same window as five PRs and a
deploy, so attribution has to be set up in advance.

**Two paths, both real.** `scripts/fit-availability.mjs` writes
`nfl_availability_rates` and `nfl_availability_role_rates`; both are read only
through `contingency.js#fittedAvailability`, which returns basis `constants` while
they are absent.
- Direct: `trade-engine.js:304` → `weeklyAvailability`, `:346` reads
  `active_probability` (fallback 0.92), `:359` multiplies this week's ppg by it
  outright, and the player-week distribution at `:399`/`:408` is seeded with it.
  So floors, ceilings and every ppg delta move, not just a displayed percentage.
- Through the simulator: `trade-engine.js:1317` runs `simulateSeason` under
  `HORIZON_SIM_SEED = 20260918`, 1000 runs, from the served week, and
  `season-sim.js:212` calls `weeklyAvailability` once per simulated week. The
  horizon and playoff odds read the tables a second time.

**The cache asymmetry, which is the trap.** Both tables' `fitted_at` stamps are in
`ASSET_INPUT_TABLES` (`trade-engine.js:224-225`), so every trade surface reprices
on the next request with no deploy and no restart. But
`GET /api/model/:leagueId/simulate` memoises in a plain `Map`
(`model.js:107-111`) keyed on league/runs/week/seed with no data fingerprint, and
`clearModelCache()` runs only from a league sync, `/api/dev/refresh-all` or the
big nfldata sync. The fit writes from a separate process over ssh, so that Map is
never touched: a before/after reading through that route with the same seed comes
back byte-identical and reads as "the fit changed nothing". Restart, sync a
league, or use an unused seed. Sent to the release thread, whose plan took both
readings with seed=1.

**Which Trade Brain pieces move.** `manager-signals.js`, `counterparty-pricing.js`
and `trade-acceptance.js` contain zero references to availability or
`active_probability`, so the signals route and the counterparty read cannot move
when the fit runs. Acceptance can: `acceptanceBand` (`trade-acceptance.js:142`,
called at `trade-engine.js:1921`) gates first on `edge.passes`, and the edge test
is ppg-derived — so the fit can flip a deal between `refuse('edge_failed')` and a
real band with nothing in the counterparty layer changing. That is what will look
like a Trade Brain regression and will not be one. Acceptance is attached only in
`findTrades`; `/offer` has no acceptance field at all, so its absence there is a
response shape, not missing data.

**One consumer that is NOT live, corrected 2026-09-19.** Three threads and the
release plan's step 9 said the fit changes `player-week-engine.js:190`, "the
shared projection engine every fantasy surface is built on". It does not. That
line is inside `applyRedistribution`, called at `:381` behind
`if (redistributeVolume)`, which defaults to **false** at `:262`. A repo-wide grep
returns five hits: three in that file, two in `scripts/eval-redistribution.mjs`.
Nothing in `server/` passes it, so the function never runs on a served request.
Eight modules import `weeklyAvailability`; seven reads are live and this one is
not. (If it is ever switched on, note its effect is not uniformly upward:
redistribution conserves the team total, so pricing a starter as more available
projects his backup LOWER.)

The measured baseline is in [[availability-live-baseline-numbers]]. See also
[[trade-brain-live-state-1919]].
