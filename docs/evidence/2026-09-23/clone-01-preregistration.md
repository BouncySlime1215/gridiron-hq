# CLONE-01a pre-registration: manager clones, population layer

Written and committed before any number in this unit is computed.
Tree: branch `claude/local-clone-01a-v3`, cut from origin/main `6cf97a74` (after #224).
Spec: the CLONE-01a row of ENGINE-SPECS.md (handoff, outside the repo); RL-13-3 in WORK-QUEUE.md.

Three parts, each with its own ship rule. Sign convention for every loss metric:
**candidate minus incumbent**, so a negative log-loss change is an improvement.

## Part 1. RL-13-3: shrink the observed accept rate before it enters receptiveness

**Hypothesis.** The accept-rate blend in `counterpartyLayer` mixes scales: the chat
score is centred on 0.5, the raw accept rate is not (Nick's leagues pool near 0.355),
so a perfectly average manager with 15 decisions is served as "leans closed".

**Incumbent (found by command).** `server/services/counterparty-pricing.js`, blend
`score = score*(1-w) + tx_accept_rate*w`, `w = min(1, n/15)`, receptiveness
`0.7 + 0.6*score`. A manager at 0.355 with n=15: score 0.355, receptiveness 0.913.

**Candidate `shrunkAcceptScore(k, n, pool)`.**
- Pool: `p0 = sum(k) / sum(n)` over the league's managers who carry `tx_accept_rate`
  (the metric exists only for n >= 5 decided proposals), `k = round(rate*n)`.
- Prior strength `m`: beta-binomial method of moments across those managers,
  clamped to [5, 50]; `m = 15` when fewer than 3 managers carry the metric or the
  moment estimate is undefined. Not fitted to an outcome.
- Shrunk rate `p = (k + m*p0) / (n + m)` (empirical Bayes posterior mean).
- Rescale to the 0.5-is-middle scale: `score = sigmoid(logit(p) - logit(p0))`,
  so a manager at the pool rate scores exactly 0.5 whatever `n` is.
- The blend weight `w = min(1, n/15)` is unchanged.

**RED (acceptance).** Manager at pool rate 0.355, n=15: accept score 0.5 (+-0.01) and
receptiveness 1.0, not 0.913. Monotone: more accepts at the same n never lowers it.

**Ship.** Behind `GRIDIRON_CLONE01A_ENABLED` (default off), also on under
`GRIDIRON_PREVIEW_UNCONFIRMED=1`. Nothing is fitted, so there is no held-out metric; the
acceptance is the RED test.

## Part 2. Population waiver-choice model (conditional logit), Sleeper

**Hypothesis.** Which free agent a manager claims is predicted better by a small
conditional logit on as-of player value, usage, recency, positional need and bye
timing than by "he takes the highest as-of value available".

**Data.** A `sqlite3 .backup` copy of `sleeper_history.sqlite` (500 leagues per season).
Fit seasons **2021-2023**, graded season **2024**. **2025 is never opened** (the query
filters `season BETWEEN 2021 AND 2024`). Only aggregates are committed.

**Events.** `sh_transactions` rows with `type='waiver'`, `status='complete'`, exactly
one add, Sleeper leg `w` in 1..16, the added player a QB/RB/WR/TE whose Sleeper id maps
to a gsis id (map: the local app DB's `players.sleeper_id -> gsis_id`, copy only).
Per-player weekly points come from `nfl_ffopportunity_weekly` (local copy).

**Timing (cutoff).** A leg-`w` claim is processed after week-`w` games (checked on a
sample: leg-1 claims are stamped the Wednesday after week 1). Every feature uses
weeks `<= w` only. Bye timing for week `w+1` is the published schedule, known in advance.

**Choice set.** Mapped QB/RB/WR/TE players with at least one ffopportunity row that
season, not on any roster in `sh_team_weeks` for that league at week `w`, plus the
claimed player (added if absent). Every event in a league-week shares that pool.

**Candidate features.** season-to-date PPG through `w` (prior-season PPG when he has no
game yet, with a no-games flag); last week's points; mean expected points over weeks
`w-1..w`; games-played share; positional need `1/(1+have)` where `have` is the claimant's
rostered count at that position; plays in week `w+1` (team not on bye); position dummies.
Claimant-level inputs enter only as interactions: loss streak x last week's points,
bye crunch x plays next week.

**Models.**
- B0 (dumb baseline, rule 6): conditional logit on season-to-date PPG alone; top-1 is
  "highest as-of PPG available". Season-to-date PPG stands in for FantasyCalc, since no
  as-of FC exists for 2021-24 (C6).
- M1: all candidate features above.
- M2: M1 plus MOTIVE state dummies x (PPG, last week's points, plays next week).

**Metric.** Mean per-event log loss on 2024 over the full choice set; top-1 accuracy.
Delta = M1 - B0 (and M2 - M1). 90% CI: bootstrap over **manager clusters** (league,
roster) in 2024, 1,000 resamples, seed 20260923.

**Ship rule.** The waiver model counts as beating the baseline only if the M1 - B0
log-loss CI upper bound is < 0. It ships as offline study output only in this unit
(aggregates, coefficients); nothing served reads it yet.

## Part 3. MOTIVE-01: buyer / seller / desperate state per manager

**States, frozen (first match wins).**
1. `seller`: title odds < 3% after at least 3 games.
2. `desperate_buyer`: >= 2 starters out and a bye crunch (>= 2 starters on bye next week).
3. `buyer`: title odds >= 1.5 / number of teams.
4. `hold`: otherwise.
No title odds (no simulation) gives `state: null` with a reason, never a default.

**Offline proxy (Sleeper).** Title odds: logistic model fit on 2021-23 team-weeks,
champion ~ win share through `w`, games, points-for z-score within the league through `w`;
applied to 2024 as an input only. Starters out: week-`w` starters (mapped skill players)
with no ffopportunity row in week `w` while their team played. Loss streak from
`sh_team_weeks` points vs opponent.

**Live.** Title odds from `simulateSeason` team `title_odds` (caller-supplied sim, else one
seeded, cached run per league-week while the flag is on); starters out from
`lineup_dead_starters`; loss streak from `standing_streak`; bye crunch from the league
payload's starters and `players.bye_week`. Stored on the counterparty profile as
`motive: {state, title_odds, loss_streak, bye_crunch, starters_out, n, reason}`.

**RED.** A 0-4 team with title odds < 3% reads `seller`; >= 2 starters out plus a bye
crunch reads `desperate_buyer`; no sim gives `state: null` with a reason.

**Ship rule.** MOTIVE enters a model as a feature only if M2 - M1 held-out log loss has a
manager-clustered 90% CI upper bound < 0. Otherwise it is display-only (stored on the
profile, moves no number). In this unit it moves no served number either way; the
verdict decides whether a later unit may price with it.

## Rules 4-7 (STATS-METHOD.md)

- Rule 4 (MDE): reported from the bootstrap SE of the 2024 delta (1.64 x 2.8 SE for 80%
  power at 90% two-sided is stated beside the result); not computed in advance because no
  earlier look at these features exists.
- Rule 5 (forward 2026): not applicable in this unit; no served number changes by default.
- Rule 7 (replay): offline, one command, deterministic seed, inputs are DB copies.
- 2025: not opened. No HOLDOUT-LEDGER row.

## Literature

Conditional logit for choice among a set of alternatives is McFadden (1974); sampling of
alternatives is not used here, every event is graded on its full pool. Shrinking a
small-sample rate toward the group rate is the empirical Bayes posterior mean (Efron and
Morris 1975), with the prior strength from beta-binomial moments.
