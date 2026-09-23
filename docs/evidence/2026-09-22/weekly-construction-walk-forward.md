# S-03 result: S-02's decision graded walk-forward on 2023 and 2024, and what is served

**Local copy, not production.** A `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken
2026-09-22 19:28 local. Pre-registration: `weekly-construction-walk-forward-preregistration.md`
(commit `4dec70de`, before any number). Numbers in sections 2-6 were produced by
`scripts/weekly-construction-walk-forward.mjs --walk-forward` at commit `153669da` (tree
`716c0e59`), 2026-09-23 00:02-00:04 UTC. Full output: `weekly-construction-walk-forward-output.json`.
Reproduced on the final code tree: the same command on `a0917685` (tree `250be2ac`) wrote an output
identical to the committed one in every field except `tree` and the timestamps.

## 1. The answer

1. **Served (weeks 2-4 and 5-17): S-02's arm S1.** This week's number is the structural projection
   plus the coordinator's correction (fit 7 on the copy, promoted), times this game's factor and
   the chance to play. **No betting-line lift.** The pre-registered rule put the coordinator on in
   both windows:
   - weeks 2-4: S1 passed the ship rule in 2023, 2024 and 2025 (3 of 3);
   - weeks 5-17: S1 passed in 2024 and 2025 (2 of 3). 2023 failed only the Spearman tolerance
     (ΔSpearman −0.0054 against −0.002); its MAE gain was real, −0.052 [−0.078, −0.027];
   - no season had S1 significantly worse than the ensemble (no veto);
   - forward, 2026 week 2 through the served code: ΔMAE −0.136, ΔDNP-MAE −0.208 (weeks 5-17 use
     these weeks 2-4 rows as a proxy, as S-02 did). On those rows S1 = B and S1 − A is a constant
     shift (−0.636 at week 3, ΔSpearman exactly 0), so the proxy measures only a median-ward level
     move and cannot tell S1 from B.
   - **Read addendum 1 (end of file) before this section:** the weeks 5-17 pass is a median result,
     the correction is a near-constant −0.64 points, and the basis for departing from S-02
     amendment 1 is restated there.
2. **The lift failed again, in all four new season-windows.** Its accuracy change against the
   ensemble never had an interval below zero (table in section 3). Each decline would have
   detected a gain of 0.015 to 0.040 points (0.34% to 0.81% of the ensemble's MAE) at 80% power,
   so "no gain" is measured, not underpowered. Off, as S-02 and Nick's rule (b) require.
3. **Switching the lift off costs a little start/sit accuracy.** When the lift changes a start/sit
   call it is right more often than not in all six season-windows graded so far: 0.560 and 0.522
   (2023 weeks 2-4, 5-17), 0.565 and 0.520 (2024), 0.521 and 0.537 (2025, S-02); three of the six
   intervals exclude a coin flip. Across all pairs that is 0.07 to 0.43 percentage points of pair
   accuracy. The ship rule scores the accuracy of the number, which the lift worsens; a lift that
   only reorders players (mean-preserving) is the follow-up, with its own pre-registration.
4. **In weeks 5-17, S1 is not the best arm in 2023-2024, and the rule's choice of S1 over the
   other coordinator arms is not a measured difference.** B, D and S2 have lower MAE than S1
   there (by 0.007 to 0.042), and S1 ranks slightly worse than the ensemble (start/sit win rate
   against A 0.490 and 0.491, intervals crossing 0.5). Choosing S1 in weeks 5-17 does not make
   start/sit calls better in 2023-2024: its pair accuracy is below A's and D's in both seasons
   (section 4). The ensemble's weights are in-sample in both seasons (fit on 2023, selected on
   2024). Guess, not measured: that bias helps the ensemble-based arms more than S1 (S1's
   coordinator also reads ensemble_shift built from those weights, a small channel). In 2025, with those weights out of sample, S1 and B tie (S-02: 0.0007 apart). For 2026
   weeks 5-17 the served ensemble is fit-2's vector, and against that base S1 beat B by 0.06 in
   S-02's sensitivity run even though fit-2 was fitted on 2025 (which favours B). Guess: S1 is the
   steadier base for 2026. In any case S1 against S2 in weeks 5-17 needs its own forward grade (2026
   weeks 5-8), named below.
5. **The coordinator's weeks 5-17 pass is a median result.** S1 reads low on the mean in every
   season (played rows, weeks 5-17: −0.33, −0.70, −0.41 for 2023, 2024, 2025) and for the
   starter proxy in 2024 (−0.83 [−1.28, −0.38]). On squared error, which rewards the mean, S1 and
   the ensemble cannot be told apart in weeks 5-17 (ΔMSE −0.18 [−0.55, +0.20] in 2023, +0.24
   [−0.16, +0.63] in 2024). In weeks 2-4 S1 wins on both (ΔMSE −2.86, −2.17). Whether served
   numbers aim at the median or the mean is WQ A-11's decision.

Sign conventions (S-02's): ΔMAE, ΔMSE, ΔDNP-MAE = arm − ensemble (A), negative = arm better.
Signed error = prediction − actual, negative = reads low. Win rate − 0.5 positive = the arm's
start/sit calls beat "start the higher A projection".

## 2. The rule, window by window (prereg §6)

| Window | S1 passes | Veto | Forward (2026 W2) | Decision | Lift |
|---|---|---|---|---|---|
| 2-4 | 2023, 2024, 2025 (3 of 3) | none | ΔMAE −0.136, ΔDNP −0.208: holds | **coordinator on (S1)** | off (C failed 2023, 2024, 2025) |
| 5-17 | 2024, 2025 (2 of 3); 2023 failed Spearman | none | same rows, as a proxy: holds | **coordinator on (S1)** | off (C failed 2023, 2024, 2025) |

Weeks 1 and 18 were not graded; they follow the adjacent window and the surface label says so.
Multiplicity: 4 new tests of S1, about 0.2 false passes expected by chance; the 3 passes have
intervals ending at −0.024 or lower.

## 3. Arms against the ensemble, walk-forward seasons

Fits for 2023 end at 2022 (5,749 examples); fits for 2024 end at 2023 (11,513). Coordinator k
control passed: target_share k 0.4605 (2023), 0.2747 (2024), 0.1733 (2026), not 6. Ensemble
weights `frozen-2023` in every 2023-2024 week, `fit-2` in 2026.

**2023, weeks 5-17** (4,055 played rows, 4,194 decision rows):

| Arm | MAE | Signed error | Spearman | ΔMAE [90% CI] | MDE80 | ΔSpearman | ΔDNP | Rule |
|---|---|---|---|---|---|---|---|---|
| A | 4.2631 | +0.045 | 0.6946 | — | — | — | — | — |
| B | 4.1739 | −0.569 | 0.6945 | −0.0894 [−0.1060, −0.0724] | 0.025 | −0.0001 | −0.1913 | pass |
| C (lift) | 4.2596 | +0.035 | 0.6947 | −0.0035 [−0.0154, +0.0086] | 0.018 | +0.0001 | −0.0144 | fail |
| D | 4.1701 | −0.576 | 0.6949 | −0.0931 [−0.1129, −0.0732] | 0.030 | +0.0003 | −0.2049 | pass |
| S1 | 4.2120 | −0.330 | 0.6892 | −0.0517 [−0.0778, −0.0266] | 0.039 | **−0.0054** | −0.0833 | **fail (Spearman)** |
| S2 | 4.1829 | −0.458 | 0.6946 | −0.0804 [−0.0943, −0.0665] | 0.021 | +0.0000 | −0.1630 | pass |

**2024, weeks 5-17** (4,082 played, 4,189 decision):

| Arm | MAE | Signed error | Spearman | ΔMAE [90% CI] | MDE80 | ΔSpearman | ΔDNP | Rule |
|---|---|---|---|---|---|---|---|---|
| A | 4.3807 | −0.205 | 0.7073 | — | — | — | — | — |
| B | 4.3166 | −0.873 | 0.7073 | −0.0641 [−0.0816, −0.0463] | 0.027 | +0.0000 | −0.1800 | pass |
| C (lift) | 4.3880 | −0.112 | 0.7068 | +0.0075 [−0.0024, +0.0172] | 0.015 | −0.0005 | +0.0059 | fail |
| D | 4.3159 | −0.786 | 0.7069 | −0.0645 [−0.0822, −0.0471] | 0.027 | −0.0004 | −0.1810 | pass |
| S1 | 4.3277 | −0.699 | 0.7056 | −0.0529 [−0.0812, −0.0236] | 0.044 | −0.0017 | −0.1070 | pass |
| S2 | 4.3209 | −0.699 | 0.7073 | −0.0598 [−0.0727, −0.0466] | 0.020 | +0.0000 | −0.1449 | pass |

**Weeks 2-4** (2023: 910 played, 1,012 decision; 2024: 929, 1,047):

| Arm | 2023 ΔMAE [90% CI] | 2023 ΔSpearman | 2024 ΔMAE [90% CI] | 2024 ΔSpearman | Rule 2023 / 2024 |
|---|---|---|---|---|---|
| B | −0.0585 [−0.0898, −0.0267] | −0.0002 | −0.0631 [−0.0947, −0.0322] | +0.0000 | pass / pass |
| C (lift) | −0.0129 [−0.0396, +0.0133] | +0.0014 | −0.0106 [−0.0301, +0.0092] | +0.0018 | fail / fail |
| D | −0.0776 [−0.1167, −0.0385] | +0.0015 | −0.0701 [−0.1052, −0.0333] | +0.0021 | pass / pass |
| S1 | −0.2127 [−0.3016, −0.1219] | +0.0235 | −0.1453 [−0.2285, −0.0552] | +0.0105 | pass / pass |
| S2 | −0.0542 [−0.0801, −0.0278] | +0.0000 | −0.0625 [−0.0859, −0.0389] | +0.0000 | pass / pass |

Lift declines and their MDE80 (points, % of A's MAE): 2023 2-4 0.040 (0.81%), 2023 5-17 0.018
(0.43%), 2024 2-4 0.030 (0.66%), 2024 5-17 0.015 (0.34%). By position, weeks 5-17, 2024: the
lift helps RBs (−0.017 [−0.031, −0.001]) and hurts WRs (+0.025 [+0.011, +0.039]), S-02's 2025
pattern again; in 2023 no position's interval excludes 0.

## 4. Start/sit decisions (Nick's rule d)

Common pair set per window: same week and position, every arm projects both players at 4 or
more, DNP = 0. Win rate counts only the pairs where the arm and A disagree.

| | 2023 2-4 | 2023 5-17 | 2024 2-4 | 2024 5-17 |
|---|---|---|---|---|
| Pairs | 19,436 | 68,346 | 16,706 | 67,586 |
| Pair accuracy A / C / D / S1 | 0.6264 / 0.6307 / 0.6302 / 0.6434 | 0.6382 / 0.6397 / 0.6395 / 0.6367 | 0.6142 / 0.6183 / 0.6180 / 0.6159 | 0.6365 / 0.6376 / 0.6377 / 0.6351 |
| C (lift) win rate, disagreements (interval on rate − 0.5) | 0.560 on 730 [+0.023, +0.085] | 0.522 on 2,223 [−0.008, +0.052] | 0.565 on 533 [+0.034, +0.090] | 0.520 on 1,876 [−0.010, +0.049] |
| S1 win rate, disagreements (interval on rate − 0.5) | 0.563 on 2,609 [+0.022, +0.099] | 0.490 on 4,928 [−0.030, +0.009] | 0.506 on 2,388 [−0.035, +0.047] | 0.491 on 5,503 [−0.024, +0.008] |
| B: disagreements with A | 1 | 1 | 0 | 0 |

Against the dumb rule "start the higher season average to date" (each on its own pair set, both
projections ≥ 4): S1 wins 0.569 / 0.531 / 0.555 / 0.538 of its disagreements, A 0.611 / 0.554 /
0.612 / 0.554, D 0.625 / 0.554 / 0.619 / 0.558 (same column order; every interval above 0). Every
construction beats the dumb rule; the ensemble-based ones by more, in seasons where their
weights are in-sample. The comparison that matters to a user, the served number against public
consensus projections, is the HX-01 harness's consensus arm, which is being built; this unit
depends on it for that check.

## 5. Level

Signed error (mean, player-clustered 90% CI), weeks 5-17:

| Row set | 2023 A | 2023 S1 | 2023 D | 2024 A | 2024 S1 | 2024 D |
|---|---|---|---|---|---|---|
| Played, all | +0.045 [−0.101, +0.198] | −0.330 [−0.487, −0.161] | −0.576 | −0.205 [−0.358, −0.042] | −0.699 [−0.878, −0.528] | −0.786 |
| Played, A ≥ 10 | +0.469 | −0.300 | −0.081 | +0.087 | −0.783 | −0.374 |
| Starters, played | +0.655 [+0.283, +1.027] | −0.244 [−0.652, +0.159] | +0.161 | +0.225 [−0.189, +0.645] | −0.826 [−1.277, −0.383] | −0.201 |
| Starters, DNP counted | +2.282 | +1.406 | +1.766 | +1.930 | +0.896 | +1.470 |

(2024 starter figures reproduce S-02's `weekly-construction-level-bands-2024.json`: A +0.225,
S1 −0.826.) Squared error, S1 against A: weeks 5-17 −0.18 [−0.55, +0.20] (2023) and +0.24
[−0.16, +0.63] (2024); weeks 2-4 −2.86 [−4.44, −1.24] and −2.17 [−3.54, −0.84]. The lift on
squared error: no interval excludes 0 in any window.

## 6. Forward: 2026 week 2 through the served code

Fit 7 (through 2025, intercept −0.555, ensemble_shift k 0.066, game_script k 0.041), 304 played
and 360 decision rows, every row's served construction equal to arm S1. S1 = B on these rows
(the copy serves the structural head in weeks 2-4, fit-2's early rule): ΔMAE −0.136
[−0.192, −0.079], ΔDNP −0.208 [−0.259, −0.157]. S-02 read the same week as −0.1353 / −0.2074 on a
copy three hours older; guess: the difference is the newer copy. The lift arm C: −0.030 [−0.069, +0.007].
The old served construction D (B × lift) read −0.166 [−0.225, −0.102] on the same rows: 0.030 better
than S1 on this one week, which is the lift's −0.030. One week is an anecdote under Nick's rule (e);
the lift failed in every graded season-window (2023, 2024, 2025, both windows).

## 7. What is served on the copy after the promotion

Migration 072 applied to the copy, then `scripts/promote-fantasy-coordinator-fit.mjs --id 7`
(checks passed: committed evidence `ab246d93`, sha256 `28e67bf2…`; the stored fit reproduces from
the copy with today's engine, max coefficient difference 0; control: the same refit differs from
stored fits 1, 2, 5 and 6 by 0.10 to 1.13, so the check can fail). Then `--served-identity` on
`eb39ac85` (tree `161e3402`), output `weekly-construction-served-identity-w5.json` / `-w3.json`:

| Week | Assets checked | Coordinator applied | current_week_ppg = S1 × factor × p | Start/Sit = current_week_ppg | weeklyProjectionFor = served | S1 ≠ old B |
|---|---|---|---|---|---|---|
| 5 | 1,196 | 1,196 | 1,196 (492 with a game; 704 no-game assets are 0 = 0) | 1,196 (same split) | all 1,196 | 420 players, mean 2.11, median 1.47, max 10.92 points |
| 3 | 1,196 | 1,196 | 1,196 (522 with a game; 674 no-game) | 1,196 (same split) | all 1,196 | 0 (weeks 2-4 serve the structural head, so S1 = B) |

"S1 ≠ old B" compares the construction before availability. On the page (old B × factor × p × lift
against the new number) the week-5 change is smaller per player: the claims skeptic measured 483 of
the 492 players with a game changing, mean |Δ| 1.18, median 0.60, max 11.86 points; at week 3, 433 of
522 by a mean of 0.12 (max 1.38), all of it the lift removal (their `identity-extended.mjs`, their
copy, tree `8ddebcd8`; not re-run by the builder).

The label on `model_context.week_basis`: "This week's points: our structural projection plus the
coordinator's correction (fit #7), times his chance to play. No betting-line boost." With the lift
off, the Start/Sit number, the League Hub card, the waiver board's `current_week_ppg` and the
TradeCard pill are one number for every player (STRUCTURE-MAP D1 (a)-(d)); before, the first two
carried the lift and the last two did not.

## 8. Holdout looks

Correction (fix round): `docs/evidence/HOLDOUT-LEDGER.md` was already on origin/main
(`dd7cec20`, #154) when this was written; S-03's forward rows F001-F004 are in it (`8ddebcd8`).
No 2025 outcome was graded; the promotion refit and the 2026 engine do read 2025 rows.

| Unit | Date (UTC) | Hypothesis | Metric | Result |
|---|---|---|---|---|
| S-03 | 2026-09-23 00:02-00:04 | S-02's decision (S1 on, lift off) holds on 2023 and 2024, walk-forward | S-02's ship rule per window; ΔMAE player-clustered 90% CI | S1 passes 2023 2-4, 2024 2-4, 2024 5-17; fails 2023 5-17 (Spearman). C fails all four. Not held-out seasons for the ensemble weights (prereg §4). |
| S-03 | same run | forward reproduction, 2026 W2 (first read by S-02) | same | S1 −0.136, holds |
| S-03 | 2026-09-23 00:31-00:41 | reproduction of the 00:02 run on the final code tree `a0917685` | same | identical output (tree and timestamps aside) |

## 9. Commands

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"
GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/weekly-construction-walk-forward.mjs --walk-forward
# the copy only: apply migration 072, then promote with the committed evidence
... node scripts/promote-fantasy-coordinator-fit.mjs --id 7 \
  --evidence docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json [--dry-run]
... node scripts/weekly-construction-walk-forward.mjs --served-identity --week 5 \
  --out docs/evidence/2026-09-22/weekly-construction-served-identity-w5.json
# after week 4 (and each later week): the forward rows through the served code
... node scripts/weekly-construction-walk-forward.mjs --forward-only --out <file>
```

## 10. What would make this wrong

- The ensemble weights are in-sample for 2023-2024. S1's passes survive that bias; S1's weeks
  5-17 fail in 2023 and its loss to B/D/S2 there may be the bias.
- MAE rewards the median. Under a mean target the coordinator is neutral in weeks 5-17 (section 5).
- The arms are the construction before availability. The page multiplies by the chance to play,
  which runs the pooled path on the copy (S-04 replaces it). S-02 amendment 1 §4's joint
  served-chain grade (S-02, S-04, A-11) has not been specified or run.
- The promoted fit is fit 7; the walk-forward grades the fitting procedure, and the forward check
  grades fit 7 on one 2026 week. Production has its own rows and its own fit ids: the evidence
  names fit 7 on this data, so production needs its own forward check before a promotion there.
- One forward week, in the weeks 2-4 regime, stands in for weeks 5-17.
- PPR for every arm; the lift arms read the engine's team at the cutoff.

## Addendum 1 (fix round, 2026-09-23): the basis for the departure, restated

Written after the claims skeptic's review of `8ddebcd8`. The pre-registration
(`weekly-construction-walk-forward-preregistration.md`) is unchanged, byte for byte; this addendum
replaces its §8 as the reason S-03 departs from S-02 amendment 1 §2. Every number below is in the
committed output or the served-identity JSONs; the command is named on each.

1. **Withdrawn: "the product is the unconditional expectation" as the basis.** That identity
   holds when the construction targets the conditional *mean*. The grade is MAE, which rewards the
   *median*, and S1 is not a conditional-mean construction: on played rows, weeks 5-17, its signed
   error is −0.330 (2023) and −0.699 (2024) against the ensemble's +0.045 and −0.205 (section 5;
   `weekly-construction-walk-forward-output.json`, `level_bands`). So §8 does not answer amendment
   1 §4's objection, and it is no longer offered as the answer.
2. **The weeks 5-17 coordinator pass is an MAE (median) result with no measured gain on the
   mean.** S1 against the ensemble on squared error, weeks 5-17: −0.1793 [−0.5517, +0.1986] in
   2023 and +0.2416 [−0.1565, +0.6331] in 2024 (output JSON, `squared_error`). Neither interval
   excludes 0. Weeks 2-4 are different: S1 wins on both MAE and squared error (−2.86 [−4.44,
   −1.24], −2.17 [−3.54, −0.84]), so the objection does not reach that window.
3. **The coordinator's correction is a near-constant of about −0.64 points.** On fit 7, S1 minus
   the structural projection, every coordinated skill asset on the synthetic 12-team PPR universe
   (local copy, not production; `scripts/weekly-construction-walk-forward.mjs --served-identity`
   at `4bbb4628`, field `correction_s1_minus_structural`):
   - week 5: n 1,196, mean −0.6362, SD 0.003, range [−0.645, −0.626], 755 exactly −0.636;
   - week 3: n 1,196, mean −0.636, range [−0.636, −0.635], 1,195 exactly −0.636.
   The claims skeptic measured the same figures independently on their copy. So its MAE verdict is
   a verdict on level, and that level is multiplied on the page by the pooled chance to play, which
   reads 0.708 for healthy starters who played 94.5% of the time (S-02 amendment 1:103-104). That is
   amendment 1 §4's objection, and it stands for weeks 5-17.
4. **The lift removal rests on Nick's rule (b), not on §8.** A model result ships ON only if it
   passes its pre-registered rule and holds forward. The lift (arm C) never passed a
   pre-registered rule: it failed S-02's rule in both 2025 windows and failed again in all four
   2023-2024 season-windows here (section 3). Off is its default.
5. **What ships at merge, and what waits.** Production has no promoted fit, so after merge the
   coordinator is OFF everywhere and every served weekly number is the ensemble, lift off,
   labelled (TDD §7). Promotion is a separate, manual step. The builder's recommendation, for the
   Independent Auditor to rule on before any promotion: weeks 2-4 may be promoted on this grade
   (MAE and squared error agree); weeks 5-17 stay off, labelled "unconfirmed: median-only pass",
   until the joint served-chain grade (S-02 amendment 1 §4; S-04, A-11) or a mean-target decision
   (A-11) says otherwise. The copy's promotion of both windows (section 7) is a demonstration of
   the served path, not a recommendation for production.
