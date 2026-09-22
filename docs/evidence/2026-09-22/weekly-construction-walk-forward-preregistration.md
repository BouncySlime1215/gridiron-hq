# S-03 pre-registration: walk-forward grade of S-02's decision before it is served

Locked before any number in this unit is run. Written 2026-09-22 on tree `8321b7c3` (commit
`c9d1acd8`, S-02's branch `claude/local-s-02-weekly-construction-grade`; S-03 is stacked on it
because PR #155 has not merged). Every `file:line` is on that tree unless stated.

## 1. The question

S-02 graded the weekly construction on one held-out season (2025) and picked, in both windows
(weeks 2-4 and 5-17), **S1**: the coordinator correction added to the structural head, with **no
betting-line lift** (`weekly-construction-grade-output.json`, `decisions`). Nick's rule (e): a
start/sit-facing claim is graded on multiple past seasons by walk-forward as-of replay before it
is served, and one season is not a verdict.

Question: does S-02's decision hold on **2023 and 2024**, each graded with coordinator fits that
end before it? The answer decides which fit S-03 promotes and in which weeks the coordinator is
served.

## 2. What is already known before this run (disclosed, so the rule is not written around it)

- S-02, 2025 held out: S1 passes against A in both windows; B, D and S2 pass; the lift arm C and
  S3 fail in both windows. Forward (2026 week 2): S1 = B there, ΔMAE −0.135, ΔDNP −0.207.
- S-02's 2024 fit split (coordinator fits ≤ 2023) already produced, for 2024: A's and C's MAE
  (λ grid: weeks 5-17 A 4.3807 vs C 4.3880; weeks 2-4 A 4.5260 vs C 4.5150), m0 of every arm,
  and the signed error of A, B, D and S1 by projection band (`weekly-construction-level-bands-2024.json`).
  **No 2024 ΔMAE interval, Spearman change or DNP-included metric for S1 against A exists.**
  2023 has never been graded by S-02.
- Amendment 1 §4 records that the wiring audit found, on 2024, on the served chain with the
  pooled chance to play, that the lift passes and the coordinator fails. This grade does not use
  the chance to play (section 8 says why, and what that leaves open).
- 2026 weeks with actuals on the copy: 1 and 2 (`player_week_usage`). Week 2 is the only forward
  week with a prior week; S-02 has already looked at it.

## 3. Arms

S-02's `constructArms` (scripts/weekly-construction-grade-lib.mjs), unchanged: A (ensemble
`proj.ppg`), B (coordinator on the ensemble base), C (A × lift), D (B × lift), S1 (coordinator on
the structural head), S2 (a refit on the ensemble residual, on the ensemble base). S3 is not
graded: with no λ fit for 2023 it would equal C.

- The lift multiplier for C and D is `gameScriptLift` (waiver-brain.js, added by S-03): the exact
  code `vegasLift` ran before S-03 put the served switch in front of it. The served `vegasLift`
  is switched off by S-03, so the study must read the multiplier itself.
- Fits for graded season s: `fitS = fitFantasyCoordinator(buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: s − 1 }))`;
  `fitE` = the same examples with the target moved to the ensemble residual
  (`retargetToEnsembleResidual`), labelled with the ensemble target. 2023 is graded with fits on
  2022 alone; 2024 with fits on 2022-2023. Examples cannot start earlier: the k control for
  predicting 2021 returns null (the engine would run the hand-picked K.share = 6), so 2021
  examples would break rule 3.

## 4. Configuration (rule 3)

- Engine: `buildPlayerWeekEngine` (the live path), `roleRecency: WEEKLY_ROLE_RECENCY` hardcoded at
  player-week-engine.js:273, no `kOverride`.
- k control, a stop condition: `activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason })` for
  2023, 2024 and 2026 must be non-null with `target_share.ALL !== 6`. (A configuration probe on
  the copy read 0.4605 / 0.2747 / 0.1733; it is a check that the run may start, not a metric.)
- Ensemble weights: `activeWeeklyWeightSet` gives `frozen-2023` (weekly-weight-store.js) for
  every 2023 and 2024 week: fit on 2023, selected on 2024. **So A, B, C, D and S2 are in-sample
  for their ensemble weights in both graded seasons, and S1 is not** (its base is the structural
  head; the ensemble reaches it only through the `ensemble_shift` expert). The bias runs toward
  A and against S1, the arm under test.
- Scoring PPR for every arm and the truth. Population and truth exactly as S-02 prereg §4
  (weekly-backtest.js rules: QB/RB/WR/TE with at least one played week before w; played rows for
  MAE and Spearman; decision rows, played week w−1, for DNP-included MAE with a DNP as 0).
- No availability, no bye term, `thisGame.mult` = 1: the construction, as S-02 graded it.
- Data: a `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken 2026-09-22 19:28 local.
  Every result is labelled "local copy, not production".

## 5. Metrics and sign conventions

S-02 prereg §6, unchanged: signed error = prediction − actual (negative = reads low); ΔMAE =
MAE(arm) − MAE(A), negative = arm better, 90% CI from `pairedBootstrapDiff` clustered on player,
2,000 iterations, seed 1; ΔSpearman positive = arm better; ΔDNP-MAE negative = arm better;
decision win rate against "start the higher A projection" on the pairs where the two disagree
(rate − 0.5 positive = the arm's calls are better, clustered on week|position); start/sit pair
accuracy on one common pair set (same week and position, every arm ≥ 4); MDE at 80% power
= 2.487 × SE for every non-pass (Nick's rule c).

Report-only additions (no rule attached):

- **Dumb baseline (Nick's rule d):** decision win rate of S1, A and D against "start the player
  with the higher season average to date" (his mean PPR points over his played weeks before w),
  each on its own pair set where both projections are ≥ 4.
- **Level target (for WQ A-11):** mean signed error and mean squared error per arm, with the
  ΔMSE of S1 against A (same bootstrap). MAE is minimised by the median of the outcome and
  squared error by the mean (Gneiting 2011), so an arm can pass on MAE by moving toward the median.
- **Starter-proxy level bands** for A, S1 and D (amendment 1 §3.2's method, `levelBands`).

## 6. Decision rule, per window (weeks 2-4, weeks 5-17)

- **Pass(s)** = S-02's ship rule (matchups.js:33-35, `shipVerdict`) for S1 against A in season s:
  ΔMAE 90% CI entirely below 0, ΔSpearman ≥ −0.002, ΔDNP-MAE ≤ 0.
- **Veto(s)** = S1's ΔMAE 90% CI entirely **above** 0 (significantly worse than A).
- **The coordinator is served in window w** (construction S1) if and only if:
  1. Pass holds in at least 2 of the 3 seasons {2023, 2024, 2025}, with 2025 counted from S-02's
     committed verdict (not re-run); and
  2. no Veto in 2023 or 2024; and
  3. the forward check holds: on the 2026 weeks with actuals and a prior week, S1 **built by the
     served code** (`servedWeekConstruction`, with the stored fit S-03 will promote) has ΔMAE ≤ 0
     and ΔDNP-MAE ≤ 0 against A (point estimates). Weeks 5-17 use the weeks 2-4 rows as a proxy,
     as S-02 §7.5 did, and say so.
- Otherwise **the coordinator is off in window w**: the served number is A, labelled
  "coordinator off: not confirmed historically" (or "unconfirmed forward" if only item 3 fails).
- **The lift is off in both windows.** It failed its pre-registered rule in S-02 (2025), and
  Nick's rule (b) ships a model component ON only if it passes its pre-registered rule. This grade
  reports C in every season but cannot turn the lift on. If C passes in both 2023 and 2024 in a
  window, the result says the failure was 2025-specific there and names a new pre-registration as
  the follow-up; nothing served changes in this unit.
- Weeks 1 and 18 are in neither graded window. Week 1 follows the weeks 2-4 decision and week 18
  the weeks 5-17 decision, and the surface label says they were not graded.
- Multiplicity: 4 new tests of S1 (2 seasons × 2 windows) at one-sided 5%; about 0.2 false passes
  are expected under a true null. Stated, not corrected for.

## 7. Stop conditions (checked before any metric is computed)

1. The k control fails for 2023, 2024 or 2026.
2. A grading fit is not ready, or its examples reach its graded season (`assertFitCutoff`,
   `assertContextCutoff`).
3. **Parity with the served code**, on every graded row: `servedWeekConstruction` given that
   season's structural fit (windows on) equals arm S1 exactly; the served `vegasLift` reports
   `applied: false`; and C = A × `gameScriptLift` multiplier. On the forward rows, S1 also equals
   `weeklyProjectionFor` with the fit to be promoted, once it is promoted on the copy.
4. A window has zero graded rows (known-nonzero control: the smoke run's 2023 week 6).

## 8. Why the construction is graded before availability, and what that leaves open

The page's number is `construction × thisGame.mult × active_probability` (trade-engine.js:359).
That is a two-part model: the chance he plays times his points given that he plays. In a two-part
model each part is estimated and judged on its own rows, and the product is the unconditional
expectation (Cragg 1971; Duan, Manning, Morris & Newhouse 1983). So the construction is graded on
played rows, as S-02 did, and the chance to play is graded and replaced by S-04. Choosing the
construction on the served chain while the chance to play runs the pooled path (which says 0.708
for healthy starters who played 94.5% of the time, contingency.js:697-698) would pick whichever
arm offsets that bias, which amendment 1 §4 itself says is not a verdict on the construction.

This departs from amendment 1 §2, which says S-03 must not change the lift, the coordinator's base
or its level on pre-availability verdicts and names the joint served-chain grade (S-02, S-04,
A-11) as S-03's decision grade. That joint grade has not been specified, S-04 and A-11 have not
landed, and the week-5 deadline stands. S-03 records the disagreement for the Independent Auditor
rather than resolving it silently. Left open, and not settled by this grade:

- the level target (median vs mean) for the served number, which is A-11's;
- the chance to play (S-04), and the joint served-chain grade of amendment 1 §4;
- the served number against public consensus projections: the HX-01 harness's consensus arm, which
  is being built now. The final served-vs-consensus check depends on it.

## 9. Literature

Rolling-origin (walk-forward) evaluation over several forecast origins is the standard guard
against a verdict that holds for one origin only (Tashman 2000, *International Journal of
Forecasting* 16:437-450). A second-stage correction is valid only on the base it was trained to
correct (Wolpert 1992, *Neural Networks* 5:241-259), which is why the served base must follow the
fit's own target. The scoring function decides which level a forecast is rewarded for: absolute
error elicits the median, squared error the mean (Gneiting 2011, *JASA* 106:746-762). The
two-part decomposition above is Cragg (1971, *Econometrica* 39:829-844) and Duan et al. (1983,
*Journal of Business & Economic Statistics* 1:115-126). Intervals are a cluster bootstrap over
players (Cameron, Gelbach & Miller 2008, *REStat* 90:414-427), as in S-02.

## 10. Holdout looks

No 2025 row is read by this unit: 2025 enters only as S-02's committed verdict. 2023 and 2024 are
not held-out seasons for the ensemble weights (section 4), and the looks are logged in the result
file's "Holdout looks" section anyway (no `docs/evidence/HOLDOUT-LEDGER.md` on origin/main).
The 2026 week-2 forward rows were first read by S-02; this unit re-reads them through the served
code as a reproduction and a parity check.

## 11. What would make this wrong

- The in-sample ensemble weights (section 4) make A look better than it is in 2023-2024. An S1 pass
  survives that bias; an S1 fail may be the bias.
- The stored fit S-03 promotes (through 2025) is not any fit graded here. The walk-forward grades
  the fitting procedure (fits through s − 1 graded on s); the forward check grades that stored fit
  on 2026 week 2 only.
- MAE rewards the median. If A-11 sets the served level at the mean, the coordinator's pass may not
  carry (section 5 reports the squared-error diagnostic for that reason).
- Availability and the game factor are not in the arms (section 8).
- PPR for every arm, not each league's scoring.
- The lift arms read the engine's team at the cutoff, not `players.team_abbr` (S-02 prereg §11).
