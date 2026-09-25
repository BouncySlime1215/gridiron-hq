# BUY-LOW pre-registration (Project queue item 22)

Committed before any evaluation. The results file (`docs/tdd/BUY-LOW-results.md`, `.json`)
must come in a later commit; `npm run check:prereg-order` checks the order.

## Question

Do players the BUY-LOW detector flags (usage up, points below expected) outscore their
prior-3-week average over the next 3 weeks by more than matched players it did not flag?

## Detector (v1, frozen here)

As of week W of season S. Only weeks < W are read (week W's games have not finished).

Per game g (regular season, week <= 18):

- `xfp_g`: nflverse ffopportunity `expected_fantasy_points` (full PPR; table
  `nfl_ffopportunity_weekly`). It already prices targets, carries, air yards and red-zone
  location, so it is reused, not rebuilt.
- `act_g`: the same table's `actual_fantasy_points`.
- `u_g` (usage): WR/TE `target_share` (`player_week_usage`, joined players.gsis_id -> players.id);
  RB `carries + 2.5 * targets` (one RB target is worth about 2.5 carries); QB `xfp_g`.

Windows:

- Trailing window T: the player's last 3 games in season S with week < W.
- Baseline B: the player's games in season S before T. If B has fewer than 2 games, B is the
  player's season S-1 regular-season games instead. Fewer than 2 there: not scored (`no_baseline`).

Role change:

- A game is "usage up" when `u_g - mean(u over B)` is at least: WR/TE 0.03 share, RB 2.0
  opportunities, QB 2.0 expected points.
- `confirmed`: 2 or more games of T are usage up.
- `detected`: fewer than 2, and the most recent game of T is usage up (one game detects, several confirm).
- otherwise: no role change, never flagged.

Points gap, shrunk:

- `gap = mean over T of (xfp_g - act_g)`; `n = games in T`.
- `gap_shrunk = gap * n / (n + 2)` (prior of 0 worth 2 games; 1 game keeps a third, 3 games 60%).
- Using both: `gap` is expected minus actual, so both actual and expected points enter the score.

Flag: universe QB/RB/WR/TE with `mean xfp over T >= 5`; `buy_low = true` when the role change is
`detected` or `confirmed` AND `gap_shrunk >= 2.0` pts/game. The score is `gap_shrunk`.

## Test

- Seasons 2023, 2024, 2025. As-of weeks W = 4..15.
- Eligible player-week: in the universe above, at least 2 games in T, at least 2 games in weeks
  W..W+2 (regular season).
- `prior3` = mean act over T. `next3` = mean act over games in weeks W..W+2. `gain = next3 - prior3`.
- Control for a flagged player-week: eligible NON-flagged players of the same season, W and position
  with `|prior3 - flagged prior3| <= 2.0`; the up to 5 nearest by prior3 (ties by player id).
  A flagged row with no control is dropped and counted.
- Effect per flagged row = its gain minus the mean gain of its controls.
- Estimate = mean effect (pts/game). 95% CI: percentile bootstrap, 2,000 resamples of player-season
  clusters (a player flagged in several weeks is one cluster), seed 20260925.

## Pass bar (primary)

Pooled estimate over all positions: **CI lower bound > 0**.

Per position (QB, RB, WR, TE): reported with its own CI. A position is recommended for the flag
only when the pooled bar passes AND its own CI lower bound > 0. Fewer than 30 flagged rows at a
position: reported as "too few", never a pass.

## Decision

- Pooled passes: recommend turning GRIDIRON_BUY_LOW on for the passing positions (tie-breaker only;
  never overrides never-give.js or the 83+ Blue chip floor).
- Pooled fails: the flag stays shadow (default off). No threshold is re-tuned on these seasons
  and re-tested as if new; any v2 needs its own pre-registration and a held-out season.

## Secondary (reported, never decide)

1. `detected` vs `confirmed` split.
2. Controls additionally matched on mean xfp over T (`|diff| <= 2.0`): the part of the effect beyond
   expected points (does the usage trend add anything once xFP is known).
3. The same test for a gap-only flag (`gap_shrunk >= 2.0`, no usage-trend requirement).

## Known limits, stated up front

- The ffopportunity xFP model is nflverse's, fitted on multi-season play-by-play that may overlap
  2023-2025: model-level overlap, not same-week data. Not controllable here.
- Full-PPR points only (all five local leagues are full PPR).
- Trade price is not in the test: a real buy-low also needs the owner to sell below value.
