# Chunk 4/21 scoring — Gridiron engineer pass

Verified against /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only, grep only):
- server/services/backtest-significance.js: `alwaysValidPValue` confirmed (line 216) — N2/N3's attachment point is real.
- server/services/nfl-preseason-blend.js: `blendedTeamRating`, `weightOnPrior`, `per_game_variance`/`prior_variance` (CALIBRATED consts ~171/~39 in comments, PER_GAME_VARIANCE=181.5/PRIOR_VARIANCE=36.5 defaults), `posterior_se` computed but per file's own comments not consumed elsewhere — F1/F2/F3's claims all confirmed exact.
- server/services/nfl-team-strength.js: `teamStrengthGbmFeatures`, `teamStrengthWalkForward` confirmed — F1/F2's promotion-harness claim is real.
- server/services/player-week-engine.js: `TEAM_PASS_ATTEMPT_DISPERSION = 47` (line 50), `TEAM_RUSH_CARRY_DISPERSION = 31` (line 51) confirmed literal constants.
- server/services/projections.js: dispersion formula at line 478-480 confirmed (`Math.min(30, Math.max(1.2, ...))` method-of-moments).
- server/services/shrinkage-fit.js: `fitK`, `k = sigma2Within/sigma2Between : Infinity` fallback (line 88) confirmed.
- server/services/td-regression.js: `se = Math.sqrt(Math.max(0.5, p.expected))` (line 263) confirmed — literally the "Poisson SE" heuristic described.
- server/services/nfl-prop-player-heads.js: `CHALLENGER_HEADS`, `walkForwardChallengerTd`, `recordChallengerGateAudit` all confirmed.
- server/services/nfl-prop-correlation.js: `MARKET_STAT`, `QUOTED`, `MIN_PAIRS = 150`, `fitPropCorrelations`, `byGame` grouping, `prop_correlation_estimates` table all confirmed exact.
- research/.venv: contains pandas, scipy, sklearn, seaborn only — NO pymc, numpyro, cmdstanpy, pystan, arviz anywhere in the repo (confirmed via find for *.stan/*pymc*). F09-new-3's and F08-N2's "zero MCMC tooling" claim is accurate.
- role-changepoint.js, nfl-player-context.js, nfl-news-signal.js, gamescript.js, server/migrations/018_saved_prop_tickets.js all exist as claimed.

All 15 candidates in this chunk cite real, existing files/functions/tables (or, for genuinely new capabilities, real and correctly-named consumer surfaces). No fabricated attachment points found.

## Scores

| id | evidence | applicability | value_per_cost | verdict |
|---|---|---|---|---|
| F07-N2 | 4 | 5 | 3 | test-first |
| F07-N3 | 4 | 5 | 3 | test-first |
| F08-F1 | 4 | 5 | 2 | later |
| F08-F2 | 4 | 5 | 5 | build |
| F08-F3 | 3 | 4 | 2 | later |
| F08-N1 | 5 | 4 | 4 | test-first |
| F08-N2 | 3 | 3 | 2 | later |
| F08-N3 | 3 | 4 | 4 | test-first |
| F09-fix-1 | 5 | 5 | 3 | test-first |
| F09-fix-2 | 4 | 5 | 4 | test-first |
| F09-fix-3 | 3 | 5 | 2 | later |
| F09-new-1 | 2 | 4 | 2 | later |
| F09-new-2 | 2 | 4 | 3 | later |
| F09-new-3 | 4 | 5 | 3 | test-first |
| F10-F1 | 4 | 5 | 4 | build |

## Reasoning notes

- **F08-F2** is the standout of the chunk: hours of work, no new dependency (hand-rolled ridge solve on <=32 dims), fixes a *provable* bug (opponent-blindness — two teams with equal raw margin but different opponent strength get identical ratings today, a property directly testable and indefensible). Build now, ahead of F1's full Kalman recursion.
- **F08-F1** (full state-space filter) should wait behind F2: the candidate's own citation says the current single-differential blend already tested non-significant (MAE 9.86 vs 9.84, CI includes zero), so a much bigger days-scale rewrite is speculative until the cheap opponent-adjustment fix (F2) has been tried and measured.
- **F08-F3** (wire posterior_se into drive-sim SD) is cheap but its main cited consumer, nfl-drive-sim.js, has 6 confirmed unfixed physics bugs tonight (wrong-team turnovers, inverted kneel rule, non-decrementing timeouts, home-spread used for away win prob, flat HFA lump, no halftime/OT in season sim). Wiring a better SD into a simulator whose mechanics are still broken produces a precisely-wrong number; sequence this after the drive-sim fixes, not before.
- **F10-F1** is the other clean build: pure extension of already-shipped copula/correlation code (nfl-prop-correlation.js), no schema change, targets a real independence-assumption gap (team leg + player prop in the same game), and ships with its own CLV-based promotion gate. Directly serves "betting only through governance gates."
- **F07-N2/N3** (confidence sequences for CLV) are good governance-tooling investments — literally build the kind of honest, continuously-checkable gate Nick's standing rule calls for — but they are betting-model measurement infra, not a fantasy-edge or betting-model fix per se, so test-first rather than an unconditional build; N3 explicitly depends on N2's plumbing.
- **F09-fix-1/fix-2** are the most fantasy-relevant items in the chunk (Nick: "fantasy edge beats betting edge") and hit exact, verified lines (dispersion constants, shrinkage k). fix-1 needs a new Python dependency (pymc, currently absent from research/.venv) but produces a portable JSON-exportable table, consistent with the "Python-lab results must be portable as JSON" constraint. fix-2 reuses the existing shrinkage-fit test harness and is cheaper — score it slightly higher on value_per_cost.
- **F09-fix-3** targets the project's one genuine area of skill (2+ TD props) but the candidate's own citation notes prior challengers in this exact gating system already declined 0/3, 0/3 — real risk of repeating a known-failure pattern for a weeks-scale rewrite. Try cheaper fixes (fix-1/fix-2) first.
- **F09-new-1** cites Jensen et al.'s own negative result on player-specific dynamics as the base-rate expectation — weeks of cost chasing a result the cited literature says is unlikely to land. Low priority.
- **F09-new-2** (ZINB) has honestly-labeled weak evidence (no football-specific source), but the mechanism is sound and the engineering is cheap (gates an existing NB draw behind a Bernoulli using signals — nfl-player-context.js, nfl-news-signal.js — that already exist). Worth a quick, cheap test eventually, not urgent tonight.
- **F09-new-3** (stand up pymc/numpyro) is the correct prerequisite infra for the whole hierarchical-Bayes props direction and the "zero MCMC tooling anywhere" claim is independently confirmed. Real investment, but only pays off if the org actually commits to F09-fix-1/2/3 — score as test-first (build the smallest prototype, confirm stored posteriors match live Monte Carlo means, before wider adoption).
- **F08-N2** (offline Stan MCMC audit via cmdstanpy) asks for a much heavier toolchain (CmdStan compilation) than F09-new-3's pymc/numpyro ask, for a validation-only (non-production) payoff. Lower priority than the pymc path.
- **F08-N3** (posterior-predictive check against the *already-deployed* champion model) needs no new Python dependency, is pure JS, and audits a real, currently-untested assumption (homoscedastic residual variance) baked into a model already in production. Cheap, complementary, good to run regardless of whether any rating-model candidate ships.
