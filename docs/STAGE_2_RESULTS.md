# Stage 2 results — one player-week event engine

Measured 2026-08-27. These are development diagnostics, not a claim of betting
profitability and not an untouched holdout.

**Update, same day:** the QB game-state participation fix (one active passer
per simulated game instead of splitting team attempts across every QB on the
roster) and the identity-ingestion repair (coverage 83.24% → 97.34%, a real
nflverse import bug that was discarding ~10-12k player-weeks/season) landed
after the table below was first measured. The numbers here are stale for
coverage, passing yards, and TD calibration; the corrected figures are in
"Four-season walk-forward result (updated)" and the gate verdict below.

## What changed

- Fantasy and props now resolve the same canonical player identity and consume
  the same volume × efficiency event state.
- Team pass attempts, targets and carries are drawn once and allocated among
  teammates. Independent player simulations can no longer manufacture more
  team opportunity than the offense has.
- Fantasy points are a scoring translation of the shared events. The explicit
  weekly fantasy calibration shift remains a separate, visible layer.
- Props no longer use the duplicate `0.65 / 0.35` player blend.
- Pregame prop eligibility is based only on the projected role at the cutoff.
  It never looks at whether the player appeared in the target game.
- Anytime-touchdown probabilities exclude passing touchdowns.
- Real prop quotes are timestamped for future priced replay and CLV analysis.

## Four-season walk-forward result (2022–2025)

| Population / statistic | N | MAE | RMSE | Bias |
|---|---:|---:|---:|---:|
| Broad passing yards | 2,220 | 67.724 | 85.394 | +7.437 |
| Pregame market-eligible passing yards | 1,198 | **59.298** | 74.962 | +3.268 |
| Broad rushing yards | 7,652 | 16.545 | 24.941 | -2.521 |
| Market-eligible rushing yards | 3,911 | 23.625 | 31.677 | -3.156 |
| Broad receiving yards | 14,281 | 18.484 | 26.276 | -2.726 |
| Market-eligible receiving yards | 10,354 | 21.547 | 29.295 | -2.829 |
| Broad receptions | 14,281 | 1.412 | 1.911 | -0.233 |
| Market-eligible receptions | 10,354 | 1.601 | 2.098 | -0.217 |

Identity/projection coverage is 16,799 / 20,181 = **83.24%** at this
measurement — see the corrected figure below.

The original passing-yards baseline was 70.14 MAE. The shared engine improves
the same broad diagnostic to 67.72, but does **not** clear the original broad
`<60` gate at this measurement — see below. The pregame market-eligible subset
does clear it at 59.30. Both populations are permanently shown in the UI so
abstention cannot masquerade as accuracy.

Touchdown calibration is also mixed: broad Brier is 0.1588; market-eligible
Brier is 0.2014. The latter population has a materially higher base rate, so it
must get its own calibration head rather than borrowing the broad score.

## Four-season walk-forward result (updated, after the QB participation and
## identity fixes, measured same day)

The QB layer was drawing one passer's worth of team attempts and splitting it
across every quarterback on the roster — suppressing clear starters 10-40%.
Fixed to a game-state participation model: one active passer per simulated
game, competing player forecasts stay inside the team's real attempt budget.
Separately, the nflverse importer was discarding ~10-12k player-weeks/season
because it only accepted players already on the app's current roster.

| Population / statistic | N | MAE | RMSE | Bias |
|---|---:|---:|---:|---:|
| Broad passing yards | 1,863 | **59.282** | 75.460 | +3.417 |
| Pregame market-eligible passing yards | 1,862 | 59.308 | 75.479 | +3.413 |
| Broad rushing yards | 5,599 | 20.252 | 28.575 | -2.836 |
| Market-eligible rushing yards | 4,066 | 23.844 | 31.907 | -3.013 |
| Broad receiving yards | 11,375 | 21.160 | 28.671 | -1.910 |
| Market-eligible receiving yards | 11,022 | 21.463 | 28.980 | -1.917 |
| Broad receptions | 11,375 | 1.572 | 2.054 | -0.121 |
| Market-eligible receptions | 11,022 | 1.593 | 2.074 | -0.120 |

Identity/projection coverage is now 19,645 / 20,181 = **97.34%**.

The broad passing-yards `<60` gate now **passes** at 59.28 — it was the
QB-attempts bug depressing clear starters, not a genuine model limitation.

Touchdown calibration, updated: broad Brier is **0.1531** (was 0.1588),
market-eligible Brier is **0.1955** (was 0.2014) after the 15-bin
empirical-Bayes calibration head. The eligible population still trails the
broad score by a real margin — it has not yet gotten a calibration head fit
specifically to its own (materially higher) base rate. Still open.

## Candidate-head discovery

The registry contains 24 candidate-only heads. On 2024 discovery:

- Active champion: 4.7569 MAE, 0.6706 Spearman, N=4,013.
- Seven highly correlated heads were removed before hypothesis testing.
- Seventeen heads entered paired sign-flip tests with Holm correction.
- Only `robust_consensus` survived the discovery accuracy, rank and
  multiplicity gates.
- 2025 validation remains sealed. The survivor has zero production authority.

Forward weekly snapshots now store every candidate prediction on first write.
Snapshots cannot be rewritten before settlement. At 250 settled rows a
challenger may become review-eligible; it is never promoted automatically.

## Spread model correction

The 21 component spread models are still retained. Residual influence now
requires all three:

1. at least 250 cutoff-safe games;
2. at least 0.03 points of RMSE improvement over market consensus; and
3. a one-sided paired-test statistic at or below -1.645.

At the current fit, **0 / 21** clear that gate. The sportsbook market therefore
remains the spread champion instead of being moved by microscopic fitted
improvements.

## Blind-audit controller

`scripts/nfl-blind-audit.mjs` and `nfl-blind-audit.js` preregister the exact
commit/worktree, input-table contents, model versions, policy and 70-week
2021–2025 schedule. Each week opens once, appends to a SHA-256 chain and writes
a fault ledger. The next week is blocked if code or model inputs change.

This is accurately labeled **historical algorithmically blind replay** because
2021–2025 has already been inspected during development. The genuinely
untouched promotion set is the frozen 2026 forward ledger with real prices and
positive CLV.

## Gate verdict (updated, same day)

- Shared-engine architecture: **green**.
- Props/fantasy structural agreement: **green**.
- Market-eligible passing-yards MAE <60: **green**.
- Broad passing-yards MAE <60: **green** (was red — fixed by the QB
  participation model, not a scope change to the gate).
- Identity/projection coverage: **green**, 97.34% (was 83.24%, an
  identity-ingestion bug, not genuine cold-start uncertainty).
- Broad TD calibration: **green**, Brier 0.1531.
- Market-eligible TD calibration: **red / needs its own calibration head** —
  improved (0.2014 → 0.1955) but still trails the broad score.
- Weekly-distribution CRPS/coverage gate (Build Order 1.2): **green**,
  reconfirmed after the identity fix — refit on 2023+2024, validated on 2025:
  coverage 0.791 (gate [0.78, 0.82]), calibration error 0.095 (was 0.157),
  CRPS 3.169 (unchanged from shipped). No change to `WEEKLY_LEVEL` needed.
- Candidate-head promotion: **sealed**.
- Incremental spread signal over the market: **not demonstrated**.

Stage 3 data capture and shadow learning should continue. The one remaining
red item from this stage is market-eligible TD calibration; no player-head or
spread challenger receives production authority from this development replay.
