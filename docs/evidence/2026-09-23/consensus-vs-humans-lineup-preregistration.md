# consensus-vs-humans-lineup: pre-registration

Unit: RL-8-2 (work queue §9 round 8, CRITICAL). Plan item: Trade Machine gate (TM-01's gate; C12 counterparty test).
Tree: origin/main `4773401a`. Date: 2026-09-23. Written and committed before the study script exists and
before any lineup-points number is computed. Local data only, aggregates only; label "local copy, not production"
does not apply (no `data.sqlite` rows are graded; the Sleeper corpus and skill-study tables are read read-only).

What is already known before this file (so the reader can discount it): R&D round 8
(`~/gridiron-local/rnd/loop/r8-external-edge-is-the-counterparty.md`, script `r8x_consensus_vs_humans.py`)
graded the same 2023-24 Sleeper 1-for-1 trades in PLAYER rest-of-season points: consensus-favoured side won
0.576 [0.515, 0.633] of n = 210 disagreement trades. The lineup-points outcome on these trades has not been
computed by anyone (grep of `rnd/loop/*.md`, `rnd/skill/**/*.md` for "consensus" + "started" or "L_frozen": no
consensus-disagreement cut of lineup points exists). 2-for-1 trades have not been graded on the consensus axis.

1. **Hypothesis (one sentence):** in real 2023-24 Sleeper 1-for-1 and 2-for-1 trades where the consensus ROS
   value (FantasyPros ECR rank mapped to ROS points per game) and season-to-date points per game favour different
   sides, the consensus-favoured side gains more starting-lineup points over the rest of the regular season than
   the other side.

2. **Metric and sign convention.** Each trade is oriented to side A (random, seeded). Sign convention: every
   signed outcome is (consensus-favoured side) minus (other side); positive = consensus was right.
   - x_con: 1-for-1 = v(received) - v(given) exactly as r8 (v = position curve from ECR rank bins of 3 to ROS
     PPR/game, fit on 2021-22 only, monotone). 2-for-1 = sum over players of (v - R_pos) received minus given,
     where R_pos = curve value at the replacement rank QB 13, RB 30, WR 36, TE 13 (a convention, i.e. a guess at
     12-team starter lines; stated as such). x_std uses the same transform on season-to-date PPG.
   - Disagreement trade: x_con != 0, x_std != 0, sign(x_con) != sign(x_std).
   - **PRIMARY outcome y_L (actual lineups):** `trade_sides.net_started_pts` for side A = points A started from
     the players it received minus points B started from the players A gave, regular season only, from each
     team's real weekly starters (the same starters that build `team_weeks`; writer
     `rnd/skill/build_03_leagues.py:386-398`, table `trade_sides` in `rnd/skill/team_seasons.sqlite`),
     divided by the horizon weeks `sides_ext.n_h_weeks` (active weeks whose first kickoff is after the trade;
     writer `rnd/skill/trades/tr_01_sides.py`, table `sides_ext` in `trades/trades_ext.sqlite`).
   - **PRIMARY metric:** share of disagreement trades with y_L != 0 where sign(y_L) = sign(x_con)
     ("consensus side wins"); ties (y_L = 0) excluded and their share reported.
   - **Co-primary magnitude:** mean of y_L x sign(x_con), lineup points per week to the consensus side.
   - **SECONDARY S1 (counterfactual lineup gain):** y_F = (L_frozen(A) - L_frozen(B)) / n_h_weeks from
     `sides_ext` (rule-based lineups on rosters frozen at the trade, realized points; the skill study's canonical
     lineup-gain producer). Same win rate and magnitude. Does not decide the gate.
   - **SECONDARY S2:** strata 1-for-1 and 2-for-1 separately; 2021-22 (curve fit years) and pooled 2021-24
     shown, never deciding.
   - **Reproduction control (known-nonzero, must pass before any lineup number is read):** the script first
     rebuilds r8's 1-for-1 player-points arm and must print n = 210 disagreement trades and 0.576 for 2023-24
     (league-clustered, 2000 reps, seed 11). If it does not reproduce, stop and report.
   - **Linkage control:** every graded side must match exactly one `trade_sides` row (lg, season, roster_id,
     leg_week, received and given Sleeper ids) and one `sides_ext` row; and for sides with recv_started_pts > 0,
     the season sum of `team_weeks.pts_trade` for that team must be >= recv_started_pts (team_weeks is the
     weekly-lineup table; this proves the started points come from real lineups). Report the pass share.

3. **Split.** Graded (decides the gate): seasons 2023-2024, weeks 4-14 (trade leg week), QB/RB/WR/TE only, no
   draft picks, 2-team trades, every player dropped by the giver (no bundled FA moves), every player with >= 3
   games before the trade and on the ECR board. Curve fit: 2021-22 only. **2025 is not opened**: every SQL read
   filters season <= 2024, and the ECR parquet drops scrapes after 2024. No 2026 outcome is graded.

4. **Incumbent and dumb baseline.** Incumbent = season-to-date PPG (what a counterparty sees on the ESPN trade
   screen; r8 §3 Web), encoded in the disagreement definition itself: a win for consensus is a loss for
   season-to-date. Dumb baseline for the win rate = 50% (coin flip). "Offer fair value" baseline: not
   applicable, because this is a historical population test, not a finder output.

5. **vs ESPN (rule 11):** no number. ESPN projections do not exist for Sleeper corpus trades.

6. **Historical replay:** two seasons graded (2023, 2024), as-of: ECR is the latest scrape in the 6 days before
   the trade week's last Sunday; season-to-date uses only games before week w. Stand-in harness = this script
   (HX-01 is for start/sit, not trades).

7. **Interval.** 90% percentile bootstrap, 2000 resamples, seed 11. Primary clustering: league chain
   (`team_seasons.chain`, renewals of one league share managers). Second clustering: NFL season-week (trades in
   the same week share the same hot players and news). League-clustered (r8's) shown too. The gate needs both
   the chain and season-week lower bounds (rule 9, as `baselineGateVerdict` G1/G2).

8. **Family and correction.** Family "trade consensus gate", m = 1 decision (the primary). Secondaries are
   descriptive. No 2025 look, so no HOLDOUT-LEDGER row (stated in the results file).

9. **MDE at 80% power:** MDE = 2.4865 x SE (`MDE_Z`, `server/services/gates/baseline-gate.js:32`), from the
   chain-clustered bootstrap SE. Expected: r8's 2023-24 player-points CI (half-width 0.059) implies SE about
   0.036 and MDE about 0.09 win-rate points for 1-for-1 alone; lineup outcomes are noisier (ties, bench), so
   expect a larger MDE. Reported for every metric.

10. **Ship rule (TM-01 gate).** PASS iff, on 2023-24 pooled (1-for-1 + 2-for-1) disagreement trades:
    (a) primary win rate >= 0.55, (b) its 90% lower bound > 0.50 under BOTH chain and season-week clustering,
    and (c) the co-primary lineup points per week to the consensus side has a chain-clustered 90% lower bound
    > 0. Anything else = FAIL: TM-01 may not claim a lineup-points edge from consensus disagreement, and the
    result is filed as a decline with its MDE. Forward (rule 5): the Sleeper corpus has no 2026 outcomes and
    Nick's leagues have too few graded 2026 trades, so even a PASS is labelled "historical prior, unconfirmed
    forward" and any product use ships default-off until the 2026 forward counterparty test (r8 §6.2) grades.

11. **Replay configuration:** not applicable, because no projection replay (`roleRecency`, `kOverride`) runs;
    ECR and season-to-date are the only inputs.

12. **LLM involvement:** none in the inputs or outcome; the analyst writing the script is an LLM, so every
    number is printed by the script with its command.

13. **Placebos.**
    - P1 (r8's design, 1-for-1 only): replace A's received player with a random same-position player traded
      in the same season-week (seed 3); y_L,placebo = that player's per-week started points by the team that
      really received him (his own trade's `recv_started_pts / n_h_weeks`) minus B's real started points from
      A's given player per week. Report the disagreement win rate. No human agreed to this swap.
    - P2 (null control): permute x_con across the graded trades within season, 1000 permutations, seed 5;
      report the mean and 95th percentile of the disagreement win rate. The harness must centre near 0.50;
      if the P2 mean is outside [0.47, 0.53] the harness is biased and the result is void.

14. **Literature.** Executed trades are the revealed prices of individual counterparties; decision makers in
    football systematically overweight salient recent information relative to market value (Massey and
    Thaler, *Management Science* 59(7), 2013, the NFL draft "loser's curse"), and recency overreaction in
    streaks is a documented human bias (Gilovich, Vallone and Tversky, *Cognitive Psychology* 17, 1985).
    Lineup points rather than player points are the right outcome because roster value is realised only
    through the starting slots (the skill study's frozen-roster E_L / L_frozen, `rnd/skill/trades/trades.md`);
    clustered resampling follows Cameron, Gelbach and Miller, *JBES* 29(2), 2011.

15. **Stop early:** none; one run.
