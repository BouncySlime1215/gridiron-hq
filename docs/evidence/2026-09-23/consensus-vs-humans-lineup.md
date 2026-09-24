# consensus-vs-humans-lineup: results (RL-8-2, TM-01 gate)

<!-- prereg: docs/evidence/2026-09-23/consensus-vs-humans-lineup-preregistration.md -->

**Verdict: DECLINED. The TM-01 gate does not pass.** On the pre-registered primary (2023-24 Sleeper 1-for-1 and
2-for-1 trades where consensus and season-to-date disagree), the consensus-favoured side won 51.5% of trades in
real starting-lineup points. The bar was 55% with a 90% lower bound above 50%. TM-01 may not claim a lineup-points
edge from "consensus disagrees with the other manager" for multi-player offers.

- Pre-registration: `64684863` (committed before the script existed). Script: `scripts/rnd/consensus_vs_humans_lineup.py`
  at `b43802dd`. Output: `consensus-vs-humans-lineup-output.txt` (next to this file), produced by
  `nice -n 10 python3 scripts/rnd/consensus_vs_humans_lineup.py --local-db .local-db/data.sqlite` on that commit,
  tree origin/main `4773401a` + this branch. It is deterministic: 3 runs gave identical pre-registered lines.
- Data: Sleeper public corpus (`data/derived/sleeper_history.sqlite`, read immutable), R&D round 8 inputs, the
  skill-study lineup tables, and `nfl_ffopportunity_weekly` from a `.backup` copy of `data.sqlite`. This is a
  local copy, not production. Aggregates only; no league or manager names.
- **2025 was not opened.** Every SQL read filters `season <= 2024`, and ECR scrapes after 2024 are dropped. No 2026
  outcome was graded.

## 1. Primary and gate (pre-registered; output lines 7-11)

Population: 2023-24 pooled, 1-for-1 plus 2-for-1 trades. There were 374 disagreement trades out of 1,064 trades,
in 213 league chains. 369 had a nonzero outcome; 1.3% were ties.

| metric | estimate | 90% CI, chain | 90% CI, season-week | 90% CI, league | MDE at 80% power |
|---|---|---|---|---|---|
| consensus side wins (lineup points) | **0.515** | [0.468, 0.558] | [0.471, 0.557] | [0.471, 0.560] | 0.068 |
| lineup points per week to the consensus side | **-0.43** | [-1.27, +0.40] | [-1.30, +0.30] | | 1.26 |

`== GATE (prereg item 10): FAIL`. All three conditions miss:
- (a) the rate 0.515 is below 0.55;
- (b) both lower bounds are at or below 0.50;
- (c) the points lower bound is -1.27.

What "underpowered" does and does not mean here: this test could detect a true win rate of about 0.568 or more
(0.50 + MDE 0.068). A true edge smaller than that is not ruled out.

## 2. Secondary results (pre-registered; descriptive, did not decide)

| cut (lineup points unless noted) | n disagreement | consensus wins [90% chain CI] | pts/week [90% chain CI] | MDE (rate) |
|---|---|---|---|---|
| S1: counterfactual lineup gain (frozen rosters, `L_frozen`), 2023-24 pooled | 374 | 0.528 [0.485, 0.569] | +0.67 [-0.34, +1.61] | 0.064 |
| 2023-24 **1-for-1** | 204 | **0.582 [0.521, 0.640]**; week [0.527, 0.635] | **+1.11 [+0.25, +1.92]** | 0.089 |
| 2023-24 **2-for-1** | 170 | **0.435 [0.371, 0.497]** | **-2.28 [-3.73, -0.84]** | 0.096 |
| 2021-22 pooled (curve fit years) | 342 | 0.482 [0.437, 0.525] | -0.67 [-1.40, +0.11] | 0.067 |
| 2021-24 pooled | 716 | 0.499 [0.469, 0.529] | -0.55 [-1.10, -0.01] | 0.045 |

Placebo P1 (1-for-1, 2023-24): A's received player is swapped for a random same-position player traded in the same
season-week, and the outcome uses that player's real starts.
- n = 152 disagreement pairs; consensus wins 0.653 [0.589, 0.715]; +2.45 [+1.40, +3.40] points/week.
- Consensus picks the better lineup asset more often on random pairs than on accepted trades. This matches R8's
  player-points placebo (0.602 vs 0.576). Accepted trades are closer in value, so there is less for consensus to call.

Controls (all pre-registered):
- **Reproduction (known-nonzero), passed.** The script rebuilt R8's 1-for-1 player-points arm and got
  n = 210 of 723, 0.576 [0.515, 0.633]. That is identical to R8's printed line (output line 4).
- **Linkage, passed.** 2,112 of 2,167 sides linked to exactly one `trade_sides` row and both `sides_ext` rows.
  - Unlinked: 53 with no `sides_ext` row or no full week left, and 2 ambiguous.
  - `team_weeks.pts_trade` >= `recv_started_pts` held for **1,843 of 1,843** sides with starts. So the started
    points come from the real weekly lineups.
- **P2 permutation null, tripped the void rule as written.** It permutes x_con within season, 1,000 times: mean
  0.460, 95th percentile 0.486. The pre-registration said the result is void if the mean falls outside
  [0.47, 0.53]. See section 3 for why that rule was mis-specified. Either reading gives the same verdict: void
  and FAIL both mean no PASS.

## 3. Post-hoc (added after the first output; labelled; did not decide)

**Why P2 sits below 0.50.** Permuting x_con makes consensus uninformative. On the randomly formed disagreement set,
a "consensus win" is then a season-to-date loss. Season-to-date is informative, so this null centres below 0.50,
not at 0.50. The pre-registration's expectation of 0.50 was wrong. The harness check that should centre at 0.50
permutes the outcome instead (P2b): mean **0.501**, 5th-95th percentile [0.459, 0.544]. The harness is unbiased.
This is a design error in the pre-registered null, recorded here rather than silently re-specified.

**Where the pooled result comes from.** 1-for-1 holds in lineup points; 2-for-1 reverses.
- On the same 204 linked 1-for-1 trades, player ROS points give 0.583 [0.527, 0.636] and lineup points give 0.582.
  In 1-for-1 swaps, lineup points track player points almost exactly.
- 2021-22 1-for-1 (curve fit years): 0.540 [0.478, 0.600], +0.71 [-0.12, +1.53].
- 2-for-1, 2023-24: consensus favours the 1-player (consolidating) side in 144 of 170 disagreement trades and wins
  only 0.366 of those. In the 26 trades where it favours the 2-player side it wins 0.808.
- 2-for-1, 2021-22: 149 of 174 favour the 1-player side, winning 0.422 of those; 25 favour the 2-player side,
  winning 0.458. 2-for-1 pooled 2021-22: 0.427 [0.367, 0.488].
- So the pre-registered 2-for-1 consensus value (summed value above a replacement rank of QB 13 / RB 30 / WR 36 /
  TE 13, a convention I stated as a guess) overprices the single player. The side that gets two startable players
  starts more points.

This is post-hoc and selected after seeing the data. It is **not** a licence to ship a 1-for-1-only gate. It names
what a fresh pre-registration should test (section 5).

## 4. Audit: extend or build (written before the first test, in the pre-registration's "already known" paragraph)

- **Extend.** The sample, orientation, consensus curve and season-to-date features are R8's
  `r8x_consensus_vs_humans.py`, reproduced exactly (control above). Lineup outcomes reuse the skill study's
  producers; no new outcome measure was invented:
  - `trade_sides.net_started_pts`: writer `rnd/skill/build_03_leagues.py:386-398`, table `trade_sides`.
  - `sides_ext.L_frozen` and `n_h_weeks`: writer `rnd/skill/trades/tr_01_sides.py:150-196`, table `sides_ext`.
  - `team_weeks`: used as the lineup-identity control.
- **Built new:** only the 2-for-1 extension, the join, the placebos and the gate verdict.
- **No production number changed.** No server file, table or column was added. So "one number, one producer" is not
  applicable: this unit is a gate decision, not a served value.
- Greps on `4773401a`:
  - `git grep -n -i "disagreement test\|TM-01" 4773401a -- docs server` returns 2 hits, both unrelated (a betting
    audit's ADP-disagreement test and `server/services/execution-slate-reasoning.js:634`): no trade gate exists in the repo.
  - `server/services/trade-consensus-gate.js` does not exist. It is the other RL-8-2 row's proposed file, not built.

## 5. What this means for TM-01 (and follow-ups, not done here)

1. The Trade Machine's "consensus disagrees with the counterparty" edge **does not survive in lineup points once
   2-for-1 trades are included**. The gate fails. Anything built on it ships default-off, labelled unconfirmed.
2. For 2-for-1 offers, summed player value is the wrong currency. A lineup-aware value is needed: the skill study's
   frozen-roster projected lineup gain E_L (`rnd/skill/trades/tr_01_sides.py`) is the existing producer. Follow-up:
   pre-register "E_L-disagreement vs season-to-date" as the 2-for-1 gate.
3. The 1-for-1 lineup result (0.582) is post-hoc. It can be confirmed only on data not yet looked at:
   - the 2026 forward counterparty test in Nick's leagues (R8 §6.2; about 9 accepted trades so far, far from the
     roughly 200 needed);
   - or one pre-registered, ledgered look at 2025.
4. The `VALUE_GIVEAWAY_LAMBDA` (`server/services/trade-engine.js:139`) and `fairnessFactor` (`:1681`) priors from
   R8's accepted-gap distribution are untouched by this unit.

## Holdout looks

None. 2025 was not opened (every query has `season <= 2024`), so there is no HOLDOUT-LEDGER row. Unit RL-8-2,
2026-09-23.

## Test fix after skeptic review

A skeptic showed the pre-registered 90% interval level (prereg item 7) was untested: changing `cluster_boot`'s
percentiles from 5/95 to 2.5/97.5 passed all 15 tests. Added `test_interval_is_prereg_90_percent` (40 clusters,
asserts lo/hi equal `np.percentile(boot, [5, 95])` for the seed). `python3 -m unittest
scripts/rnd/test_consensus_vs_humans_lineup.py`: 16 OK on the real code, `FAILED (failures=1)` with the mutant.
`python3 docs/evidence/2026-09-23/mutate-consensus-lineup.py` (unit mutants only): 8 killed including this one,
1 designed survivor, 1 not-applied control. The implementation did not change, so every number above and the FAIL
verdict stand; the study was not re-run.

## Deviations from the pre-registration

1. P2's expected centre (0.50) was mis-specified. P2b (outcome permutation) was added post-hoc; see section 3.
2. Post-hoc descriptive lines were added to the same script after the first run, all under the `== POST-HOC`
   header: P2b, the 2-for-1 direction split, 2021-22 strata, and 1-for-1 player points. The pre-registered part of
   the output is byte-identical across runs (`diff` of the first 38 lines against the first run: no difference).
