# RL-8-2: consensus vs humans in real trades, graded in lineup points (TM-01 gate). Declined

<!-- prereg: docs/evidence/2026-09-23/consensus-vs-humans-lineup-preregistration.md -->

Branch `claude/local-rl-8-2-consensus-vs-humans-lineup`, base origin/main `4773401a`. The results and every number
are in `docs/evidence/2026-09-23/consensus-vs-humans-lineup.md`, with raw output in `...-output.txt`. This file holds
the build record.

## 1. Audit

- **What already existed:**
  - R&D round 8's player-points arm (`~/gridiron-local/rnd/loop/scripts/r8x_consensus_vs_humans.py`).
  - The skill study's lineup producers:
    - `trade_sides.net_started_pts`, writer `rnd/skill/build_03_leagues.py:386-398`;
    - `sides_ext.L_frozen` and `n_h_weeks`, writer `rnd/skill/trades/tr_01_sides.py:150-196`;
    - `team_weeks`, writer `rnd/skill/build_04_assemble.py`.
  - Nothing in the repo grades trades against consensus. `git grep -n -i "disagreement test\|TM-01" 4773401a -- docs server`
    returns 2 unrelated hits.
- **Decision: extend.** R8's sample and value curve are reproduced exactly, the skill-study outcomes are joined in,
  and nothing new is served. No server file, table, column or route changes. "One number, one producer" is not
  applicable because no served number changes.
- **Pre-registration** `64684863`, committed before the script existed. Its "already known" paragraph is the audit
  as written before the first test.

## 2. RED

`96b98193` `test: RED harness for RL-8-2 consensus-vs-humans lineup study`.
- It adds `scripts/rnd/test_consensus_vs_humans_lineup.py`, 14 tests, against a skeleton whose functions raise.
- `python3 -m unittest scripts/rnd/test_consensus_vs_humans_lineup.py` → `FAILED (errors=14)`. First failing
  assertion: `C.cluster_boot(rows, stat, 'k', reps=400, seed=1)` → `NotImplementedError`
  (`consensus_vs_humans_lineup.py:32`).
- Every test failed for the right reason: the function did not exist yet.

## 3. GREEN

`b43802dd` `feat: RL-8-2 consensus-vs-humans trade study in lineup points`. Same command → `Ran 14 tests ... OK`.
- One fix before GREEN: `_sign` did `(x > 0) - (x < 0)`, which numpy booleans reject (TypeError on the first real
  run). It now casts to int.
- `4c0012b7` `test: kill the one-row-per-cluster bootstrap mutant; add RL-8-2 mutation sweep`. The test was wrong
  (see section 5). Now 15 tests, OK.
- Skeptic fix (after `92ffc246`): `test_interval_is_prereg_90_percent` pins `cluster_boot` to the pre-registered
  90% interval (prereg item 7) on a 40-cluster fixture where the 5th/95th and 2.5th/97.5th percentiles differ.
  Now 16 tests, OK. No implementation change.

## 4. What it does

`scripts/rnd/consensus_vs_humans_lineup.py`:
1. Rebuilds R8's 1-for-1 sample (same query, same seed 7) and adds 2-for-1 trades on a separate RNG stream.
2. Values each side with the 2021-22 ECR-rank → ROS-PPG curve. 1-for-1 uses the raw difference; 2-for-1 uses
   value above replacement.
3. Stops unless R8's printed 0.576 on n = 210 reproduces.
4. Joins each side to `trade_sides` and `sides_ext` by league rank, roster, leg week and player sets. It checks the
   join against `team_weeks.pts_trade`.
5. Grades the pre-registered primary with chain-, season-week- and league-clustered bootstraps. It computes MDE with
   `MDE_Z` (same constant as `server/services/gates/baseline-gate.js:32`) and prints the gate verdict, the
   secondaries, placebo P1, null P2 and a labelled post-hoc block.
6. Refuses to read the live `data.sqlite`.

## 5. Mutation sweep

`python3 docs/evidence/2026-09-23/mutate-consensus-lineup.py --with-study --local-db .local-db/data.sqlite`.
Unit mutants are judged by the tests. Call-site mutants inside `main()` are judged by diffing the study's
pre-registered output lines against the committed output.

| mutant | result |
|---|---|
| ties counted as losses | killed (2 failures) |
| disagreement sign flipped | killed |
| gate bar 0.55 → 0.50 | killed |
| gate drops the season-week bound | killed |
| 2-for-1 draws from R8's RNG stream | killed |
| 2-for-1 give-side sign | killed |
| bootstrap takes one row per cluster | **survived on `b43802dd`** (the test's clusters had identical rows); test added in `4c0012b7`, now killed |
| bootstrap CI 90% → 95% (`percentile(d, 5/95)` → `2.5/97.5`; skeptic mutant) | **survived on `92ffc246`** (2-cluster fixtures give equal 2.5th and 5th percentiles); test added after `92ffc246`, now killed |
| designed survivor: `per_week` `weeks <= 0` → `weeks < 0` | survived, as designed (equivalent: `not weeks` still catches 0) |
| not-applied control (string absent) | NOT APPLIED |
| call site: gate graded on S1 instead of the primary | killed (output diff at the primary block) |
| call site: R8 orientation seed 7 → 8 | killed (output diff at the linkage line) |

For the seed 7 → 8 mutant, the reproduction line did **not** change. Disagreement win rates are invariant to which
side is A, because x_con, x_std and y all flip together. Only the side-A linkage counts moved. So the reproduction
control guards the sample and the curve, not the orientation.

## 6. Numbers

All numbers are in the results file, from `nice -n 10 python3 scripts/rnd/consensus_vs_humans_lineup.py --local-db .local-db/data.sqlite`
on `b43802dd`, local copy, not production.
- Primary: 0.515, 90% chain CI [0.468, 0.558], MDE 0.068, n = 374. Gate **FAIL**.
- 1-for-1 alone: 0.582 [0.521, 0.640].
- 2-for-1 alone: 0.435 [0.371, 0.497].
- Placebo P1: 0.653.
- P2 as registered: mean 0.460, which trips the void rule. The rule was mis-specified; the post-hoc outcome
  permutation P2b centres at 0.501.
- Decision grade against the dumb baseline (coin flip / season-to-date): season-to-date wins 0.485 of the same
  trades. Consensus is not reliably better than the side a counterparty sees.
- 2025 was not opened, so there is no ledger row.

## 7. Known defects and follow-ups

1. The 2-for-1 value convention (replacement ranks QB 13 / RB 30 / WR 36 / TE 13) is a guess. It is the likely cause
   of the reversal. Follow-up: pre-register an E_L-based (frozen-roster lineup value) gate for multi-player offers.
2. The 1-for-1 lineup edge (0.582) is post-hoc. It needs a fresh sample: 2026 forward trades in Nick's leagues, or
   one ledgered look at 2025.
3. Pre-registered P2 had the wrong expected centre (see results §3). The P2b design should be the house null for
   head-to-head "A vs B" disagreement tests.
4. `n_h_weeks` counts weeks with a first kickoff after the trade. Starts in a partly played trade week are credited
   but not counted in the denominator. This scales per-week magnitudes slightly; win rates are unaffected.
5. Sleeper managers are not Nick's ESPN league-mates. Regular season only. Draft-pick trades excluded.
6. Other RL-8-2 row (trade-consensus-gate.js, gate wording in handoff docs): not built here. The gate wording should
   now say the counterparty test **failed** in lineup points for pooled offers.

## 8. Nick's five questions

1. **Well built?**
   - One script with 16 unit tests.
   - Mutation sweep: 10 mutants killed, two fixed tests, one designed survivor, one not-applied control.
   - A reproduction control stops the run unless R8's number rebuilds exactly.
   - A linkage control ties every started point to the weekly lineup table (1,843 of 1,843).
2. **Stats or made up?**
   - Stats: real Sleeper trades and real lineups.
   - Guesses, stated as guesses: the 2-for-1 replacement ranks, and treating public Sleeper managers as a stand-in
     for Nick's league-mates.
3. **How do we know?**
   - The pre-registration was committed before the script (`64684863` < `b43802dd`).
   - Intervals are clustered three ways, and every number has its command.
   - The void and gate rules were applied as written, even where the null turned out mis-specified.
4. **Pointed elsewhere?** Yes. The Trade Machine's first gate should not be "consensus disagreement" for
   multi-player offers. The 1-for-1 lead needs forward confirmation before it can gate anything.
5. **How it unifies:**
   - It reuses R8's curve and the skill study's lineup tables. No new producer, and nothing served.
   - It gives TM-01 a recorded FAIL, with an MDE of 0.068, as its gate status.
