# TRADE-EVAL-V2: one forward-looking trade evaluator

Nick asked for this on 9/26: "the considerations on a trade are very narrow; we need to seriously weigh a bunch of different things, grounded in stats, forward looking."

**Goal:** one evaluator that scores any roster state, before or after a trade, by PLAYOFF ODDS, the league goal. Every factor below enters through its existing producer, and nothing is hand-weighted. The factors change the simulated weekly lineups and win probabilities, and the season sim turns those into playoff odds.
- The chain's lookahead (COACH-CHAIN) uses this evaluator as its leaf value.
- Coach shows the factor breakdown.

## Factors, and the producer each comes from

| # | Factor | Forward-looking stat | Producer / source |
|---|---|---|---|
| 1 | Rest-of-season projection | Weekly distribution (p10/p50/p90), not the mean | Frozen ESPN weekly projections, plus the E-XGB shadow as a second opinion (PROJ-DUEL). Calibrated ranges k=1.71 (WEEKLY-RANGE-ONE) |
| 2 | Full lineup impact | Optimal lineup every remaining week, with the exact league slots including both FLEX | Lineup optimizer, lineup-week-range.js |
| 3 | Byes | Weeks each player is out | Schedule |
| 4 | Injury and availability risk | P(plays) per week, and durability | The avail.p_play layer |
| 5 | Usage trend | Snap share, target share, carries, red-zone share, xFP (the trend, not last week alone) | player_week_usage, ffopportunity, the BUY-LOW detector, the O1 opportunity radar |
| 6 | Team context | Vegas implied team total, QB quality, offense changes | nfl_lines, depth charts, news |
| 7 | Matchups | Opponent defense vs the position for each remaining week, WEIGHTED toward the playoff weeks | Opponent allowed-by-position (the E-XGB panel feature) |
| 8 | Replacement level | Best free agent at each slot; roster size and forced drops | The FA pool, waivers perishable (#456) |
| 9 | Positional scarcity | Gap between a starter and replacement, by position in this league | League rosters vs the FA pool |
| 10 | Our schedule leverage | Which weeks matter most for playoff odds (must-win weeks) | playoff_path, #477 (make it served: COACH-HOME unit 6) |
| 11 | Variance fit | As an underdog, prefer upside; as the favourite, prefer floor | Risk mode and Start/Sit posture |
| 12 | Market value | Fair price, to keep future flexibility (never overpay) | fc-value.js, the one reader |
| 13 | Counterparty | P(yes), what they want, reply timing | blend.accept, Numbers & People (Jev), the reply clock |
| 14 | Next steps | The best continuation after this trade | The COACH-CHAIN expectimax |
| 15 | Hard rules | Every one of Nick's rules | never-give.js |

## Output, per trade

The headline is Δ playoff odds with an SE: now, and with the best follow-ups. Under it sits a per-factor contribution breakdown, computed by switching one factor at a time on paired seeds, e.g.:

> Lineup: -4.1 pts/wk (FLEX goes to FA level) · Injury: -0.8 · Matchups weeks 15-17: +1.2 · Usage trend: +0.6 · …

Coach renders it as a waterfall.

## Validation (before it ranks served cards)
- **Backtest:** the SEASON-REPLAY (#496) retro. For past weeks in Nick's leagues, do moves chosen by V2 beat moves chosen by v1 and doing nothing on realised wins and points? Pre-register the metric and the bar before running.
- **Sanity fixtures:**
  - a consolidation 3-for-1 that guts the FLEX spots must score negative unless the star gap covers it;
  - a bye-week stack must show a hit;
  - an injured star must be discounted.
- **Calibration:** do the predicted weekly win probabilities match realised results (binned)?

## Build order
1. Evaluator skeleton on the season-sim: factors 2, 3, 4 and 8 (the lineup realism Nick flagged first).
2. Factors 1, 5, 6 and 7.
3. Factors 10 and 11, plus the breakdown UI.
4. Backtest and calibration.
5. Switch the served ranking over.
