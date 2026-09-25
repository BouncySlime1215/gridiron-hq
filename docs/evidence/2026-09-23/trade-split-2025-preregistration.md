# trade-split-2025: pre-registration (RL-8-2b, one look at 2025)

Unit RL-8-2b (Trade Machine gate, CRITICAL). Date 2026-09-23. Tree: branch
`claude/local-rl-8-2b-trade-split-fresh-test` after merging origin/main `47f214ff`.
Authority: coordinator ruling NICK-2025 (work queue section 12, 2026-09-23T15:43Z): "ONE pre-registered, ledgered
look at Sleeper 2025 trades for the trade-split test (RL-8-2b), prereg committed first; the 2025 holdout is then
marked used for this question."

**Written and committed before the study script exists and before any 2025 trade outcome is computed.** What was
touched on 2025 before this file: row counts only (`trade_sides` 2,642 rows, `sides_ext` 2,494, `sh_transactions`
1,313 complete trades, nflverse `stats_player_week` 18,540 REG rows, ECR parquet 51 weekly scrapes in 2025,
`team_seasons` 5,630 Sleeper rows, all chains non-null). No outcome column was selected. Local data only,
aggregates only, no league or manager names.

What is already known (so the reader can discount it): RL-8-2 (PR #196, `53634d3f`) graded the same question on
2021-24 in lineup points. 2023-24 1-for-1: consensus side won 0.540 of disagreement trades (not a pass); 2-for-1
reversed (0.427 on 2021-22). The split this file tests was formed post hoc from those numbers. RL-9-3 (PR #200)
built the lineup-value-with-roster-spot model (`lineupValue`, `lineupSpan`) with no outcome test.

## 1. Hypotheses

- **(a)** In 2025 Sleeper 1-for-1 trades where consensus ROS value and season-to-date points per game favour
  different sides, the consensus-favoured side gains more rest-of-season starting-lineup points.
- **(b)** In 2025 Sleeper 2-for-1 and 2-for-2 trades, the side the lineup-value-with-roster-spot model favours
  gains more rest-of-season starting-lineup points, on trades where summed consensus does not.

## 2. Data and sample (2025 only for every graded number)

- Source: `sh_transactions` joined to `sh_leagues` (season 2025), `type='trade'`, `status='complete'`,
  exactly 2 rosters, no draft picks, every moved player dropped by the giver (`set(adds) == set(drops)`),
  trade leg week 4-14.
- Shapes: 2 adds split 1/1 (1-for-1), 3 adds split 1/2 (2-for-1), 4 adds split 2/2 (2-for-2). Others dropped.
- Every moved player QB/RB/WR/TE, in the Sleeper-to-GSIS crosswalk, >= 3 games before the week and >= 2 weeks of
  `nfl_ffopportunity_weekly` before it (RL-8-2's `feats`), and on the ECR board for (2025, week).
- Linked to exactly one `trade_sides` row and to `sides_ext` rows for both sides with `n_h_weeks > 0`
  (RL-8-2's linkage, unchanged).
- Arm (b) additionally needs a non-IDP league with known slots (`tr_common.starting_slots`) and both sides'
  rosters at the first horizon week (`sides_ext.w0`) in `sh_team_weeks`; trades failing this are counted and
  left out of (b) only.
- Orientation: side A drawn with `random.Random(7)` (1-for-1), `Random(8)` (2-for-1), `Random(9)` (2-for-2).
  Every win rate below is orientation-invariant.

## 3. Inputs, outcome and sign convention

- **Consensus value** `v(p)`: RL-8-2 unchanged. FantasyPros redraft ECR, latest scrape within 6 days before the
  week's last Sunday, rank bins of 3 mapped to ROS PPR points per game by the position curve fit on 2021-22 only
  (monotone). No 2025 data enters the curve.
- `x_con` (summed consensus, the "offer fair value" baseline): 1-for-1 = v(recv) - v(give); 2-for-1 and 2-for-2 =
  sum of (v - R_pos) received minus given, R_pos = curve at ranks QB 13, RB 30, WR 36, TE 13 (RL-8-2's
  `value_diff`, unchanged). `x_std` = same transform on season-to-date PPG.
- **Lineup-value model** `D_LV = LV(A) - LV(B)`. `LV(side)` is PR #200's `lineupValue` rule replayed on the
  historical roster, per week: best starting lineup (skill slots only: QB, RB, WR, TE, WRRB_FLEX, REC_FLEX,
  FLEX, SUPER_FLEX; greedy fill `tr_common.fill_lineup`) of the post-trade roster with the roster size held,
  minus the same for the pre-trade roster. A side that frees spots fills each from the league's wire (skill
  players on the week's ECR board not on any roster in that league at `w0`): of the best free agent at each
  position, the one that raises the lineup most (ties: higher rate). A side that needs spots drops, for each,
  the player whose loss costs the lineup least (ties: lower rate). Player rate = `v(p)`; a rostered skill player
  with no board value rates 0 (the product's `?? 0`). Rosters: post = `sh_team_weeks` at `w0`, pre = post -
  received + given (tr_01's frozen-roster construction). Rates are ROS per-game, so `lineupSpan` reduces to
  per-week x weeks and the per-week value decides; byes are not modelled.
- **Outcome** `y_L` (RL-8-2 primary, unchanged): `trade_sides.net_started_pts / sides_ext.n_h_weeks` for side A
  (points A started from received players minus points B started from A's given players, real weekly starters;
  writers `rnd/skill/build_03_leagues.py:386-398`, `rnd/skill/trades/tr_01_sides.py:150-196`).
- **Sign convention:** every signed outcome is oriented to the side the model names; positive = model right.
  Win = sign(model) == sign(y_L) among `y_L != 0` and model `!= 0`; ties dropped, their share reported.

## 4. Arms, metrics and ship rules

- **(a) 1-for-1 consensus edge.** Disagreement trades (`x_con`, `x_std` non-zero, opposite signs). Metric: share
  won by the consensus side. **PASS iff rate > 0.55 and the league-chain-clustered 90% percentile bootstrap lower
  bound > 0.50** (2,000 reps, seed 11, `team_seasons.chain`). Week- and league-clustered bounds reported, not
  deciding.
- **(b) lineup value on 2-for-1 + 2-for-2 (pooled; each shape reported).** Trades with `y_L`, `D_LV` and
  `x_con` all non-zero. Metric: share won by the side `D_LV` names. **PASS iff LV rate > 0.55, its chain-clustered
  90% lower bound > 0.50, and the `x_con` rate on the same trades <= 0.50.**
- **Decision win rate** (rule d): (a) consensus pick vs season-to-date pick on the same trades (rate vs 1 - rate);
  (b) LV pick vs `x_con` pick on the same trades, and the LV rate on the subset where the two picks differ (the
  trades where following the model changes the decision). Mean `y_L` to the named side (pts/week) for each.
- **MDE at 80% power** for every arm: 2.4865 x chain-clustered bootstrap SE (`MDE_Z`,
  `server/services/gates/baseline-gate.js:32`).
- Family: 2 decisions ((a), (b)); no multiplicity correction beyond both being reported; a pass in one arm does
  not rescue the other.

## 5. Controls (must hold before any 2025 number is read; the script stops otherwise)

- **C1 reproduction (known-nonzero, used data):** the same code path, run on 2021-24 with RL-8-2's settings, must
  reproduce r8's 2023-24 1-for-1 player-points result: n = 210 disagreement trades, 0.576 (league-clustered).
- **C2 linkage:** linked share printed; for 2025 sides with `recv_started_pts > 0`, the team's season sum of
  `team_weeks.pts_trade` must be >= `recv_started_pts` for >= 95% of them.
- **C3 model non-degenerate:** in (b), the number of trades where the LV pick and the `x_con` pick differ is
  printed and must be > 0, and at least one graded side must have a wire fill or a drop (the roster-spot charge
  actually fires).
- **Placebo P2b** (outcome permuted within the graded set, 1,000 perms, seed 5) for each arm: mean must lie in
  [0.47, 0.53] or that arm's result is void.
- **Placebo P1** (arm (a), RL-8-2's design, seed 3): A's received player swapped for a random same-position
  1-for-1 received player from the same week; disagreement win rate reported.

## 6. Secondaries (descriptive, never deciding)

- S1 `y_R = (sides_ext.L_rule(A) - L_rule(B)) / n_h_weeks` (whole-roster rule lineups on evolving rosters, so a
  freed spot's pickup counts) as an alternative outcome for both arms.
- S2 (b) with `E_L(A) - E_L(B)` (skill study frozen-roster lineup value, no spot charge, `pred_t` values) and with
  raw summed consensus (no replacement level) as extra baselines.
- S3 all 1-for-1 trades including agreement: consensus-side win rate.

## 7. Ship rule, forward rule and what happens after

- An arm that PASSES is a "historical pass (2025), unconfirmed forward": anything built on it ships
  **default-off**, labelled "unconfirmed forward", until it holds on 2026 forward trades (STATS-METHOD rule 5).
  The Sleeper corpus has no 2026 trade outcomes pulled (ruling NICK-2025: not needed now), so no arm can ship ON
  from this unit.
- An arm that FAILS is a decline for that half of the split, reported with its MDE. The Trade Machine may not
  claim that edge. `lineup_value` keeps `LINEUP_VALUE_STATUS = 'not yet validated'` if (b) fails.
- No server file changes in this unit either way.

## 8. Ledger, one look, no re-runs

- 2025 is opened once by `scripts/rnd/trade_split_2025.py`, one run, output committed verbatim. HOLDOUT-LEDGER
  rows (one per arm) are appended in the same commit as the result, per the ledger's own rule ("in the same
  commit as the result"; rows are never edited), and they mark 2025 as used for the trade split question.
  A forward row records that the 2026 check was not run.
- If a control stops the run, the fix is to the loader only (never to a metric, threshold, sample rule or
  model), the stop and the fix are both recorded, and the rerun is the same spec. Any spec change after the
  first 2025 number is printed is labelled post hoc and cannot decide either arm.

## 9. Literature

Executed trades between willing parties leave little average edge (the no-trade theorem, Milgrom and Stokey,
*J. Econ. Theory* 26, 1982), so an edge should appear only where humans misprice systematically, and roster value
is realised through starting slots over replacement (the value-over-replacement logic in Tango, Lichtman and
Dolphin, *The Book*, 2007). A split formed post hoc needs a fresh, pre-registered test (Simmons, Nelson and
Simonsohn, *Psych. Science* 22, 2011), and each look at a holdout spends it (Dwork et al., *Science* 349, 2015).
Clustered resampling follows Cameron, Gelbach and Miller, *JBES* 29(2), 2011.
