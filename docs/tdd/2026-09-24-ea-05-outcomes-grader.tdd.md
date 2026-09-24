# TDD record: EA-05 outcomes as events + the grader

Row: ENGINE-SPECS.md "outcomes as events + the grader" (listed there as **EA-04**; dispatched as cloud
unit **EA-05**; see Flag in the PR). Architecture: ENGINE-ARCHITECTURE.md §7.1-7.3, D9, §3.7.
Base: PR #242 head `75785e2` (branch `claude/cloud-ea-02-dw26pg`).

## RED

`8daa13a4` "test: RED - outcomes as events and the grader (EA-05)": 13 of 13 fail on `75785e2`, e.g.

> `'adapters/outcomes.js does not exist: outcomes-as-events and the grader are not built'`
> `'grade/scorers.js does not exist: outcomes-as-events and the grader are not built'`

The final test file (after the fixture fixes below) was re-run against a clean worktree of `75785e2`:
**0 pass, 13 fail**.

Test changes between RED and GREEN, each a test fault, not a behaviour change:
- A1 fixture points: 2 receptions + 20 yards is 4.0 PPR / 3.0 half-PPR, not 22/21.
- A2 fixture: a `not_proposed` trade_outcomes row needs `not_proposed_reason` (067 CHECK).
- A1/A2 clock: the spine clamps a future `as_of` to the ingest clock (events.js), so the fixture now
  ingests at 2026-09-15, after the game and the offer; A1 now also asserts the outcome's `as_of`.
- RED (2) passed vacuously on the bare base (`!f`); it now requires the grade row and
  `excluded.version_after_decision === 29`.
- A1 gained "stat_version is in the natural key" after mutant M10 (below) was first designed.

## GREEN

`6e0ba90a` "feat: outcomes as events and the grader producer (EA-05)": 13 of 13 pass, 5 runs in a row.
`engine-daemon` + `engine-spine` + `engine-grader`: 56 of 56.

One implementation change came from RED (3): the `outcomes` cursor re-read only the latest
`season*100+week`, so a correction to week 3 once week-4 rows existed waited for the daily sweep. It
now re-reads the latest two weeks (`daemon/cursors.js` CURSOR_SPECS.outcomes).

## Mutation sweep (on `6e0ba90a`)

Each mutant applied alone, `node --test test/engine-grader.test.js`, then restored.

| # | mutant | file | result |
|---|---|---|---|
| M1 | in-force cut dropped (`written_at <= T` removed) | producers/grader.js | killed: RED (1), (6), (8) |
| M2 | version registration check dropped | producers/grader.js | killed: RED (2) |
| M3 | earliest outcome instead of latest | producers/grader.js | killed: RED (3) |
| M4 | pinball loses its indicator | grade/scorers.js | killed: RED (4), (6) |
| M5 | DECISION_SCORER a wrapper, not gradeDecisions | grade/scorers.js | killed: RED (5) |
| M6 | shadow lane skipped | producers/grader.js | killed: RED (6) |
| M7 | PIT a step, not linear between quantiles | grade/scorers.js | killed: RED (7) |
| M8 | floor counts rows, not week clusters | grade/scorers.js | killed: RED (8) |
| M9 | 2025 holdout opened | producers/grader.js | killed: H1 |
| M10 | stat_version out of the natural key | adapters/outcomes.js | killed: A1 |
| M11 | call site: cursor re-reads one week (`Number(wm) - 1` -> `Number(wm)`) | daemon/cursors.js | killed: RED (3) |
| M12 | snapshot "in force" ignores time | adapters/rec.js | killed: A2 |
| M13 | finals filter dropped | adapters/outcomes.js | killed: A1 |
| C1 | designed survivor: a comment edit | producers/grader.js | survived (as designed) |
| C2 | designed not-applied: a string not in the file | producers/grader.js | not applied (as designed) |

## Nick's five questions

1. **Well built?** 13 RED->GREEN tests, 13 of 13 mutants killed with both controls behaving. It
   grades nothing served today: no producer on this branch writes a `dist` or `prob` field yet.
2. **Stats or made up?** Standard proper scores: pinball quantile score (CRPS approximation named as
   such), log loss, Brier, logistic calibration, KS on PIT. Hand-set constants: floor 4 weeks / 20
   players (architecture §7.2), 400-day outcome lookback, the 2025 holdout, `forward` from 2026.
3. **How we know:** fixtures and closed forms (pinball by hand; KS p > 0.05 on a calibrated normal
   fixture, p < 0.05 on a too-narrow one). No backtest applies: it grades, it ships no number.
4. **Pointed anywhere else?** No route or page reads `grade.*`. The daemon now runs the grader as a
   fourth producer and ingests three new streams.
5. **How it unifies:** one grader and one decision time per field for every producer and both lanes,
   so a later monitor (EA-05 in ENGINE-SPECS numbering), promotion check and EVAL-01 all read the same
   `grade.*` rows instead of each re-scoring.

---

## Review fixes (2026-09-24): FIX-259-1, -2, -3

Base: merge of `origin/main` into this branch (`7e153982`), then `npm ci`.

**Merge fallout.** `045c363b`: #174 is now on main, so migration 071 creates `rec_ledger`. A2's
"table_absent" check and its own `CREATE TABLE` collided with it (1 failure on the merged tree).
The test now asserts the table is present and empty; the adapter is unchanged.

**FIX-259-1 (wiring).** Before the merge, `npm run check:wiring` exited 1 with 4 blocking
`module-reaches-no-surface` findings (adapters/outcomes.js, adapters/rec.js, grade/scorers.js,
producers/grader.js). Main already treats `scripts/engine-daemon.mjs` as a `process` surface
(`scripts/wiring-map.mjs` `PROCESS_ROOTS`, from FIX-279-1 through #272). After the merge the check
exits 0 with no change on this branch. The new modules and scripts add no findings.

### RED

`da893c87` "test: RED - EA-04 adapters, decision vs luck, promotion check (#259)": 10 new tests,
**13 pass, 10 fail** in `test/engine-grader.test.js`. Every failure is a missing module or row, e.g.

> `'adapters/league.js does not exist: outcomes-as-events and the grader are not built'`
> `'a grade.decision_luck row for offers'`
> `'graded field fx.win: a prob field needs truth(payload)'`

| test | checks |
|---|---|
| A4 | league.settings: one event per league per change, format key + scoring key + trade rules, no name or cookies; a later change is a new event |
| A5 | league.matchup_result: one event per matchup, no bye, nothing from an unfinished week, as_of = week end, decision_time = first kickoff; a score correction is a new event |
| A6 | market.player_value: one event per (format, player) per value change; a refetch of the same value appends nothing |
| D1 | offer decision uses the settings and values in force at proposed_at: a 09-14 format change and a 09-14 value are never used; a player first valued after T excludes the offer (`no_value_in_force`) |
| D2 | rec decision is the first logged forecast; a hindsight rewrite of predicted_json is never used; luck = realised - decision; PIT from the delta distribution |
| D3 | a matchup probability written after the first kickoff is never graded; log loss matches the closed form |
| P1 | promotionVerdict refuses on floor, interval touching 0, wrong direction, different outcomes, non-forward rows, missing comparison, missing active |
| P2 | `check-promotion.mjs` on the fixture's fx_range (one Sunday, shadow worse) exits 1 |
| P3 | a shadow better over 4 weeks x 25 players has `vs_incumbent.interval.hi < 0`; the script exits 0 |
| P4 | `engine-grade-report.mjs` prints grade.season_to_date per producer@version; `--producer` filters |

Test fixes between RED and GREEN (test faults, not behaviour changes): D1's `trade_outcomes` row
needed the 067 CHECK's `model_p_accept`; D1 ticks at 15:00, because a grader row's key includes the
tick's as_of and the reused 12:00 was an idempotent no-op; D2's PIT tolerance is 1e-6 (items are
stored to 6 dp). `test/engine-daemon.test.js` pins grader `ea05-2`.

### GREEN

`d48b00fb` "feat: EA-04 league/market adapters, decision vs luck, promotion check (#259)":
`engine-grader` **23 of 23**. `engine-*` tests: **66 of 66**. Full `npm test`: 5278 tests,
5236 pass, **0 fail**, 42 skipped (~12.7 min).

The promotion rule implemented (ENGINE-ARCHITECTURE §6.3 (1), with §7.2's floors and §6.7): both
rows present, same `outcomes_hash`, shadow floor met in clusters (>= 4 weeks, >= 20 entities), every
graded row `forward`, and the paired interval (shadow minus active, per week, lower is better) with
upper bound < 0. §6.3 (2) BENCHMARKS and (3) prereg order are not `grade.*` fields and are not checked
here; (4) the training window is enforced by the grader's exclusion. The interval is a normal-mixture
confidence sequence with a plug-in sd (`grade/compare.js`, named in the row); the §7.4 monitor
e-process (ENGINE-SPECS EA-05) replaces it when built.

### Mutation sweep (on `d48b00fb`)

| # | mutant | file | result |
|---|---|---|---|
| M14 | `inForceAt` ignores T | grade/decision-luck.js | killed: D1 |
| M15 | rec forecast = latest version, not first | grade/decision-luck.js | killed: D2 |
| M16 | matchup final-week filter dropped | adapters/league.js | killed: A5 |
| M17 | promotion checks lower bound, not upper | scripts/check-promotion.mjs | killed: P1 |
| M18 | fetched_at in the market payload | adapters/market.js | killed: A6, D1 |
| M19 | in-force cut dropped | producers/grader.js | killed: RED (1), (6), (8), D3, P4 |
| M20 | paired delta sign flipped | grade/compare.js | killed: P3 |
