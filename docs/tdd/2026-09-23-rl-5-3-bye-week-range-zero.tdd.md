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

- Covers (after round 2, section 7): MyTeam's "Weekly range" and the rank beside it
  (`selfScout`), and every trade card's `floor_delta`/`ceiling_delta` (`evaluate`), all
  solved over THIS week's lineup (`weekLineup`), in which a bye starter is benched and
  the next player who plays fills the slot.
- Mutant B above was **not** a call-site mutant for the consumer: for a player with a
  weekly model, `lineupSpread()` → `spreadInput()` reads `WEEK_MARGINAL.activeProbability`,
  not the served floor. And the round-1 fixture's `params: { mean: 20 }` sampled to 0
  for every player, so that path could not be seen. Round 2 fixes the fixture and kills
  that mutant (M1, section 7).
- Would be wrong if: a league's bye week is mis-synced in `schedule_games` (this reads
  the same table `horizonGain`/`season-sim.js` already trust); or if a player has
  `team_abbr` but `SCORED` doesn't include his position (K/DEF), in which case
  `hasSchedule` is `false` and he is treated as "unknown," not "bye" — matching the
  documented behavior of every other bye-aware producer in this file.

## Nick's five questions

1. **Well built?** Yes, for the full queue row after round 2: zeroed range, a bye
   starter benched in selfScout, and bye-aware weekly range on trade cards. 7-test
   RED/GREEN, 4 call-site mutants killed plus 1 designed survivor (section 7), and 5
   existing suites re-run clean.
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

## 7. Round 2 (skeptic fixes)

Tree: branch `claude/local-rl-5-3-bye-week-range-zero`. RED commit `1a03db85` (tests
only, code = `677b4727`), GREEN commit `b1d201f3`.

What changed:
- `buildAssetUniverse` adds `bye_this_week: onBye` to the asset (the same detector as
  `current_week_ppg`). `slim()` passes it through, so the self-scout / trade JSON shows it.
- New `weekLineup(players, slots, key)` in trade-engine.js: `bestLineup` over players
  with `!bye_this_week`, with bye players added back to `bench`. It is exactly
  `bestLineup` when no one is on bye.
- `selfScout`: `lineup`, every rival's `line`, and the depth test (`ifOut`) use
  `weekLineup`. So the range, the rank (`myRank`), the position strengths and the depth
  test all describe one lineup. The bye-collision warnings (`byeRisk`, `playoffByes`) stay
  on a season `bestLineup`, because this week's lineup has already benched the players
  they warn about.
- `evaluate()`: the lazy `floor_delta`/`ceiling_delta` compute `lineupSpread` over
  `weekLineup` only when a roster has a bye player. Otherwise they reuse the same
  lineups, with no extra solve. `ppg_delta` and the verdict stay on season lineups.
- Test fixture: real WR params (copied from `test/lineup-spread.test.js`), plus 903 (a
  bye-team star whose season rate beats everyone) and 904 (a low-volume WR who plays).

RED on code `677b4727` (commit `1a03db85`):
```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/asset-universe-bye-week-range.test.js
ok 1-5 (controls, field test, lineupSpread test)
not ok 6 - RED: selfScout must not start a bye-week player; he stays on the bench
    the WR slot must go to the player who plays, got Bye Star
not ok 7 - RED: a trade that fills a bye hole this week gets weekly-range credit on the card
  error: 'adding a WR who plays this week over a depth WR must raise my weekly ceiling, got 0'
# pass 5  # fail 2
```
GREEN on `b1d201f3`: same command, `# pass 7 # fail 0`.

Mutation sweep on the GREEN tree. Each mutant was applied with sed, the file above was
re-run, and the file was restored from a copy. `git diff --stat` was empty afterwards.

| Mutant | Change | Result |
|---|---|---|
| M1 (skeptic's) | `activeProbability: onBye ? 0 : activeProbability, mult` → `activeProbability, mult` | **Killed**: test 4, `bye lineup mean must be 0, got 13.6` |
| M2 selfScout call site | `const lineup = weekLineup(me.players, slots)` → `bestLineup(...)` | **Killed**: test 6 |
| M3 evaluate call site | `weekOf = (line, players) => line` | **Killed**: test 7 |
| M4 producer | `bye_this_week: onBye` → `bye_this_week: false` | **Killed**: tests 6 and 7 |
| M5 designed survivor | `trend30: m?.trend30 ?? null` → `trend30: 999` | Survives (7 pass), as designed |

No regression on the same tree. Each file was run on its own with its own mktemp DB:
lineup-spread 5/5, asset-universe-fingerprint 5/5, asset-cache-stamps 5/5,
trade-engine-correctness 15/15, post-draft-plan 5/5 (post-draft-plan checks that
`post-draft-plan.lineup` deep-equals `self_scout.lineup`, and it still passes).

One number, one producer. Two lineup solvers still exist for "this week":
- `selfScout` / `evaluate` rank on `adj_ppg` (0.25 × this week + 0.75 × ROS).
- Start/Sit ranks on `week_points` (`lineup-posture.js:284`, `bestLineup(mine, slots, 'week_points')`).

Both now bench a bye player. They can still pick different non-bye starters, because
the keys differ. This is code-derived and was not measured: the local data is at W3,
which has no byes. Unifying the key is outside this row, which asks only for the bye
filter. Follow-up: have selfScout's weekly range reuse the Start/Sit lineup; this needs
a new WORK-QUEUE ID.
