# LIVING-01b PRE kill test: pre-registration

Committed before the script is written or run. Any later change to this file is a
deviation and is listed in the results section of the PR, not edited here.

## Question (ENGINE-SPECS LIVING-01b row)

Fit on Sleeper 2021-22, grade 2023 and 2024 separately: starting at week 7, does the
living sim (league-mates act) beat the frozen sim on the log score of real playoff and
title outcomes? If not, LIVING-01b ships OFF and title odds stay frozen-roster.

## Data

- `~/gridiron-local/rnd/skill/team_seasons.sqlite` (local R&D corpus, read-only), `source = 'sleeper'`.
- Seasons 2021-2024 only. The script asserts no 2025 row is read (2025 stays closed).
- League filters as LIVING-01c's fit: `league_dead`, `late_start`, `team_inactive`, `idp` all 0.
- A league is graded only if every team has weeks 1-6, the regular season runs to at
  least week 8, the week 7+ pairings are recoverable, and 0 < real playoff count < teams.
  The title grade also needs exactly one recorded champion.
- Nothing league-, roster- or manager-identifying is printed or committed.

## What is being tested

The corpus has team-weeks, adds and dead starts, not weekly rosters or projections, so
the test is the **team-level replay of LIVING-01b's mechanism**, not the player-level
season-sim. It tests whether simulating engagement state, claims and lineup errors adds
information to title and playoff odds; it does not test the waiver policy's player
choices.

Cut after week 6. For each graded league, R = 1000 runs of weeks 7..end of the regular
season, then the playoff bracket (top N seeds by wins then points-for, fixed bracket,
byes to the top seeds, one draw per round), exactly as LIVING-01c's grader.

- **Frozen arm:** team weekly points = m + sd * z. m = the team's mean over weeks 1-6;
  sd = the league's pooled residual sd over weeks 1-6.
- **Living arm:** the same z (common random numbers), plus the team's simulated actions:
  - state: a forward filter over weeks 1-6 with LIVING-01a's pinned params
    (`ACTIVITY_PARAMS`, fitted Sleeper 2021-22) gives the week-6 state probabilities;
    emissions are adds ~ Poisson(lam[s]) and err ~ Bernoulli(sigmoid(errLogit[s])),
    err = (dead_starts + empty_starts > 0) that week. Each simulated week steps the state by A.
  - claims: adds ~ Poisson(rho * lam[s]); rho = clamp(((adds weeks 1-6) + 6 * popAddRate)
    / 12 / popAddRate, 0.25, 4) (shrunk to the population with 6 weeks' weight, clamped as 01b).
  - lineup error: err ~ Bernoulli(sigmoid(errLogit[s])).
  - points: m + sd * z + g * (simulated adds since the cut, this week's included)
    + L * (err - h), h = the team's own err rate over weeks 1-6 (m already contains it).
  - trades: not simulated. 01b's trades are value-neutral bench swaps, zero expected
    effect at team level.
- **g and L** are fitted on 2021-22 only, regular-season weeks: weekly points demeaned by
  league-week, then by team-season, regressed (OLS, no intercept) on cumulative adds
  through the week and on err, both demeaned the same way. League-clustered SEs. g is
  floored at 0 (a claim is never modelled as costing points).

## Metric and rule

Per team, p = (hits + 0.5) / (R + 1); log score = y log p + (1 - y) log(1 - p).
Delta = living - frozen, mean per team (positive = living better). 90% interval: league
bootstrap, 1000 resamples, fixed seed. Playoff: y = `made_playoffs`. Title: y = `champion`.

**PASS** only if, in 2023 AND in 2024 separately, the playoff delta's 90% lower bound > 0
AND the title delta's 90% lower bound > 0. Anything else is **FAIL**: the flag stays off
and the PR says so.

Reported, not gating: Brier deltas, and the errors-only arm (g = 0) to attribute any gain.

## Seeds

Season RNG per league: 7919 * k (k = league order); living scripts on their own stream
(seed XOR 0x85EBCA6B); bootstrap seed 4601.
