# S-03: apply S-02 to the served weekly construction

Unit S-03 (WORK-QUEUE §5, plan item A2 / Structure). Applies S-02's grade
(`docs/evidence/2026-09-22/weekly-construction-grade.md`). PR #155 was open when this started, so
the branch was cut from S-02's branch at `c9d1acd8`; #155 squash-merged (`51b64512`) while this was
built, and `c45cef64` merges `origin/main` at `a3e2bf35` into this branch (the two S-02 files S-03
edits took S-03's side; main's copies were byte-identical to `c9d1acd8`'s). Pre-registration of the
one new number this unit runs: `docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md`,
committed before any number.

## 1. Audit: extend or build (written before the first test, tree `8321b7c3`)

"This week's points" for one player has 7+ producers (STRUCTURE-MAP D1). The ones this unit's
files feed, and every existing piece it could reuse:

| Existing | file:line on `8321b7c3` | What it does today | Decision |
|---|---|---|---|
| Coordinator read | fantasy-coordinator.js:378-382 `activeFantasyCoordinatorFit` | serves the **latest** `fantasy_coordinator_fits` row (writer `saveFantasyCoordinatorFit`, fantasy-coordinator.js:368-373, INSERT at :370, called by the daily heavy job scheduler.js:1434), gated by nothing. On the local copy the 5 rows (ids 1, 2, 5, 6, 7) all say `through_season` 2025 and 23,334 rows, yet their intercepts are −0.574, −0.423, +0.578, +0.578, −0.555 (command in section 4): the engine changed between refits, and whichever ran last is served | **extend**: serve only a promoted row |
| Promotion pattern | weekly-weight-store.js:34 (`promoted=1`), :174 `promoteWeeklyFitChecked` | the ensemble's own promoted-fit column and checked promotion | **reuse the shape** (a `promoted` column plus a checked promote function), not the code: the ensemble gate grades a candidate against a champion on MAE, which is not this fit's evidence |
| Coordinator base, trade page | trade-engine.js:353-355 | `coordinateFantasy(fit, experts, weeklyPpg)`: a structural-residual fit added to the **ensemble** (arm B) | **replace** with one construction function |
| Coordinator base, player wrapper | fantasy-coordinator.js:565-571 `weeklyProjectionFor` | the same arm B, written a second time | **replace** with the same function (one producer, not two) |
| Fit target | fantasy-coordinator.js:324 (target), :355 (`safeguards.target`) | every fit records "structural-projection residual" | **reuse**: the served base follows the fit's recorded target, so B cannot be built |
| Betting-line lift | waiver-brain.js:162-185 `vegasLift`; callers lineup-brain.js:357, trade-engine.js:2651, waiver-brain.js:202 | full multiplier on Start/Sit, the League Hub card and the waiver horizon | **one switch inside `vegasLift`**; callers untouched. The multiplier's code moves unchanged into `gameScriptLift` so studies can still grade it |
| PR #57 (draft, 5f9c3y) fix 2 | trade-engine.js `coordinatorBase` on its branch | moves the base to structural at the trade-engine call site only | **superseded at the producer**: the base is decided in fantasy-coordinator.js for both call sites. Reported to that thread, not edited |
| Fit watchers | decay-watch.js:63; routes/model.js:550 | read the latest row as "the approved fit" | decay-watch reads the served fit through the one reader (same unit, else it would watch an unserved candidate); routes/model.js is the Wiring map thread's file: reported |
| S-02 study library | scripts/weekly-construction-grade-lib.mjs | the seven arms from the served functions; the ship rule; the guards | **reuse** for the walk-forward grade (new runner, no copy of any arm) |
| Surface label | trade-engine.js:482-494 `out.context` → `model_context` (routes/trades.js:871, trade-engine.js:1818, :2220, :2462); Start/Sit's "Betting market" line (lineup-brain.js:607 → Lineup.tsx:345-347) | no label says what the week number is built from; the Start/Sit card says the market moved the number | **extend** `out.context` and each asset with the construction; the lift's own reading, which Start/Sit already renders, says the lift is off. Per-player chips are S-14 (after S-03) |

Not built here, by design: a second "this week" function (S-01 unifies the pages after this unit);
anything in `ceiling-lineup.js`, `news-fantasy-impact.js`, `season-sim.js` (S-06, S-05); the
combination package the R&D validator rejected (VALIDATOR-LOG round 3 §7).

## 2. RED and GREEN

Command for every test run (targeted, never the whole suite):
`GRIDIRON_DB_PATH=$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap <file>`

| Step | Commit | Result |
|---|---|---|
| docs | `4dec70de` docs: S-03 audit and pre-registration of the walk-forward grade, before any number | the audit (section 1) and the pre-registration, committed before any test or number |
| RED 1 | `a2c36ade` test: the served weekly construction must follow S-02: promoted fit only, fit on its own base, lift off once (RED) | 2 pass, 15 fail on the unchanged code. The defect assertions: `not ok 3 - a structural-residual fit is never added to the ensemble base (arm B is not served)` — `current_week_ppg is the structural-residual fit added to the ensemble: the combination S-02 did not pick`, expected 12.62, actual 12.62, operator notStrictEqual; `not ok 4 - an unpromoted candidate is never served, however new` — expected false, actual true; `not ok 7 - weeklyProjectionFor serves the same construction as the trade page` — expected 11.317, actual 13.717; `not ok 13 - vegasLift is switched off` — expected false, actual true; `not ok 15 - Start/Sit, the waiver horizon and the League Hub card all apply no lift` — expected 10, actual 12; `not ok 16` — actual `'Vegas has ARI in a 51-point game at -7, which the game-script model turns into 20% more volume for a WR.'`. The two passes: the fixture control and the guard that no served module calls `gameScriptLift` (liveness by C3/C4 below) |
| GREEN 1 | `c1b1eca2` feat: serve only a promoted coordinator fit, on its own base, and switch the betting-line lift off once (GREEN) | 17 / 17. Same commit updates the tests that pinned the old behaviour: test/fantasy-coordinator.test.js ("the latest saved fit wins" becomes "the promoted fit is served over a later save"; 8 / 8) and S-02's test/weekly-construction-grade.test.js (its lifted arms read `gameScriptLift`; the served page now equals round2(B); 48 / 48) |
| RED 2 | `aeb196a9` test: the walk-forward grade's fits, parity stop, dumb baseline and per-window rule (RED) | whole file fails: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/weekly-construction-walk-forward-lib.mjs'` |
| GREEN 2 | `153669da` feat: S-03 walk-forward library and runner for the grade of S-02's decision (GREEN) | 9 / 9. **The walk-forward numbers were produced on this commit** (tree `716c0e59`) |
| RED 3 | `71ca6d90` test: a promotion reads its windows from the committed decisions and a reproduced fit (RED) | 9 pass, 2 fail: `not ok 10 - promotionFromEvidence …` — `error: 'wf.promotionFromEvidence is not a function'`; `not ok 11 - refitReproduces …` — `error: 'wf.refitReproduces is not a function'` |
| GREEN 3 | `ab246d93` feat: promote a coordinator fit only on S-03's committed grade and a reproduced fit (GREEN) | 11 / 11; adds scripts/promote-fantasy-coordinator-fit.mjs and the committed walk-forward output |
| refactor | `ebda1e8c` refactor: one definition of the served fit row for both of its readers | 18 / 18 and 8 / 8 |
| test | `1be50f7c` test: decay watch grades a promoted ensemble-residual fit on the ensemble residual | passes on the GREEN code (added after it); liveness by mutant M17 |
| refactor | `a0917685` refactor: keep the base map and window lookup private; the study reads the one window list | 18 / 18, 11 / 11, 8 / 8, 48 / 48; `node scripts/wiring-map.mjs --check` exit 0 on this tree (43 s) |
| docs | `eb39ac85` docs: the lift switch and the model registry cite the walk-forward grade too | text only; 18 / 18, 48 / 48, gridiron-model 12 / 12 (3 skipped) |

Other suites touched by the change, run one file at a time on `c1b1eca2` or later, all green:
lineup-surfaces-agree 2/2, decision-leftovers-lineup 10/10, decay-watch 7/7, lineup-diff-urgency
10/10, ros-projection-wiring 1/1, mlb-removed 5/5, gridiron-model 12/12 (3 skipped: need
history), model-integrity 89/89, nfl-model-fixes 4/4, availability-honest-degradation 8/8,
lineup-floor-objective 3/3, posture-calibration 6/6, start-sit-decision-curve 12/12,
waiver-confidence-is-hand-set 7/7, availability-fit-loader 7/7, ceiling-lineup-recency 6/6,
ceiling-lineup-weekly-agreement 3/3, waiver-kicker-defense 7/7, decision-leftovers-waivers 7/7,
decision-leftovers-home-away 5/5, model-registry-persistence 22/22 (rolls every migration after
029 back and replays them, so 072's `down` and `up` both ran). The full `npm run check` is the Gate
phase's, not run here.

## 3. What it does

- **Only a promoted fit is served.** Migration 072 (additive, named here) adds
  `fantasy_coordinator_fits.promoted` (default 0) and `promotion_json`; no row is promoted by it.
  `activeFantasyCoordinatorFit` returns the promoted row with `fit_row` and `promotion`, or
  `{ready: false}` with the reason ("no promoted fit (5 unpromoted candidates …)"). The daily refit
  still writes candidates (`saveFantasyCoordinatorFit`, now returning the new id).
  `promoteFantasyCoordinatorFit` refuses a missing, unready, other-version or unknown-target fit,
  a malformed or all-off window map, or a missing evidence path, and demotes the previous row in
  the same transaction. `scripts/promote-fantasy-coordinator-fit.mjs` adds the evidence and
  reproduction checks and a `--dry-run`.
- **One construction, on the fit's own base.** `servedWeekConstruction` (fantasy-coordinator.js)
  is the week number before availability for both served producers: trade-engine.js's
  `current_week_ppg` and `weeklyProjectionFor`. The base comes from the fit's recorded target
  (`FIT_TARGETS`): a structural-residual fit on `structural_ppg` (arm S1), an ensemble-residual
  fit on `ppg`. Anything else, or a week outside the promoted windows, serves the ensemble.
  `fitFantasyCoordinator` records the target it was given (`{ target: 'ensemble' }` for a refit on
  the ensemble residual).
- **The asset cache sees a promotion.** `servedCoordinatorFitKey()` is part of trade-engine's
  asset cache key: a promotion is an UPDATE that no row count or stamp shows.
- **One switch for the lift.** `waiver-brain.js#BETTING_LINE_LIFT` (frozen, `on: false`) is read
  only inside `vegasLift`, so Start/Sit, the League Hub card and the waiver horizon apply 1 with
  no edit of their own. The multiplier's code is `gameScriptLift`, unchanged apart from the bare
  `catch {}` it had, which now carries the error on the result. When the market has something
  notable to say, the Start/Sit "Betting market" line says it and says the number leaves it out.
- **The surface label.** `context.week_basis` (served as `model_context` by the roster and trade
  routes) carries the coordinator (fit id, base, windows, evidence), the lift switch and one
  sentence; each asset carries `week_basis` ('structural+coordinator' | 'ensemble+coordinator' |
  'ensemble' | 'season_projection').
- **Consistency edits the change forced.** decay-watch grades the served fit, on the residual its
  target names; the model registry retires `crossover.vegas_to_fantasy`; S-02's runner refuses to
  run against the switched-off chain (a re-run would grade the lift as a multiplier of 1).

## 4. The numbers

All on the local copy, not production (a `.backup` of `~/gridiron-local/data.sqlite`, 19:28 local).
The walk-forward result, with every table, is
`docs/evidence/2026-09-22/weekly-construction-walk-forward.md`; the output file is
`weekly-construction-walk-forward-output.json` (commit `153669da`, tree `716c0e59`).

| Claim | Number | Command / file |
|---|---|---|
| Decision, weeks 2-4 | coordinator on (S1): passes 2023, 2024, 2025; no veto; forward holds | `--walk-forward`, `decisions['2-4']` |
| Decision, weeks 5-17 | coordinator on (S1): passes 2024, 2025; 2023 failed Spearman (−0.0054); forward proxy holds | `decisions['5-17']` |
| Lift, 2023-2024 | fails all four season-windows; MDE80 0.015-0.040 | `seasons.*.windows.*.vs_A.C` |
| Lift, start/sit | right on 52-57% of the calls it changes, six of six season-windows 2023-2025 | section 4 of the result |
| Forward, 2026 W2 | S1 ΔMAE −0.136 [−0.192, −0.079], ΔDNP −0.208 | `forward['2-4']` |
| Promotion of fit 7 on the copy | checks passed; reproduction difference 0; control: fits 1, 2, 5, 6 differ by 0.10-1.13 | promote script; scratch control script (section 7 of the result) |
| Served week 5 = S1 | 1,196 of 1,196 assets; 420 differ from old B (mean 2.11 points) | `weekly-construction-served-identity-w5.json` |
| Served week 3 = S1 = B | 1,196 of 1,196; 0 differ (structural head in weeks 2-4) | `weekly-construction-served-identity-w3.json` |
| Fit intercepts on the copy | −0.574, −0.423, +0.578, +0.578, −0.555 (ids 1, 2, 5, 6, 7) | `sqlite3 .local-db/data.sqlite "SELECT id, json_extract(fit_json,'$.coefficients[0]') FROM fantasy_coordinator_fits"` |

Configuration (rule 3): `buildPlayerWeekEngine`, `WEEKLY_ROLE_RECENCY`, no `kOverride`; k control
0.4605 / 0.2747 / 0.1733 for predicting 2023 / 2024 / 2026, not 6. Held-out season: none new (2025
enters only as S-02's committed verdict; 2023-2024 are walk-forward seasons, in-sample for the
ensemble weights). Intervals: player-clustered 90% bootstrap. Sign conventions in the result file.

## 5. Mutation sweep

Runner: a versioned local copy of the handoff's `mutate-run-v1.sh` (scratchpad
`s03-mut/mutate-run-s03-v1.sh`, the shared script not edited): a detached worktree of the sha,
each anchor applied only if it occurs exactly once, the tests run, the file reverted.
Sha `1be50f7c` (tree `77a77842`). Tests: served-weekly-construction, fantasy-coordinator,
weekly-construction-walk-forward. **Baseline 37 pass, 0 fail.**

| Id | Mutant | Expect | Result |
|---|---|---|---|
| M1 | served base = `projection.ppg` whatever the fit's target (arm B back) | KILLED | KILLED, 3 fail |
| M2 | served-row query without `WHERE promoted = 1` (newest row served) | KILLED | KILLED, 5 fail |
| M3 | promotion windows ignored | KILLED | KILLED, 1 fail |
| M4 | lift switch has no effect (`if (true) return market`) | KILLED | KILLED, 3 fail |
| M5 | every fit read as structural | KILLED | KILLED, 4 fail |
| M6 | promotion leaves the previous row promoted | KILLED | KILLED, 1 fail |
| M7 | asset cache key without the served fit | KILLED | KILLED, 1 fail |
| M8 | decay watch reads the newest row again | KILLED | KILLED, 1 fail |
| M9 | label drops "No betting-line boost." | KILLED | KILLED, 1 fail |
| M10 | Start/Sit reading returns the old "N% more volume" sentence | KILLED | KILLED, 1 fail |
| M11 | promotion skips the known-target check | KILLED | KILLED, 1 fail |
| M12 | walk-forward rule ignores a veto | KILLED | KILLED, 1 fail |
| M13 | walk-forward rule can turn the lift on | KILLED | KILLED, 1 fail |
| M14 | parity accepts arm B as the served number | KILLED | KILLED, 1 fail |
| M15 | evidence for another fit id promotes this one | KILLED | KILLED, 1 fail |
| M16 | a fit that does not reproduce is accepted | KILLED | KILLED, 1 fail |
| M17 | decay watch grades an ensemble fit on the structural residual | KILLED | KILLED, 1 fail |
| C1 | call site: trade-engine forces both windows on | KILLED | KILLED, 1 fail |
| C2 | call site: trade-engine ignores the construction (`currentWeekBasePpg = weeklyPpg`) | KILLED | KILLED, 3 fail |
| C3 | call site: lineup-brain imports `gameScriptLift as vegasLift` (Start/Sit routes around the switch) | KILLED | KILLED, 2 fail |
| C4 | call site: trade-engine imports `gameScriptLift as vegasLift` (League Hub card) | KILLED | KILLED, 2 fail |
| C5 | call site: `horizonValueWithVegas` calls `gameScriptLift` | KILLED | KILLED, 1 fail |
| C6 | call site: `weeklyProjectionFor` passes both windows off | KILLED | KILLED, 1 fail |
| C7 | call site: the label is handed a lift state other than the switch | KILLED | KILLED, 1 fail |
| S1 | designed survivor: comment-only edit in fantasy-coordinator.js | SURVIVED | SURVIVED, 37 / 37 |
| N1 | designed not-applied control: anchor absent from the file | NOT-APPLIED | NOT-APPLIED (anchor matched 0 times) |

Second sweep, S-02's updated test file (`test/weekly-construction-grade.test.js`, baseline 48 / 0):
M4b (lift switch has no effect) KILLED, 6 fail; S2 comment-only SURVIVED; M18 absent anchor
NOT-APPLIED. So the updated S-02 assertions ("the served page no longer carries the lift") are live.

Not swept: `scripts/promote-fantasy-coordinator-fit.mjs`'s own call into the library (the script has
no unit test). Its checks were exercised on the copy instead: `--dry-run` on fit 7 passed; fit 6 was
refused ("the evidence's forward check cleared fit 7, not fit 6"); the reproduction check's
known-nonzero control is section 4.

## 6. Known defects and what this does not cover

- **S-02 amendment 1 is not followed.** Amendment 1 §2 says S-03 must not remove the lift, move the
  coordinator's base or change its level on pre-availability verdicts, and names a joint
  served-chain grade (S-02, S-04, A-11, to be ratified in an amendment 2 before any number) as S-03's
  decision grade. That grade has not been specified; S-04 and A-11 have not landed. This unit
  followed the coordinator's instruction (the R&D validator: switch the lift off once at
  vegasLift) and its own pre-registered walk-forward, and argues in the pre-registration §8 that
  the construction is graded given he plays because the chance to play is a separate factor
  (two-part model). **The Independent Auditor rules on this before merge.**
- **The weeks 5-17 choice of S1 over S2 is not a measured difference** (result §1 item 4): B, D and
  S2 beat S1 on MAE in 2023-2024 (in-sample ensemble weights help them), S1 and B tie in 2025, and S1
  wins against fit-2's ensemble. Follow-up below.
- **The coordinator's pass is an MAE (median) pass.** On squared error it is neutral in weeks 5-17,
  and S1 reads low on the mean (result §5). A-11 sets the level target.
- **Switching the lift off costs 0.07-0.43 percentage points of start/sit pair accuracy** (result §1
  item 3). The ship rule is on accuracy; a ranking-only lift is the follow-up.
- **The served chain still multiplies by the pooled chance to play** on the copy (S-04), so the page's
  level for starters stays low whatever the construction.
- **Production:** migration 072 leaves every existing row unpromoted, so after deploy the coordinator
  is off (the ensemble is served, labelled) until a fit is promoted there. The committed evidence names
  fit 7 on the local data; production's fit ids and rows differ, so production needs its own forward
  check before a promotion. Nobody deploys without Nick (standing rule 13).
- **The local live app** (`~/gridiron-local/data.sqlite`, the copy's source): after this merges and the
  server restarts, the coordinator is off until the one command below is run on that database. Not
  run by this unit (it never touches the live database).
- **Weeks 1 and 18** were not graded; they follow the adjacent window, and the label says so.
- **S-02's runner** now refuses to run (a re-run would grade the lift as a multiplier of 1); its
  forward role is `scripts/weekly-construction-walk-forward.mjs --forward-only`.
- **Stale text left in other threads' files** (reported, not edited): lineup-brain.js:348
  (`startSitWeekPoints`'s doc says it multiplies by the betting-line multiplier; the code is right, the
  multiplier is 1); test/lineup-surfaces-agree.test.js:93 ("The lift is really in play" — the swap it
  asserts happens without the lift too); scheduler.js:1435 job label ("walk-forward validated" — a refit
  is now an unpromoted candidate); routes/model.js:550 `/setup-status` counts any fit row as set up, not a
  promoted one.

## 7. Operational step (Nick or the coordinator, after merge; not run by this unit)

On the local live database, once the server has restarted on the merged code (it runs migration 072
at boot):

```
GRIDIRON_DB_PATH=~/gridiron-local/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/promote-fantasy-coordinator-fit.mjs --id 7 \
  --evidence docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json --dry-run
# then the same without --dry-run
```

It writes nothing unless the evidence is committed, names fit 7, and fit 7 reproduces from that
database with the engine as it is then (on the copy: difference 0). Rollback: promote another graded
fit, or `UPDATE fantasy_coordinator_fits SET promoted = 0` (the coordinator is then off, labelled).

## 8. Nick's five questions

1. **Well built?** Yes, with the caveats in section 6. One construction function now feeds both served
   producers (the old two copies both built arm B); the base follows the fit's own recorded target, so
   the ungraded combination cannot be built; one switch controls the lift for all three callers; only a
   promoted fit is served, and promotion checks the grade and re-derives the fit. 24 of 24 real mutants
   killed, including 7 call-site mutants.
2. **Stats or made up?** Stats, with named hand-set parts. The decision comes from S-02's pre-registered
   grade (2025) plus this unit's pre-registered walk-forward (2023, 2024) and a one-week forward check.
   Hand-set and said so: the 2-of-3 rule and the veto (pre-registered, not fitted), the window edges
   (S-02's), and the lift's old RB split (now unused).
3. **How we know:** backtest, walk-forward. Seasons 2023 and 2024 with fits ending before each, plus
   S-02's 2025; metric = ΔMAE with a player-clustered 90% CI, ΔSpearman, ΔDNP-MAE (matchups.js:33-35),
   plus start/sit win rates and pair accuracy. S1: weeks 2-4 −0.213 / −0.145 / −0.261; weeks 5-17
   −0.052 (Spearman fail) / −0.053 / −0.071. Lift: never significantly better, MDE80 0.015-0.040.
   Forward 2026 W2: −0.136. Local copy, not production.
4. **Pointed anywhere else?** Yes: `current_week_ppg` feeds Start/Sit, the League Hub card, the matchup
   card, the waiver board and the TradeCard pill; with the lift off they now show one number per player
   (checked on 1,196 assets at weeks 5 and 3). `weeklyProjectionFor` feeds `/players/:id` and the draft
   assistant. decay-watch and the model registry now describe the served fit and the retired lift. Not
   yet pointed: per-player provenance chips on the pages (S-14), the served-vs-consensus check (HX-01).
5. **How it unifies:** one construction (`servedWeekConstruction`), one lift switch (`vegasLift`), one
   served-fit reader (`activeFantasyCoordinatorFit`, used by the trade page, the player wrapper and
   decay-watch), one window list (`CONSTRUCTION_WINDOWS`, used by the service and the study). S-01 then
   unifies the pages on top of it. No eighth producer: the change replaced two copies with one.

Defect fixed: trade-engine.js:353-355 and fantasy-coordinator.js:565-571 on `8321b7c3` added a
structural-residual fit to the ensemble; fantasy-coordinator.js:378-382 served the newest row; the lift
applied at full strength at lineup-brain.js:357, trade-engine.js:2651, waiver-brain.js:202. Incumbent:
arm D, B × lift, then × p (S-02 result §2 and §9a; `--consumer-parity` reproduced it on 1,196 assets). Not covered: availability,
the level target, production promotion, weeks 1 and 18. What would make it wrong: the result file's
section 10.

## 9. Named follow-ups

- **S1 vs S2, weeks 5-17, forward:** pre-register a comparison on 2026 weeks 5-8 (the only unbiased
  seasons left for that question), run with `--forward-only` each week.
- **Ranking-only (mean-preserving) lift:** pre-register on 2026 weeks 5-17 forward; start/sit pair
  accuracy as the metric; the 2023-2025 evidence (52-57% of changed calls) motivates it.
- **HX-01 consensus arm:** the served number (S1 × p) against public consensus projections; this unit
  depends on it for the served-vs-consensus check.
- **Amendment 1 §4 joint served-chain grade** (S-02, S-04, A-11), once S-04 serves the role
  availability model and A-11 sets the level target.
- **PR #57 fix 2** (coordinatorBase in trade-engine.js) is superseded by this unit's producer-level
  base; that thread should drop it rather than merge a second definition.
- **Production promotion:** a forward check on a production copy, then the promote script there.

## 10. Statistics contract checklist (`docs/evidence/STATS-METHOD.md`)

The contract (S-00, #154) merged after this unit's result commit; it arrived on this branch with
the merge `c45cef64`.

1. Pre-registration `4dec70de` is an ancestor of the result commits `153669da` (numbers) and
   `ab246d93` (output file). It states the hypothesis, metric and sign convention, split, incumbent
   and dumb baseline, ship rule with the forward check, MDE reporting, configuration and literature.
2. Ledger rows: no 2025 row was read, so no `L` row. The 2026 week-2 forward looks are `F018`-`F021` (`F001`-`F004` on the branch, renumbered at merge)
   in `docs/evidence/HOLDOUT-LEDGER.md` ("2026 forward looks"), added in the first commit that has the
   ledger, not the result commit (the ledger did not exist on this branch then). S-02's own look at
   that week has no row; F018's note says so.
3. Not a feature-lift (`FL`) result: nothing here is graded on 2025, so no BH verdict applies.
4. Every decline carries its MDE at 80% power (result §3: the lift 0.015-0.040; S1 2023 weeks 5-17
   failed Spearman, MAE MDE 0.039).
5. Forward check on 2026: F018, holds; weeks 5-17 on the weeks 2-4 rows as a proxy, said so.
6. Decision win rate against the dumb baseline (season average to date): result §4.
7. Replay configuration: the live engine, `WEEKLY_ROLE_RECENCY`, no `kOverride`; k control 0.4605 /
   0.2747 / 0.1733, not 6.
8. Command and tree beside every number: section 4 and the result file's header and §9.
