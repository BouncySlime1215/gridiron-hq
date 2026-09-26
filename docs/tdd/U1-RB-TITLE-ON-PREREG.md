# U1 RB-TITLE-ON: pre-registration

Written and committed before any league-4 measurement. Results go in
`docs/tdd/2026-09-25-u1-rb-title-on.tdd.md`, graded against this file unchanged.

## What changes

`GRIDIRON_RB_TITLE=1` (its own flag; preview never turns it on) serves the conditional
(Rao-Blackwellised) title estimate from `server/services/rb-title.js` in two places:

1. the served title odds (`title_now` in the War Room, every `title_odds` in the sim), now
   carried with their Monte Carlo SE (`title_before_se` / `title_after_se` on every
   `tradeImpact` side, `destination.title_now.se` in plans.json);
2. the planner's paired confirm-dice deltas (`title_delta`, `title_delta_se`,
   `title_delta_clears_noise`), which `confirm.js#confirmVerdict` and
   `modes.js#beatsNoTrade` read.

Nick's rules do not change: never-give, the Blue chip floor, the overpay cap and "a served
move must beat doing nothing on the confirm dice" read the same fields with the same
thresholds. Only the estimator behind the title numbers is more precise. `p_gate` is
untouched.

## Pass bars (all three must hold to recommend turning it on)

1. **SE ratio, league 4, paired deltas: median <= 0.5.** On a copy of the live DB, live env,
   one world at the confirm seed built with `GRIDIRON_RB_TITLE=shadow` (both estimators on
   the same draws), every single-player rescore the planner's search makes (each outside
   player Nick could get, each of his players he could lose). Ratio per deal =
   `title_delta_rb_se / title_delta_se`, median over the deals whose plain SE is > 0
   (deals with plain SE 0 are counted and reported, not ratioed).
2. **No rule violations.** `test/rule-fuzz.test.js` passes with the flag on and off, and
   `scripts/check-rules-everywhere.mjs --league 4` passes against the flag-on league-4 plans.
3. **Unbiased.** 20 seeded fuzz leagues (8-12 teams, 4/6/8-team brackets, fixed or reseed,
   random team means and spreads, one longshot slot as Nick). For Nick's slot, both the title
   level and a paired delta (+6 pts/week): RB at 1,200 runs vs plain MC at 20,000 runs,
   `z = (rb - plain) / sqrt(se_rb^2 + se_plain^2)`. Pass: at most 3 of 20 leagues with
   |z| > 2 for levels and at most 3 of 20 for deltas (under no bias about 1 of 20 is
   expected; P(>= 4) ~ 1.5%), and the pooled mean z times sqrt(20) inside +/-2 for each.

## Measured and reported, not gated

League 4, flag off vs on, same DB copy and env: `title_now` with its SE; deck paths that
clear the confirm gate (beat doing nothing on the confirm dice) before -> after; the next
move before -> after; rule breaks; producer runtime.

## Kill

SE ratio > 0.6 or any bias bar failing: leave the flag off and report.
