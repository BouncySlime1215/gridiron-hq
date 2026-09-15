# Stage 1 baseline freeze

**Frozen at commit `2448753213245735a2c3070e5b0351cebb2a08b4`, 2026-09-15.** This is the
reference point required by `docs/CLAUDE-NEXT-STEPS.md` §0.0/Stage 1: "Freeze the
baseline code/configuration and historical comparison results before changing model
behavior." Everything below describes what existed at this commit, before any Stage 2+
work (shared training data, a trained candidate, wiring it into serving) begins.

**Rule for using this file:** it is never edited after today. A later comparison gets a
new dated file under `docs/evidence/<date>/` that references this one; this file's own
numbers do not change to reflect later reality, the same discipline `docs/CLAUDE-NEXT-STEPS.md`
§1.2 already applies to the run 27/32 historical record.

## 1. What "the model" currently is, in production

Per `docs/CLAUDE-NEXT-STEPS.md` §2.1 (verified against `server/services/nfl-ensemble.js`
at this commit, not re-derived here): the default board is

```
nfl-auto-picks.js → ensembleWeek with market_residual
  → conditional online-neural substitution if eligible
  → cover calibration → applyNflPolicy → nfl-execution-pipeline.js
  → decision tape and execution ledger
```

`market_residual` blend mode means every registered component is scored as a
correction to the market line, not as an independent forecast — the market is the
floor, not one voice among many. This has not changed at this commit.

## 2. The NFL spread promotion gate, exact configuration

`server/services/nfl-research.js`'s `nflOperations()` is the live promotion-readiness
check for `nfl-ensemble-v1` (sport=NFL, market=spread). At this commit it evaluates
**nine** gates:

| id | label | pass condition |
|---|---|---|
| `market_residual_margin` | Adds unseen value beyond market margin | `residual.summary.residual_margin_mae < residual.summary.market_margin_mae` |
| `cover_calibration` | Calibrated cover probability beats market | `calibration.metrics.forward_gate_passed === true` |
| `exact_policy` | Frozen exact policy has credible positive ROI | `overall.roi > 0 && P(ROI>0) >= 0.75` |
| `forward_sample` | Forward evidence sample | `forwardSettled.length >= FORWARD_SAMPLE_TARGETS.overall` |
| `quote_provenance` | Decision-time quote provenance preserved | `preservedHistoricalQuotes >= 1000` |
| `untouched_holdout` | Untouched forward holdout is mature | `dataEvidence.firewall.untouched_gate_passed` |
| `clv` | Closing-line value available and positive | `clv.available === true && clv.average_clv > 0` |
| `pregame_coverage` | Current team snapshot coverage | `pregame[0].teams >= 32` |
| `overfitting_correction` (added 2026-09-14) | Best observed edge survives correction for repeated live looks | `≥ 8 live trials AND deflatedSharpeRatio ≥ 0.95`, computed from `research_trials` kind `nfl_operations_sharpe` |

Promotion (`promoteEligibleAudit` in `model-governance.js`) requires **every** gate to
pass. As of this commit, `overfitting_correction` fails closed by construction (zero
live trials registered yet) and this file makes no claim about the other eight without
a run against the real database — see `docs/CLAUDE-NEXT-STEPS.md` §0.0's open item on
re-verifying real-data status. **Nothing in the NFL spread market is `promotion_eligible`
at this commit; the historical evidence (§4 below) plus this project's own admission
in `docs/CLAUDE-NEXT-STEPS.md` §1.2 that "nothing is qualified" both hold.**

## 3. Registry defaults at this commit

From `server/services/model-governance.js`'s `seedRegistry()` (the literal seeded
defaults; live installations may have moved past these via `updateRegistry`, which this
static file cannot observe without the real database):

| Sport | Market | Role | Model version | State |
|---|---|---|---|---|
| NFL | spread | champion | market-consensus-v1 | baseline |
| NFL | spread | challenger | nfl-ensemble-v1 | research_only |
| NFL | total | champion | market-consensus-v1 | baseline |
| NFL | total | challenger | nfl-total-ensemble-v1 | blocked |
| NFL | player_props | champion | shared-event-structural-v1 | baseline |
| NFL | player_props | challenger | player-head-registry-v1 | research_only |
| NFL | fantasy_weekly | champion | structural-ensemble-v1 | baseline |
| NFL | fantasy_weekly | challenger | qbr-augmented-structural-v1 | research_only |
| MLB | nrfi | challenger | mlb-nrfi-v2-cutoff | blocked |
| MLB | pitcher_strikeouts | challenger | mlb-k-v2-cutoff | blocked |
| MLB | batter_total_bases | challenger | mlb-tb-v2-cutoff | blocked |

No sport/market has a champion role held by anything other than a market-consensus or
structural (non-learned) baseline. This is the "nothing has beaten the market yet"
fact in table form.

## 4. Historical comparison record (preserved, not re-derived)

Already frozen in `docs/CLAUDE-NEXT-STEPS.md` §1.2 and reproduced verbatim here so this
one file is a complete snapshot:

| Evidence | Result |
|---|---|
| Historical audit 27, spreads | 153 bets; 72W/78L/3P; ≈ −11.8549 units; −7.7483% ROI |
| Historical audit 32, spreads | 156 bets; 74W/79L/3P; −11.0884001705 units; −7.1079488272% ROI |
| Audit 32 coverage | 70 weeks, weeks 5–18 across its five-season cohort |
| Family-contribution baseline (1,424 games) | MAE ≈ 10.095 vs. market 9.762; 204 bets; ≈ −5.10% ROI |

These numbers are negative-ROI development results. Stage 2+ must not present a future
improvement as beating "zero," it must beat *these specific* frozen numbers under a
comparable eligible-game universe, or explain exactly why the universe changed.

## 5. Fixes landed in this Stage 1 pass (for the record, not part of the frozen baseline itself)

Commits `c84520c`, `9764f6b`, `b80853c`, `2448753` on `claude/relaxed-ramanujan-o3nh5i`:
season-window defaults extended to include 2026 in two live monitors and 13 sync/backfill
functions; the `overfitting_correction` gate added to `nflOperations()`; one ticking-
time-bomb test date fixed. None of these changed prediction logic, model weights, or
betting decisions — they are data-freshness and safeguard-wiring fixes, which is why
they were made *before* this freeze rather than being blocked by it. Anything that
would change what the model predicts or how a bet is decided, from here forward, is
Stage 2+ work and must be measured against this file.
