# RL-5-3: zero a bye-week starter's weekly floor/ceiling/avg

Unit: RL-5-3 (plan item C19, uncertainty UI). Not a statistical unit — a deterministic
bug fix (an already-known bye is applied where it wasn't), so no pre-registration, no
2025 holdout look, no forward-holdout grade. "Not applicable" for those sections.

## 1. Audit: what already exists

`buildAssetUniverse()` (`server/services/trade-engine.js:291`) zeros `current_week_ppg`
for a bye-week starter (`:359`, `currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult * activeProbability : 0`
— `thisGame` is the bye detector: `sched.games?.find(g => g.week === target.week) ?? null`).
It did **not** zero `weekDist` (`:423-425` before this change, the Monte-Carlo draw the
served `floor`/`ceiling`/`avg` come from at `:437` before this change) or the
`WEEK_MARGINAL` symbol `lineupSpread()` reads per starter (`:431-434` before this
change, via `spreadInput()` at `:788`). Both consumers of these fields — MyTeam's
"Weekly range" (`selfScout()` → `lineupSpread()`, `:2513`) and every trade card's
`floor_delta`/`ceiling_delta` (`evaluate()` → `lineupSpread()`, `:1109-1110`) — read the
same asset objects out of `assetUniverse()`, so this is the one producer for both (see
"One number, one producer" below).

Full measurement already exists and is not repeated here: `rnd/loop/r5-internal-weekly-range-counts-bye-players.md`
(R&D, 2026-09-23) — 59 of 61 W6-bye assets with a `ros_ppg` had `ceiling > 0` while
`current_week_ppg = 0` (real local-copy data, read-only), and 20 of 45 W5-W14
league-weeks on today's rosters started a bye player in the shown MyTeam range
(overstatement mean median 16.1, max 43.9). That document also names the four other
producers that already zero a bye correctly (`season-sim.js:238`, `lineup-brain.js:348`,
`trade-engine.js:2672,2972`), confirming this brings the two outliers into line with the
existing convention rather than introducing a new one.

**Extend, not build**: the fix reuses the existing `thisGame` bye detector and the
existing `WEEK_MARGINAL`/`spreadInput()` mechanism (`activeProbability` already zeroes a
starter's contribution there — no new field, no new code path).

## 2. Pre-registration

Not applicable — deterministic defect fix (a known-zero week is applied where a
generic distribution was leaking through), not a model or a new number.

## 3. RED

Commit `73fe56f0` — `test: RED — bye-week starter's weekly range must be zero`
(`test/asset-universe-bye-week-range.test.js`).

Failing assertion, run on `73fe56f0` (unfixed `trade-engine.js`, tree = the merge base
`89f69b3b` plus only the RED test):

```
not ok 3 - RED: a bye-week starter's floor/ceiling/avg must be zero, not the full distribution
  error: |-
    bye-week floor must be 0, got 8
    8 !== 0
```

Fixture: two players, identical mocked weekly projection/distribution
(`player-week-engine.js` mocked — the structural/ensemble build is untouched by this
defect; only how `trade-engine.js` uses a projection once it has one). Player 901's team
has a real `schedule_games` bye at week 6 (no row for week 6, rows for every other week
1-14); player 902's team plays week 6. `NFL_WEEK=6`. Two passing controls in the same
run prove the fixture is live, not vacuous: (1) `buildPlayerWeekEngine` was actually
called, and (2) the non-bye player correctly keeps a positive `current_week_ppg` and the
full mocked floor/ceiling/avg (8/32/20) — so a 0/0/0 result on the bye player is not an
artifact of a broken fixture.

## 4. GREEN

Commit (this push) — `fix: zero a bye-week starter's weekly floor/ceiling/avg (RL-5-3)`.

`server/services/trade-engine.js`:
- New `onBye = hasSchedule && !thisGame` (same predicate shape as the existing
  `currentWeekPpg` bye branch).
- `weekDist` is not sampled at all on a bye (`weekProjection && !onBye`).
- `WEEK_MARGINAL.activeProbability` is `0` on a bye — `spreadInput()` (`:788`) already
  multiplies both the mean and the variance it derives by `activeProbability`, so this
  alone zeroes a bye starter's contribution to `lineupSpread()`'s lineup-total floor and
  ceiling (MyTeam's range and every trade card's `floor_delta`/`ceiling_delta`).
- The served `floor`/`ceiling`/`avg` fields are explicitly `0` on a bye, not left to fall
  through `weekDist?.p10 ?? w?.floor ?? null` — `w` is `volatility()`'s multi-season
  table (`routes/edge.js`), a different week entirely, and was the second, independent
  leak the R&D doc called out (setting `weekDist = null` alone is not enough).

Targeted tests, on this tree:
```
SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/asset-universe-bye-week-range.test.js
# pass 3, fail 0
SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/lineup-spread.test.js test/asset-universe-fingerprint.test.js test/asset-cache-stamps.test.js test/trade-engine-correctness.test.js
# pass 30 (5 + 5 + 5 + 15), fail 0 — no regression in the existing floor/ceiling, cache-fingerprint or ladder-gate suites
```

## 5. Mutation sweep

Run against the GREEN tree, each mutant applied, `asset-universe-bye-week-range.test.js`
re-run, then reverted (`git diff` clean before and after — verified below).

| Mutant | Change | Result |
|---|---|---|
| A — not-applied control | `onBye = hasSchedule && !thisGame` → `onBye = false` | **Killed**: test 3 fails (`bye-week floor must be 0, got 8`) |
| B — call-site | Only the `floor` field's gate reverted: `floor: onBye ? 0 : …` → `floor: false ? 0 : …` (ceiling/avg still gated) | **Killed**: test 3 fails on the floor assertion |
| C — designed surviving control | Unrelated field, `trend30: m?.trend30 ?? null` → `trend30: null` | **Survives** (by design): all 3 tests still pass — this test file is scoped to the bye-week range, not every field `buildAssetUniverse` emits |

`git diff --stat` after reverting all three mutants: empty (tree restored to the GREEN
commit exactly).

## 6. What it does / does not cover

- Covers: MyTeam's "Weekly range" (via `selfScout` → `lineupSpread`) and every trade
  card's weekly floor/ceiling delta (via `evaluate` → `lineupSpread`) — both read the
  same `assetUniverse()` objects this fix changes. One producer, both consumers fixed.
- Does **not** cover the separate defect named in `WORK-QUEUE.md` row RL-5-3 and
  `r5-internal-weekly-range-counts-bye-players.md` step 2: `selfScout`'s optimal-lineup
  *solve* still runs on `adj_ppg` (a season rate), so a bye starter can still be picked
  as a "starter" in the lineup the range is computed over (he now just contributes 0 to
  that lineup's range instead of a positive number). The task text scoping this unit
  named only "zero them" for the weekly range/trade floor-ceiling; benching a bye starter
  from the optimal lineup itself is a distinct change (`:2510`, matching `horizonGain`'s
  `solve()` bye filter at `:1109-1110`) and is not made here — flagged as a follow-up,
  not silently dropped.
- Would be wrong if: a league's bye week is mis-synced in `schedule_games` (this reads
  the same table `horizonGain`/`season-sim.js` already trust); or if a player has
  `team_abbr` but `SCORED` doesn't include his position (K/DEF), in which case
  `hasSchedule` is `false` and he is treated as "unknown," not "bye" — matching the
  documented behavior of every other bye-aware producer in this file.

## Nick's five questions

1. **Well built?** Yes for the scope stated (weekly range/trade floor-ceiling zeroing):
   RED/GREEN/mutation sweep with two killed mutants and one designed survivor, plus the
   full existing floor/ceiling/cache-fingerprint/ladder-gate suites re-run clean.
2. **Stats or made up?** Neither — it's a bug fix applying an already-known fact (the
   schedule says no game this week) to two fields that were ignoring it. No new model,
   no new number.
3. **How we know:** the RED test's failing assertion on the unfixed code, plus the
   independent production measurement already on file
   (`rnd/loop/r5-internal-weekly-range-counts-bye-players.md`: 59/61 W6-bye assets
   overstated, 20/45 W5-W14 league-weeks affected on today's rosters).
4. **Pointed anywhere else on the platform?** Yes, by construction: `assetUniverse()`
   is the one producer `loadRosters()` feeds to both MyTeam (`selfScout`) and Trade Lab
   (`evaluate`/`findTrades`) — see the audit section above.
5. **How it unifies:** brings the two outlier code paths in line with the four existing
   places that already zero a bye (`season-sim.js`, `lineup-brain.js`,
   `trade-engine.js:2672,2972`), using the same `thisGame`/`hasSchedule` predicate
   `currentWeekPpg` already uses at `:359`. No new convention introduced.
