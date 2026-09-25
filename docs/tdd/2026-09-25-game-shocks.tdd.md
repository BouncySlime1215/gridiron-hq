# GAME-SHOCKS: shared per-game shocks in the season sim's copula

ONE-PLAN §4d block 1 ("shared game shocks in the copula (tail dependence)") and the
spot-check row 4: `correlation.js` draws with a Gaussian copula via Cholesky, and a
Gaussian copula has no tail dependence (E1). Two players in one NFL game boom together
(a shootout) or bust together (a blowout, weather) more often than their pairwise
correlation alone produces, and a Gaussian copula cannot represent that: its joint
extremes vanish as the threshold rises.

## Pre-registration (written 2026-09-25, before the code or any run)

**Change.** A grouped-t copula over NFL games. In each simulated week of each run,
every NFL game (fixture) draws ONE mixing variable `W ~ chi2(nu) / nu`, keyed by
(world, week, fixture, run). Every player in that game has his correlated normal
`z` divided by `sqrt(W)` and mapped to a uniform through the Student-t(nu) CDF instead
of the normal CDF. The uniform still indexes the player's own sorted outcome pool.

- Marginals are unchanged exactly: `z / sqrt(W)` is t(nu) distributed, so its t CDF
  is uniform, the same as `Phi(z)` was. Only the dependence changes.
- Linear/rank correlation between two players is almost unchanged; what changes is
  how often they are extreme together (both boom or both bust), in the same game only.
  Players in different games stay independent, as today.
- The shock is keyed by fixture and run, never by roster, so both arms of a paired
  trade see the same shock in the same run (RL-6-3 / paired seeds).
- Only the season sim (`season-sim.js`, the one title-odds producer) passes the shock.
  `ceiling-lineup.js` and the trade engine keep today's Gaussian draws.

**nu is fixed at 6, not fitted, not swept.** Why 6: it is the conventional
heavy-but-finite choice for weekly sports residuals, and it bounds the effect. The
implied upper-tail dependence at the fitted same-team QB-WR correlation (~0.3) is
about 0.09 (Gaussian: 0), and about 0.03 for an uncorrelated same-game pair. A
different nu is a NEW registration with its own date and reason; this result stays.

**Flag.** `GRIDIRON_GAME_SHOCKS`: `1` on, `0` off (vetoes preview), unset = off unless
preview mode (`GRIDIRON_PREVIEW_UNCONFIRMED=1`). Off, the sim is byte-identical to main.
Nothing Nick sees moves until the local measurement below passes and Nick turns it on.

**Metrics and bars.**

- M1 (the one that decides; local, needs `player_week_usage`): empirical same-game
  joint upper-decile exceedance, `P(both players above their own 90th percentile)`,
  over 2021+ weekly residuals, for (a) same-team QB-WR pairs and (b) all same-game
  pairs. Compare the sampler's rate at the same fitted correlation, shocks off vs on.
  PASS: for both (a) and (b), the shocks-on rate is closer to the empirical rate than
  shocks-off, AND does not overshoot the empirical rate by more than 25% relative.
  FAIL: either group farther, or an overshoot beyond 25%. On FAIL the flag stays off.
- M2 (local, league 4, report only, no direction bar): Nick's title and playoff odds,
  flag off vs on, on the same world (paired). Invariants that must hold: title odds sum
  to 1, playoff odds sum to the playoff spots, and each team's expected points per week
  moves by less than 0.5 (marginals preserved).
- M3 (in-repo tests, fixtures): flag off is byte-identical; marginals uniform with the
  shock on; same-game joint extremes rise, different-game pairs stay independent; the
  shock is identical across two rosters that share a fixture.

## RED

(filled after the RED commit)

## GREEN

(filled after the GREEN commit)
