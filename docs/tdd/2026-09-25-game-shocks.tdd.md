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

Commit `test: RED for GAME-SHOCKS ...` (`test/game-shocks.test.js`, no code):

```
not ok 1 - nu is the pre-registered 6 and only the flag turns the shock on
not ok 2 - studentTCdf matches tabled t quantiles
ok 3 - off: the sampler with no shock option is byte-identical to today
not ok 4 - on: every marginal stays uniform over its pool
not ok 5 - on: same-game joint extremes rise in both tails; different games stay independent
not ok 6 - the shock is keyed by fixture and run, not by who else is in the list (paired arms)
not ok 7 - season sim: the shock options come from the flag, keyed by world and week
not ok 8 - measurement helper: shocks raise simulated joint upper-decile exceedance at a fixed rho
# pass 1
# fail 7
```

(Test 3 passes on main by construction: it is the control that the new option, absent,
leaves today's draws alone.)

## GREEN

- `server/services/correlation.js`: `GAME_SHOCK_NU` (6), the flag
  (`GRIDIRON_GAME_SHOCKS` / `gameShocksFlag` / `gameShockFields`), `studentTCdf` (closed-form,
  integer nu), `gameShockScale` (one chi2(nu)/nu per (key, fixture, counter)),
  `correlatedSampler(..., { gameShock })`; M1 helpers `sameGameResiduals` (extracted
  unchanged from `fitCorrelations`, which now calls it), `tailCoexceedance`,
  `simulatedJointExceedance`, `gameShockVerdict`.
- `server/services/season-sim.js`: the shock passed to the one title-odds sampler,
  keyed by (world, week), and a `game_shocks` field on the result when on; re-exports
  the flag.
- `server/services/league-world.js`: the flag is part of the world's snapshot key when
  on, so a flip rebuilds the held world (absent when off: key unchanged). It reads the
  flag from correlation.js, not season-sim.js: a first full-suite run failed
  `test/scoring-call-sites.test.js` because that file mocks season-sim.js whole
  (`does not provide an export named 'gameShocksFlag'`). The flag moved beside the
  copula instead of editing the test; every mock of correlation.js spreads the real
  module.
- `scripts/measure-game-shocks.mjs`: M1 and M2, read-only.

Added with GREEN: test 9 (M1 helpers on a hand-built residual map) and
`test/game-shocks-sim.test.js` (the real season sim on RL-6-3's fixture: off is the
same with unset and 0; on names the shock, sums hold, expected points barely move;
roster reorder and a benched shared-universe claim still change nothing).

```
test/game-shocks.test.js      # pass 9  # fail 0
test/game-shocks-sim.test.js  # pass 3  # fail 0
```

Fixture measurement (`simulatedJointExceedance`, 200,000 draws, key 11), both players
above their own quantile q, Gaussian copula vs grouped-t nu 6:

| rho | q | Gaussian | nu 6 | ratio |
|---|---|---|---|---|
| 0.00 | 0.90 | 0.0100 | 0.0140 | 1.40 |
| 0.00 | 0.95 | 0.0025 | 0.0050 | 1.97 |
| 0.18 | 0.90 | 0.0162 | 0.0209 | 1.28 |
| 0.18 | 0.95 | 0.0050 | 0.0079 | 1.57 |
| 0.30 | 0.90 | 0.0216 | 0.0260 | 1.21 |
| 0.30 | 0.95 | 0.0074 | 0.0105 | 1.43 |

The pre-registration's "Gaussian ~0.024 at rho 0.3" was an estimate; the measured
value is 0.0216 (the test's tolerance, 0.004, covers both).

## Needs local measurement (decides the flag)

```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy of the live db> node scripts/measure-game-shocks.mjs --leagues 4 --runs 2000
```

M1 prints PASS / FAIL per group against the bar above; M2 prints league 4's odds off
vs on by roster id and the invariants. The flag stays off unless M1 passes.
