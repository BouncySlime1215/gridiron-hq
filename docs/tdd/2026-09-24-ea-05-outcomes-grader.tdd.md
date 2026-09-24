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
