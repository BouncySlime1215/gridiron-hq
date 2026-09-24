# RL-19-3: title-mutual trade class

WORK-QUEUE row RL-19-3 (handoff branch): stop the trade finder silently dropping
1-for-1 deals that raise BOTH teams' title odds but fail the lineup-points gates;
surface them as a distinct `title_mutual` class beside the points-mutual class.

Flag: `GRIDIRON_TITLE_MUTUAL_ENABLED=1`, or preview mode
(`GRIDIRON_PREVIEW_UNCONFIRMED=1`, preview-mode.js). Default off.

## What changed

- `server/services/title-mutual.js` (new): the flag (`titleMutualMode`), the
  candidate test (`titleCandidate`: 1-for-1, not points-mutual, no red flag, no
  hole left in their lineup, market value inside the finder's -12..+18% band),
  the shortlist (`TITLE_MUTUAL_BUDGET` = 12, one per partner+pair, least-bad
  joint lineup change first), and the scorer (`titleMutualDeals`). Keeps a deal
  only when `mutualTitleGain` (title-odds-trades.js, reused) holds: both
  title deltas > 0 and each past `TRADE_DELTA_NOISE_SE` (2) paired SEs.
- `trade-engine.js#findTradesUncached`: the points gate at `me.ppg_delta < 0.4`
  is unchanged; a 1-for-1 it drops is kept aside when the flag is on. Deals that
  clear that gate but are not `mutual` join the pool. One `tradeImpactWorld`
  per search (RL-19-2 fast rescore), built only when the pool is non-empty;
  each shortlisted deal is one `tradeImpact(..., { world })`, the same seed and
  run count as every other title-odds surface. Result gains
  `title_mutual: { status, considered, simulated, errors, budget, deals }`;
  `deals` (points classes) is not touched.
- The stage runs only with `requireMutual` and never with `teamsOverride`
  (findTradeSequences' hypothetical rosters: the simulator plays the real ones).
- The findTrades cache key carries the flag state (`tm0`/`tm1`/`tmp`).
- A world that cannot be built returns `status: 'failed'` with the simulator's
  error; TradeLab prints it. A deal whose impact errors is counted in `errors`.
- UI: TradeLab shows the class above the points list; TradeCard badges a deal
  "BOTH TITLE ODDS UP" with both deltas in the tooltip.

## RED

`test/rl-19-3-title-mutual.test.js`, commit `7aa4479` (fixture fix `test:` commit
after it). Fixture: RL-19-2's league shape (4 ESPN teams, 3 NFL games, real
copula, outcome pools off the global stream), slots QB/RB/WR. Team 1 is short at
RB with a spare WR; team 2 the reverse. On adj_ppg each spare (4.0) is below the
other side's starter (9.0), so the swap moves neither lineup: me 0.0, them 0.0
(fails both gates). In the sim (mu 14 vs 5) each spare is a big upgrade.

On the pre-change engine (implementation stashed, fixed fixture):

```
ok 1 - RL-19-3 premise: the spare-for-spare swap raises both title odds past 2 SE (paired seeds)
ok 2 - RL-19-3 premise: the points gate drops the swap (flag off, either mutual setting)
not ok 3 - ... returns the swap tagged title_mutual ...   TypeError: Cannot read properties of undefined (reading 'status')
not ok 4 - ... preview mode turns the class on ...        (same)
not ok 5 - ... requireMutual=false never runs ...         (same)
```

The first fixture (commit `7aa4479`) red-flagged the swap for a reason outside
the change: `analyzeLeague` reads the real player tables, which hold none of the
fixture's players, so it marked team 2 "already-thin RB" and every RB-for-WR swap
carried a red flag. The fixture now hands `analyzeLeague` the fixture's own
needs (mocked with `defaultExport` for the router, per CLAUDE.md's PR #7 note).

## GREEN

Same file, implementation applied: 7/7 pass (two tests added after RED: the
teamsOverride skip and the pinned keep rule; see the mutation sweep).

Two existing suites stub season-sim.js with a fixed export list
(`scoring-call-sites`, `scoring-call-site-followups`); trade-engine.js now also
imports `tradeImpactWorld`, so it was added to both stubs (never called there),
the same way B-01 added `simStartWeek`. `mutualTitleGain` moved from
title-odds-trades.js into title-mutual.js (re-exported from its old home) so the
new module does not pull title-odds-trades.js, and with it `TRADE_IMPACT_RUNS`,
into those stubbed imports.

## Measured (fixture, 1,200 paired runs, tradeImpactSeed)

Scratch run (not committed), same fixture, `findTrades(requireMutual=true)`:

| | flag off | flag on |
|---|---|---|
| wall time, 1st / 2nd call | 29.6 / 13.8 ms | 287.9 / 208.6 ms |
| points-class deals | 0 | 0 (same list) |
| title pool considered / simulated / kept / errors | - | 24 / 12 / 1 / 0 |

Kept deal: give P303 (team 1's spare WR), get P307 (team 2's spare RB).
me ppg_delta 0.0, them 0.0. Title delta me **+0.1450** (SE 0.0122), them
**+0.2208** (SE 0.0150); both past 2 SE. Equal to `tradeImpact` called directly
(asserted in the test).

Not measured: cost on a synced league (none in the cloud clone). RL-19-2 put a
full two-run tradeImpact at ~4-6 s there; the stage pays one world build plus
at most 12 two-lineup rescores per uncached search, only with the flag on.

## Mutation sweep (unit and call site)

Scratch script, one mutant at a time against `test/rl-19-3-title-mutual.test.js`,
source restored after each.

| Mutant | Where | Result |
|---|---|---|
| M1 `&&` -> `\|\|` in the both-sides rule | title-mutual.js `mutualTitleGain` | killed (test 3) |
| M2 noise clause removed | title-mutual.js `mutualTitleGain` | survived the first sweep; killed after the pinned-predicate test (test 7) |
| M3 `requireMutual` dropped from the pool guard | trade-engine.js call site | killed (test 5) |
| M4 `!teamsOverride` dropped from the pool guard | trade-engine.js call site | killed (test 6) |
| M5 gate-dropped 1-for-1s never pooled | trade-engine.js call site | killed (tests 3, 4) |
| M6 preview mode ignored | title-mutual.js `titleMutualMode` | killed (test 4) |
| M7 `give.length === 1` -> `=== 2` | title-mutual.js `titleCandidate` | killed (tests 3, 4) |
| C1 designed survivor: budget 12 -> 13 | title-mutual.js | survived (the swap is inside either budget) |
| C2 designed not-applied: absent string | title-mutual.js | not applied |

## Nick's five questions

1. **Well built?** One new module (~130 lines). The points gate in
   trade-engine.js (`me.ppg_delta < 0.4`) and the points-mutual list are
   unchanged. The class is a separate block on the response, never merged into
   `deals`. Failures show up (`status: 'failed'` + error, `errors` count). No new catch.
2. **Stats or made up?** Stats: title deltas and SEs are season-sim.js
   `tradeImpact` (paired seeds, 1,200 runs, fast-rescore world). Hand-set, guess:
   the shortlist budget (12) and its order (least-bad joint lineup change first).
3. **How we know:** one fixture league (above). No backtest. Nothing records
   which title-mutual deals were offered or accepted.
4. **Pointed elsewhere?** `/trades/:id/find` passes the whole result through
   (routes/trades.js `r.get('/:leagueId/find'`), TradeLab renders the block,
   TradeCard adds the badge. The Title-impact tab (title-odds-trades.js) now reads
   `mutualTitleGain` from title-mutual.js: same rule, one definition.
   findTradeSequences and the plan do not read `title_mutual`.
5. **How it unifies:** same `tradeImpact` seed, run count and noise rule as
   TradeCard, the sense-check and the Title-impact tab. A deal shows the same
   title delta everywhere.

- Gap fixed: trade-engine.js `if (ev.me.ppg_delta < 0.4) continue;` (origin/main
  `d861c11`) dropped every such 1-for-1 without a trace.
- Incumbent: none. `grep -rn title_mutual server client/src` on `d861c11` returns nothing.
- Not covered: 2-for-1 and 2-for-2 packages; requireMutual=false; the sequences
  planner; the per-league goal setting (title vs make-the-playoffs, ruling 2026-09-23).
- What would make it wrong: the season sim's projections disagreeing with the
  finder's week rate because the sim is wrong, not the finder; a budget of 12
  cutting off the real title-mutual deal in a 10-team league.
