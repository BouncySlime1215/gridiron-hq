# RL-11-1 pre-registration: manager activity in trade receptiveness

Written and committed before any number in this unit is run.
Tree: branch `claude/local-rl-11-1-activity-receptiveness`, cut from origin/main `ad3bb9f6`.
Source package: `rnd/loop/r11-external-activity-is-the-yes-signal.md` (outside the repo), with the
validator's corrections ("Round 11 assess activity-is-the-yes-signal", LOOP-LOG).

## What is being shipped

A receptiveness term built from what a manager has done this season:

- `a` = players added per week: ADD items in EXECUTED `WAIVER`/`FREEAGENT` rows of
  `league_transactions_raw` with `scoring_period <= w`, divided by `w`, where `w` is the last
  completed scoring period (current period minus 1). This is the Sleeper `adds_rate` definition
  (adds with leg_week <= w, divided by w).
- `t` = has been a side in a completed trade with period <= w (an accepted proposal, not vetoed).
- Fitted constants, not new fits: the package's 2021-23 linear probability model, league-week
  demeaned, n = 27,468 team-weeks: base 0.2412, `a` +0.0686, `t` +0.1227, dead start -0.0264.
  The validator re-derived the activity-only AUC (0.652) on its own code.
- Term: relative propensity `r = (0.0686 (a - mean_a) + 0.1227 (t - mean_t)) / 0.2412`, the means taken
  over the league's managers who have the metric. Receptiveness is `0.7 + 0.6 score`, so the term
  enters the score as `r / 0.6` (receptiveness moves by the relative propensity), capped at +-0.5
  (the chat term's reach) and then by the existing [0.7, 1.3] clamp. It enters before the observed
  accept-rate blend, so an observed accept rate still outranks it.
- Gate: withheld (reported, effect not applied) until `w >= 5`, the same minimum as `tx_accept_rate`.
  The sample of a per-week rate is the weeks it averages over. Gating on the add count would gate on
  the outcome and withhold exactly the inactive managers.
- "Checked out" flag: a starter in last week's final lineup who did not play (final snapshot
  `actual_points` 0, not DEF, and no `nfl_snaps` row with snaps that week). Effect
  `-0.0264 / 0.2412 / 0.6` on the score. Withheld when `nfl_snaps` has no rows for that week
  (unknown, not "no").
- Label: "chance he completes a trade", never acceptance. The corpus outcome mixes proposer and
  responder.

## Hypotheses, metrics, rules

Sign convention: AUC above 0.5 means the higher score went to the team that traded.

H1 (held-out season, Sleeper 2024, the package's own bar, section 6). The shipped function, run on
the 2024 corpus with the 2021-23 constants, ranks teams that complete a trade in leg w+1 at a
within-league-week AUC of at least 0.645 on the activity term alone (rows w >= 2, league-weeks with at
least one trade, same filters as the package). Also reported: the combined term with checked-out,
and the w >= 5 rows the gate leaves live. 2025 is not opened; the corpus assert is `season <= 2024`.

H2 (forward, 2026, STATS-METHOD rule 5). On the 2026 weeks already played in the local copy
(Nick's ESPN leagues, `league_transactions_raw`), the same function without the week gate ranks
teams that complete a trade in period w+1 (w = 1, 2; period 3 is in progress and is included as it
stands). Holds = the point estimate is above 0.5 and the 90% interval (1,000 team-cluster bootstrap
resamples) is not entirely below 0.5. Forward n and MDE80 are reported
(Hanley & McNeil 1982 SE at AUC 0.5, z 1.645 + 0.842).

Secondary, descriptive, no ship weight: responder decisions (TRADE_ACCEPT vs TRADE_DECLINE, EXECUTE
rows), AUC of the responder's term at the decision's period.

Decision grade (discipline d): AUC is the pairwise decision win rate of "pitch the higher-scored of
two managers" against the dumb baseline, flat receptiveness (a coin flip, 0.5).

Ship rule: ON (gated at w >= 5) only if H1 passes AND H2 holds. Otherwise the term ships default-off,
reported on every manager as "unconfirmed forward", effect not applied.

## Literature

Past frequency of a behaviour is the strongest single predictor of its repetition when the setting is
stable (Ouellette & Wood 1998, *Psychological Bulletin* 124(1):54-74). Customer-base models use the same
logic, recency and frequency of past transactions predicting the next one (Fader, Hardie & Lee 2005,
*Journal of Marketing Research* 42(4):415-430). The post-loss window rests on the break-even effect
(Thaler & Johnson 1990, *Management Science* 36(6):643-660); the corpus finds it small (+1.3 points on
24%) and not margin-shaped. This unit does not change it.
