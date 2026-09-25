# BUY-LOW v2 (gap-only) pre-registration

Committed before any v2 evaluation. The results (`docs/tdd/BUY-LOW-V2-results.md`, `.json`) come in a
later commit; `npm run check:prereg-order` checks the order.

## Disclosure first

v1's backtest (`docs/tdd/BUY-LOW-results.md`, seasons 2023-2025) already reported a gap-only flag as a
secondary: +2.48 pts/game [+1.97, +3.04]. That number was seen before this file was written, so
2023-2025 is NOT new evidence for v2. The deciding test below runs on seasons never scored by v1 or v2.

## Question

On held-out seasons, does the gap-only flag (v2) beat matched controls, and is it at least as good as
v1 (usage up + gap)?

## v2 rule (frozen here)

As of week W of season S, weeks < W only, regular season (week <= 18), the same inputs as v1
(`nfl_ffopportunity_weekly` xFP and actual, full PPR):

- T = the player's last 3 games in season S with week < W; n = games in T.
- `gap = mean over T of (xfp - act)`; `gap_shrunk = gap * n / (n + 2)` (same shrinkage as v1).
- Flag when `mean xfp over T >= 5` AND `gap_shrunk >= 2.0`. No usage-trend rule, no baseline needed.

v1 is unchanged (`BUY-LOW-PREREG.md`, rule version 1).

## Test (same design as v1)

- Held-out seasons: **2021 and 2022**. As-of weeks W = 4..15. (v1 needs a baseline; for 2021 there is
  no 2020 data locally, so early-2021 v1 rows fall back to "no baseline" and are never flagged. That is
  v1's rule, not a change.)
- Eligible player-week, prior3, next3, gain, matched controls (same season, W, position, prior3 within
  2.0, up to 5 nearest, ties by id), effect per flagged row: all exactly as v1. Controls for each arm are
  that arm's non-flagged rows.
- 95% CI: percentile bootstrap, 2,000 resamples of player-season clusters, seed 20260925.
- Head-to-head: `diff = mean effect v2 - mean effect v1`. Its CI comes from the same cluster bootstrap:
  each resample draws player-season clusters from the union of both arms' clusters and recomputes both
  means.

## Pass bar and decision

1. v2 passes: pooled v2 CI lower bound > 0 on 2021-2022.
2. v2 is not worse: diff CI lower bound > -0.5 pts/game (non-inferiority margin 0.5).
3. Both hold: recommend replacing v1 with v2 as the served rule. It stays a tie-breaker only, at the
   positions where v2's own held-out CI lower bound > 0 with 30+ rows. TE follows the same rule and
   still needs GRIDIRON_BUY_LOW_TE.
4. Otherwise: v1 stays the served rule and v2 is not served.

Per position (QB, RB, WR, TE): reported with its CI. Fewer than 30 flagged rows means "too few".

## Secondary (reported, never decide)

1. The same comparison on 2023-2025. This is not new evidence (see the disclosure).
2. v2 with controls also matched on xFP (`|diff| <= 2.0`).
3. The flag counts per arm (how many more players v2 flags).
