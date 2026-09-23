# AI-01 true value on the opportunity model: DECLINED

Unit AI-01 (plan item A2, Trade Machine). Branch
`claude/local-ai-01-true-value-opportunity`, based on `origin/main` `131a7ba0`.
Every number below: local copy of the app database (not production), made
2026-09-23 with `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"`,
run on commit `0668d250` (script committed, tree clean).

**Verdict: the opportunity-based rest-of-season rate does not beat points-based ROS
(pre-registered rule S1 fails), and it is far worse than the `ros_ppg` the trade card
already serves (S2 fails). `server/services/true-value.js` was not built; nothing is
served; no route, registry entry, table or column was added.** The work-queue row
(`grep -n '^| AI-01 ' WORK-QUEUE.md` returns nothing; the row text came from the
launch task) said "the module serves only if it beats points-based ROS; if not,
record the decline". This file is that record.

## 1. Audit: extend or build

Written before any number, in the pre-registration
(`docs/tdd/2026-09-23-true-value-opportunity.prereg.md`, section "Audit"). Summary:
the trade card already serves a rest-of-season rate, `ros_ppg`
(`server/services/trade-engine.js:389-391,481`, from `buildRosProjections`,
`server/services/ros-projection.js:364`, params `ros-projection.js:71`). xFP lives in
table `nfl_ffopportunity_weekly`, writer `syncFfOpportunity`
(`server/services/ffopportunity.js:45`). No `true-value` producer exists. Decision:
build only on a pass, as an extension beside `ros_ppg`, and only if it is not worse
than `ros_ppg` (one number, one producer).

## 2. Commits

| order | sha | subject | numbers? |
|---|---|---|---|
| 1 | `58c63e48` | docs: pre-register AI-01 true value (opportunity vs points ROS) | none |
| 2 | `0668d250` | test: AI-01 study script, opportunity vs points ROS (pre-registered) | none (code only) |
| 3 | this commit | docs: AI-01 decline record, holdout-ledger rows | all results |

`58c63e48` is an ancestor of the results commit (`git merge-base --is-ancestor 58c63e48 HEAD`, exit 0).

**RED / GREEN: not applicable.** The pre-registered ship rule failed, so no module was
built and there is no behaviour change to test. The acceptance line "RED tests for the
module; a route reaches it" applies only to a shipping module.

## 3. Command

```
cd ~/gridiron-local/wt/AI-01
STUDY_TREE=$(git rev-parse HEAD) SCHEDULER_DISABLED=1 \
  GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite \
  node scripts/study-true-value.mjs --json .local-db/out/all.json > .local-db/out/all.txt
# exit 0, about 80 s; output md5 of the 11 JSON lines e8189478612e939a50187b2bcbcf3c9a,
# identical to the pre-commit run of the same code
```

Sign convention everywhere: **candidate minus incumbent**. MAE: negative favours the
candidate. Pair accuracy: positive favours the candidate. Intervals are 90%,
player-clustered (`player_gsis_id`). MDE80 = 1.512 x the half-width (STATS-METHOD rule 4).

## 4. Results

### 4a. S1, the unit's rule: xFP/game vs season-to-date PPG, 2021-2024 (gated)

Population: QB/RB/WR/TE, >= 3 games through week t, t = 3..13, union top-N by either
arm; 7,536 player-cutoffs, 444 players. Target: next five weeks' points per game played.

| metric | xFP/game | season-to-date PPG | diff (cand - inc) | 90% CI | MDE80 | est / MDE80 |
|---|---|---|---|---|---|---|
| MAE, next-5 PPG | 3.9403 | 4.0012 | -0.0608 | [-0.1376, +0.0171] | 0.117 | 0.52 |
| same-position pair accuracy (182,280 pairs) | 0.6794 | 0.6806 | -0.0012 | [-0.0096, +0.0065] | 0.0122 | 0.10 |
| all-pairs accuracy (reported) | 0.7077 | 0.7069 | +0.0008 | - | - | - |
| same-position pairs, next-5 total with missed games = 0 (reported) | 0.6611 | 0.6619 | -0.0008 | - | - | - |

Per season (MAE diff, 90% CI; pair accuracy cand/inc): 2021 -0.071 [-0.198, +0.055],
0.687/0.693; 2022 -0.061 [-0.203, +0.090], 0.687/0.676; 2023 -0.073 [-0.241, +0.098],
0.667/0.676; 2024 -0.045 [-0.194, +0.112], 0.676/0.678.

**S1 check by check:** MAE CI upper < 0: **FAIL** (+0.0171). Pair-accuracy CI lower > 0:
**FAIL** (-0.0096). MAE point estimate favours xFP in >= 3 of 4 seasons: pass (4 of 4).
**S1 fails.**

Reading it: xFP is a little better on MAE early (t = 3-5: 4.03 vs 4.29, 4.02 vs 4.24,
3.91 vs 4.15) and a little worse late (t = 10-13: e.g. t = 13 3.79 vs 3.70); it is
worse for QBs (4.55 vs 4.28) and better for RB/WR/TE. The MDE says the design could
see a 0.12 PPG MAE gain or a 1.2-point pair-accuracy gain with 80% power; the
estimates are about half and a tenth of that. So this is "no useful effect", not only
"not shown".

**Decision grade (rule 6).** The trade call is "which of two same-position players
scores more". On the 34,626 pairs where xFP and season-to-date PPG disagree, xFP is
right **49.69%** of the time: no better than the dumb baseline.

**Why (luck column, reported).** Season-to-date luck (actual minus xFP per game)
carries into the next five weeks: slope of (next-5 PPG minus xFP) on luck is 0.58 QB,
0.37 RB, 0.39 WR, 0.41 TE. About 40% of "luck" is persistent efficiency, so throwing
all of it away (pure xFP) loses as much as it gains. A shrunk blend is what wins, and
the served `ros_ppg` is already a shrunk blend (4b).

### 4b. S2, one producer: xFP/game vs the served `ros_ppg` formula (2023-2024)

Walk-forward replay of `ros-projection.js` (`selectRosStructure`, 2023 fitted on 2022:
c_mkt, alpha 0.4, k per position QB 1 / RB 6 / WR 5 / TE 8; 2024 fitted on 2023: c_mkt,
alpha 0.4, k 4). Configuration B: `roleRecency: WEEKLY_ROLE_RECENCY`, no `kOverride`;
k control printed fitted share k, none equal to 6 (2022 target_share.ALL 1.0532, 2023
0.4605, 2024 0.2747). t in {4, 6, 8, 10}, 1,345 player-cutoffs, app PPR actuals
(`server/services/backtest.js:26`).

| metric | xFP/game | served ros_ppg | diff | 90% CI | MDE80 |
|---|---|---|---|---|---|
| MAE, next-5 PPG | 4.0113 | 3.6373 | **+0.3746** | [+0.2731, +0.4811] | 0.157 |
| same-position pair accuracy (31,893 pairs) | 0.6604 | 0.6965 | **-0.0362** | [-0.0495, -0.0221] | 0.0207 |
| reported: ros formula with xFP in place of season-to-date PPG | 3.6930 (MAE) / 0.6905 (pair) | 3.6373 / 0.6965 | +0.0555 [+0.0098, +0.1017] / -0.0061 [-0.0136, +0.0008] | | |
| reported: season-to-date PPG on the same rows | 4.0409 / 0.6662 | | | | |

On the 5,225 pairs where xFP and served `ros_ppg` disagree, xFP is right 38.97%.
**S2 fails in both metrics.** The follow-up the pre-registration named ("feed xFP into
`ros-projection.js`") is also answered for now: substituting xFP for the in-season
rate makes the served formula slightly worse (+0.056 MAE, CI excludes 0), so that
follow-up is **not** recommended in that form.

### 4c. FantasyCalc (reported, not gated; 6 Wayback cutoffs, RB/WR/TE)

Rest-of-season total PPR, missed game = 0; 938 player-snapshots, 28,412 same-position
pairs. Files stay local (`~/gridiron-local/rnd/loop/data/r3x_fc_wayback/`); only these
aggregates are committed (FantasyCalc terms as read by R&D,
`rnd/loop/r3-external-fantasycalc-history-gap.md` section 1b).

| arm | pair accuracy |
|---|---|
| FantasyCalc value | 0.7293 |
| season-to-date PPG | 0.6902 |
| xFP/game | 0.6769 |

xFP - FantasyCalc -0.0524 [-0.0729, -0.0348]; xFP - season-to-date -0.0132 [-0.0312,
+0.0055]. **Control:** FantasyCalc - season-to-date +0.0392 [+0.0221, +0.0568]
reproduces R&D's independent Python result +0.0384 [+0.0229, +0.0567] (different
points source: app PPR here, nflverse `stats_player_week` there), which validates the
pair-accuracy and cluster-bootstrap code.

### 4d. Forward rule 5 (2026)

`nfl_ffopportunity_weekly` 2026: 2 weeks (max week 2, 638 rows); `player_week_usage`
2026: 2 weeks, 1,052 rows (writer `syncWeeklyUsage`, `server/services/nflverse.js:245`).
S1 rows for 2026: **0** (needs >= 3 games and five later weeks). Known-nonzero control:
2025 gives 1,891 rows. No outcome was computed on 2026. Recorded as F003 in the ledger.

## 5. Holdout looks (also appended to `docs/evidence/HOLDOUT-LEDGER.md`)

| id | unit | date | hypothesis | metric | result |
|---|---|---|---|---|---|
| L157 | AI-01 | 2026-09-23 | xFP/game beats season-to-date PPG for next-5 PPG (2025, reported, not gated) | MAE, 1,891 player-cutoffs | -0.1763 [-0.3068, -0.0478], favours xFP on 2025 only; MDE80 0.196 |
| L158 | AI-01 | 2026-09-23 | same, same-position pair accuracy | 45,846 pairs | +0.0078 [-0.0061, +0.0227], not significant; MDE80 0.0218; disagreement pairs xFP right 52.2% |
| F003 | AI-01 | 2026-09-23 | rule-5 eligibility check | eligible 2026 cutoffs | 0 rows; no metric computed |

2025 is partly spent (153 prior looks) and was not gated. Its MAE result is the one
place xFP looks better; it does not rescue S1 (gated on 2021-2024) and says nothing
against S2.

## 6. Mutation sweep of the study script (liveness of the measuring code)

Run on the `--fc` arm (about 5 s each), mutant copies under `scripts/.mut-*`, deleted
after each run (`ls scripts/.mut-* | wc -l` = 0).

| mutant | kind | result |
|---|---|---|
| M1 flip the target comparison in `pairList` | unit | KILLED (FantasyCalc 0.7293 -> 0.2707) |
| M2 swap the arguments at the `pairBootDiff(px, pf)` call site | call site | KILLED (xfp - FC sign flips to +0.0524) |
| M3 change the group-key separator `\|` to `/` | designed survivor (equivalent mutant) | SURVIVED, as designed |
| M4 change the S2 cutoff filter while running `--fc` only | not-applied control | SURVIVED (code not reached), as designed |

## 7. One number, one producer

No new number ships, so no new producer exists. Grep for the concept before deciding:
`git grep -n "ros_ppg" -- server/services/trade-engine.js` finds the one served ROS
rate (`:389-391,481`). A pure-xFP true value would have been a second ROS rate; on
the 5,225 pairs where it and `ros_ppg` order two players differently, it is right 38.97%. The luck
concept has one producer already, `server/services/td-regression.js`; this unit added
none.

## 8. Known defects and limits

- Target for S1 is ffopportunity's own actual points (its scoring, close to PPR); S2
  and FantasyCalc use the app's PPR (`backtest.js#actuals`). Directions are the claim;
  no magnitude carries between the two rigs.
- S2 fits the served formula walk-forward with the fit script's procedure; the live
  `ROS_PARAMS` were fitted on 2023-2025, so the live number is not literally what was
  replayed. Walk-forward is the honest version and is what the pre-registration named.
- Pair accuracy's cluster bootstrap weights each pair by the product of multiplicities
  (R&D's method), not a full pair-level resample.
- FantasyCalc: 6 cutoffs, 5 of them superflex; reported only.
- Population filter (union top-N) is a choice; the all-pairs view agrees (+0.0008).
- `rnd/loop/r3-external-fantasycalc-history-gap.md` is local R&D, not in the repo.

## 9. Nick's five questions

1. **Well built?** No module was built, on purpose. The study script is read-only,
   seeded, reproducible (same md5 on the committed tree), and its pair code was
   checked against R&D's independent result and by a four-row mutation sweep.
2. **Stats or made up?** Stats. Every figure above comes from the command in section 3
   on commit `0668d250`, local copy, not production. The MDE guesses in the
   pre-registration were labelled "guess"; the realised MDEs are measured.
3. **How we know.** Walk-forward backtest, 2021-2024, next-5-weeks PPG: MAE -0.061
   [-0.138, +0.017] and pair accuracy -0.001 [-0.010, +0.007] vs season-to-date PPG
   (fails); vs the served `ros_ppg` on 2023-2024: MAE +0.375 [+0.273, +0.481] worse.
4. **Pointed anywhere else?** Nothing new is served. The finding points at
   `ros_ppg` (`trade-engine.js:481`) as the rest-of-season number to keep, and at
   TM-06 / C12 (FantasyCalc disagreement test): FantasyCalc beats season-to-date by
   3.9 pair points and xFP by 5.2 on the 2023-24 snapshots.
5. **How it unifies.** It keeps one rest-of-season number. A second "true value" that
   loses to the number already on the card would have been exactly the hole Nick asked
   us not to create.

Defect or gap: the plan asked for an opportunity-based true value; the gap closes as
"measured, declined". Incumbent by command: `ros_ppg`, `ros-projection.js:364` via
`trade-engine.js:389`. Not covered: availability and schedule terms (moot once the rate
fails), a shrunk xFP-plus-actual blend outside the served formula (not pre-registered;
the luck slopes suggest it would land near what `ros_ppg` already does). What would
make this wrong: an xFP source with a different efficiency model, or a forward 2026
result that reverses the 2021-2024 direction (checkable from about week 8).
