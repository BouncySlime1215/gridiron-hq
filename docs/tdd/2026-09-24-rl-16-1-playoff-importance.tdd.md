# RL-16-1: measured playoff-week weight for 10-team / 6-playoff leagues

Unit RL-16-1, the coordinator-corrected row (WORK-QUEUE.md, the RL-16-1 correction row that supersedes
row 902's numbers; branch `claude/handoff-package-2026-09-22`). Built on origin/main `d861c11`.

## 1. Defect

- `server/services/trade-horizon.js:36` (d861c11): `PLAYOFF_IMPORTANCE = 4`, doc-commented "Published
  finals-to-advance exchange rate". It is ETR's best-ball 4:1 figure (docs/WHAT-WINS-STUDY.md:26), which
  prices a change in a best-ball team's finals **win rate** against its advance rate. It is not a measured
  weight for a managed H2H playoff week. Header comment `:11-16` presented it as that; `:123` credited the
  weighting to horizonGain, which never applies it (it only reads `weights`).
- `:88`: `playoffMass = playoffLeft * PLAYOFF_IMPORTANCE * odds`, served in every trade grade through
  `trade-engine.js` (three `horizonWeights` call sites, `:1496`, `:1847`, `:2393` on d861c11).

## 2. The value, and where it comes from

Validator r16 (as recorded in the corrected WORK-QUEUE row and PLAN-V9-CORRECTIONS.md): 579 Sleeper leagues,
weight measured per team by standing. Rank 4-6 in 10/6 leagues: **5.13 [4.28, 6.34]**; rank 1-3: 5.67. The
pooled 6.70 is pulled up by non-contenders and is not used; nor is the pre-registered 3.82. This unit did
**not** re-run the measurement; the number is cited from the validator, not reproduced here.

5.13 chosen over "about 5.2" because it is the point estimate of the group the row names (rank 4-6) and
it is exactly what the RED target 0.536 implies: at week 7, odds 0.6, 8 regular + 3 playoff weeks left,
0.536 = 3·0.6·k / (8 + 3·0.6·k) gives k = 5.13. At 5.2 the share is 0.539, also inside ±0.02.

## 3. Change

- `playoffImportance({ teams, playoffTeams })`: 5.13 `measured: true` only when `GRIDIRON_RL16_1_ENABLED=1`
  or preview mode is on AND the league is 10 teams / 6 playoff teams. 12/6, 8/4 and any shape the
  platform did not report: 4, `measured: false`, source string says "unmeasured".
- `leagueShape(lg)`: team count from `payload.teams`, playoff teams from `leagueRules(lg).schedule`.
  Nulls when unknown (non-ESPN, unparseable, missing).
- `horizonWeights` takes `teams`, `playoffTeams`; with the switch on it adds `playoff_importance`,
  `playoff_importance_measured`, `playoff_importance_source` (+ `preview`, `preview_reason` when on only by
  preview). **Switch off: output is byte-identical to d861c11** (pinned by test 3).
- All three trade-engine call sites pass `...leagueShape(lg)`.

## 4. RED / GREEN

- **RED** `006ed01` `test: RL-16-1 RED, measured contender playoff-week weight for 10/6 leagues`. Stubs
  returned 4 / null shape. 4 of 5 fail; the acceptance assertion:
  `not ok 1 - RL-16-1 RED: 10/6 league, week 7, odds 0.6 -> playoff share about 0.536 with the flag on`
  `error: 'playoff share 0.474, want 0.536 +- 0.02'`. Test 3 (the 0.474 regression pin) passes, as designed.
- **GREEN** `99973a4` `feat: RL-16-1 GREEN, measured 5.13 playoff-week weight for 10/6 leagues behind a flag`.
  `test/trade-horizon.test.js` 5/5, `test/trade-engine-correctness.test.js` 16/16.

## 5. Mutation sweep (on 99973a4)

| Mutant | Killed by |
|---|---|
| Call site `trade-engine.js:1847` drops `...leagueShape(lg)` | engine test "passes this league's shape" (source reads `?-team/?-playoff`) |
| Constant 5.13 -> pooled 6.70 | tests 1, 2 (share 0.587) |
| Shape gate removed (every league gets 5.13) | test 4 |
| Preview mode ignored | test 2 |
| New fields emitted with switch off | test 3 |
| **Designed control** 5.13 -> 5.2 | share 0.539 survives the ±0.02 band; dies only on the exact `playoff_importance` equality |
| **Not-applied control** switch off, any shape | test 3 passes on both RED and GREEN trees (0.474) |

Call sites `:1496` and `:2393` are not separately mutated; they share `:1847`'s argument shape.

## 6. Nick's five questions

1. **Well built?** One producer (`playoffImportance`), one reader of the switch, default off, served output
   unchanged with it off; preview-mode contract followed (`preview-mode.js` site list updated).
2. **Stats or made up?** Stats for 10/6 (validator r16). 4 remains made up (borrowed best-ball rate) and
   is now labelled so for every other shape.
3. **How we know:** cross-league measurement on 579 Sleeper leagues, rank 4-6, CI [4.28, 6.34]. Not a
   forward backtest of trade outcomes; not reproduced in this unit.
4. **Pointed elsewhere?** Only through `horizonWeights` -> trade-engine horizon (trade ideas, a single
   trade's evaluation, the weeks-left weight at `:1496`). No other reader of `PLAYOFF_IMPORTANCE`
   (`grep -rn PLAYOFF_IMPORTANCE server client/src`).
5. **Unifies:** interim proxy; CE-09 per-team title odds replace the whole importance x odds term. The
   lesson carried forward: weights differ by standing, so CE-09 must be per-team, not pooled.

- **Not covered:** 12/6, 8/4 and other shapes (unmeasured); rank 1-3 teams get 5.13 not 5.67 (one value per
  shape, not per standing); non-ESPN leagues (shape unknown -> 4).
- **What would make it wrong:** Sleeper leagues not transferring to ESPN 10/6 leagues; the validator's
  rank grouping not matching a team's real standing at the time of the trade.
