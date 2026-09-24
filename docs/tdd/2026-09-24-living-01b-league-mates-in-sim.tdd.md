# LIVING-01b: league-mates act inside season-sim

Unit LIVING-01b (ENGINE-SPECS row, handoff branch `claude/handoff-package-2026-09-22`).
Branch `claude/cloud-living-01b-tlmjfs`, cut from PR #241's head `d748c02`
(RL-17-3, the sim on the finder's ROS rate), itself on origin/main `d861c11`.

## 1. Audit: extend or build

- **The sim loop** (`season-sim.js`) has one seam for this: `playSeasons(prep, teams,
  runs, keepRuns, pointsFor)`. Every path (full runs, RL-19-2's `tradeImpactWorld`, the
  old two-run path under `GRIDIRON_FAST_RESCORE=0`) differs only in `pointsFor`. The
  living layer is a new `pointsFor`, so the seeding, bracket and paired-SE code is
  untouched.
- **LIVING-01a** (PR #220, `server/services/engine/activity-model.js` at `60f03eaf`)
  imports `./registry.js` from the engine spine, which is not on this base. Its
  pure functions cannot be imported here. The fitted constants (`FITTED_PARAMS`:
  `pi`, `A`, `lam`, `errLogit`, pop rates) are pinned in `living-league.js` as
  `ACTIVITY_PARAMS` with their provenance; the per-team input is the shape of
  LIVING-01a's `activity.manager` value (`probs`, `rates.adds_per_week.value`,
  `rates.trades_per_week.value`). Swap the copy for an import once #220 is on main.
- **No cloned waiver policy exists yet** (CLONE-01 is unbuilt). This unit ships the
  "simple" policy the task names; see section 5.

## 2. Change

- New `server/services/living-league.js` (~255 lines): flag, pinned params,
  `livingInputs`, `livingScript` (keyed per team and run), `freeAgentPool`,
  `livingPoints` (the per-run resolver).
- `season-sim.js`:
  - `lineupPoints` now sums the drawn points of `lineupStarters` in the same order
    (same floating-point sum; the flag-off hash proves it).
  - `prepareSeason`: with the flag on, the waiver pool (best 40 unrostered players by
    `ros_ppg`/`ppg`, taken before any trade's overrides) joins the simulated universe.
    `prep` also carries `world`, `living`, `faPool`.
  - `livingSeasons`: living result plus the frozen odds from the same draws.
  - `simulateSeason`, `tradeImpactWorld`, `tradeImpact` take `living` (inputs per
    team). The world key gains `living`; `worldFits` rejects a world built under
    other inputs or the other flag state. World `extras` exclude the waiver pool.
  - Fast rescore under the flag re-solves every lineup (claims and trades couple the
    rosters) but reuses the world's draws: no pools, no copula, no projections.

Per team, per run, per week (weeks in order, rosters carried forward):
1. state: sampled from `probs` once, then one step of `A` each week;
2. trades (regular season only): with P = manager's trade rate, his best bench
   player for a keyed partner's best bench player;
3. claims: Poisson(rho x lam[state]), rho = his shrunk add rate / population rate
   (clamped 0.25-4); resolved in a keyed waiver order: claim the pool's best, drop the
   roster's lowest-valued simulated player, only when the claim is worth more;
4. lineup: with P = sigmoid(errLogit[state]), one starter's slot scores 0.

## 3. RED -> GREEN

`test/living-01b-sim.test.js`, RL-19-2's league plus a 15-ppg free agent.

- RED `9c0e64ba`: 5 of 6 fail on base (no `living` block). Test 1 (flag off = today)
  passes on base by design: its SHA-256 golden `8c80fa4b…60bd45` was taken on the base.
- GREEN: 7/7 (a seventh test, drifting -> checked out, was added after the mutation
  sweep; see 4). The checked-out claims bound was loosened in GREEN from `< 0.4` to
  `< 0.8`, and the dead-starter share recentred from 0.932 to 0.905: both first
  bounds ignored the drift back out of checked_out (~3% of team-weeks; expected
  claims ~0.36 a run, measured 0.38; expected share ~0.905, measured 0.908).
- RL-19-2, RL-6-3 and RL-17-3 pass unchanged (28/28 together with this file).

## 4. Mutation sweep

| id | mutant | result |
|---|---|---|
| M1 | lineup errors ignored | killed (1 fail) |
| M2 | no weekly state transition | survived first; killed after adding the drifting test |
| M3 | `worldFits` ignores the living inputs | killed |
| M4 | waiver pool not simulated | killed (2) |
| M5 | script keyed without the run | killed |
| M6 | flag read as truthy (`'true'` turns it on) | killed |
| M7 | rescore drops the living inputs | killed |
| C1 | comment-only edit (control) | survived |

## 5. Measured (fixture only)

All teams at LIVING-01a's population-like mix (0.55 / 0.38 / 0.07), 2000 runs, seed 9:
claims 14.0 a run, executed adds 1.93, trades 0.36, dead starters 2.2 of 12
team-weeks, checked-out share 0.10. Title odds living vs frozen: 0.384 / 0.405,
0.326 / 0.321, 0.166 / 0.151, 0.125 / 0.124. Expected points fall ~2 per team
(dead starters outweigh claims on a 3-player waiver pool).

By state (400 runs, seed 31): all checked out -> dead starters 10.9 of 12
team-weeks (0.908; fitted 0.932 minus the drift back), claims 0.38; all engaged ->
dead starters 0.92 (0.076), claims 19.8.

Timing (this container, 4 teams, 2000 runs): `simulateSeason` 121 ms off / 323 ms
on. `tradeImpactWorld` 98 / 241 ms; one rescore on a shared world 30 / 152 ms.

## 6. Not confirmed

- **The PRE kill test** (fit 2021-22, grade 2023 and 2024 separately: from week 7,
  living beats frozen on log score of real playoff and title outcomes). Needs the
  local history; not run. The flag stays off until it passes.
- **Hard gate:** the spec runs LIVING-01b after CE-03 and PROJ-03-c clear the sim.
  They have not. This is the mechanism, not a promotion.
- **The waiver policy is not cloned from data.** It is a greedy "best free agent by
  ROS rate over the worst rostered player" rule. CLONE-01 replaces it.
- **rho** comes from the shrunk add rate over the population rate, not LIVING-01a's
  internal state-relative multiplier (the served value does not expose it).
- **Lineup errors are not bye-adjusted** (LIVING-01a's own `lineup_error_bye_adjusted:
  false`); the dead slot is a random starter, not the one on bye.
- **Trades are value-neutral bench swaps**, with no acceptance model and no deadline
  beyond "regular season only".
- **No caller passes activity inputs yet.** With the flag on and no inputs, every
  team runs on the population prior, counted in `teams_population`.
- **Rescore cost** on a 12-team league is not measured; it scales with teams, since
  every lineup is re-solved (~150 ms for 4 teams here, against EA-06's 150 ms bound).
