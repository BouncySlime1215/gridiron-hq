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

---

## Results (added after the pre-registration commit `b2a7d020`)

Run on commit `e34a2ab6` (tree `6e3fb70d`), local copies of both DBs:

    python3 scripts/rnd/fit-clone-population.py --sleeper .local-db/sleeper.sqlite --app .local-db/data.sqlite

Two notes on how the run differs from the text above. Neither changes a threshold, a split or a metric.
- Fit sample: a seeded 7% of 2021-23 claims (6,385 kept), capped at 6,000 for the fit. The fit
  uses a sample only to save time. Every 2024 claim is graded on its full pool.
- Shrink: `k = rate x n` is not rounded. For real data it equals the integer count.

**Part 1 (RL-13-3).** RED passes. The pool-rate manager (0.355, n=15) now scores 0.500 and
reads receptiveness 1.00, not 0.913 (`test/clone-01a.test.js` C1). Off by default, the
incumbent 0.913 is unchanged (C3).

**Part 2 (waiver choice).** Graded 28,053 claims in 2024 across 4,194 manager clusters. The
median pool holds 425 players (a uniform guess scores log loss 6.045).

| model | 2024 log loss | top-1 |
|---|---|---|
| B0: season-to-date PPG only ("highest as-of value available") | 5.406 | 0.7% (argmax PPG) |
| M1: full candidate features | 4.333 | 9.5% |
| M2: M1 + MOTIVE interactions | 4.330 | 9.6% |

- M1 - B0 log loss: **-1.073**, 90% CI [-1.086, -1.061]. The CI clears 0, so **the model beats
  the baseline**.
- M1 - B0 top-1: +8.8 points, 90% CI [+8.5, +9.1].
- Signs of the M1 coefficients: recent usage (expected points +1.20), games-played share (+1.12),
  PPG (+1.10) and last week's points (+0.71) all pull toward a claim. Positional "need" as
  defined (1/(1+have)) comes out **negative** (-3.83). Managers claim at positions where they
  are already deep (RB/WR churn), which is the opposite of the need story. Treat that feature
  as a depth-churn term, not a need term.

**Part 3 (MOTIVE-01).**
- M2 - M1 log loss: **-0.00265**, 90% CI [-0.00417, -0.00131]. The CI clears 0, so MOTIVE
  **passes the pre-registered bar to be a model feature**. The effect is small: 0.06% of the
  loss, near the design's MDE of 0.0025.
- States across 2024 claims: hold 18,403; buyer 6,117; seller 3,514; desperate_buyer 19.
- Offline RED check: 106 of 153 claims made by 0-4 teams read `seller`. The other 47 teams
  had proxy title odds of 3% or more on points-for. Of 25 claims by teams with >= 2 starters
  out and >= 2 on bye, 19 read `desperate_buyer`. The other 6 were sellers, because seller is
  checked first.
- Served path: still display-only in this unit, as pre-registered. The live profile stores
  `motive` and moves no number. A later unit may price with it, because the bar was cleared.

2025 was not opened, so there is no HOLDOUT-LEDGER row.

---

## Amendment 1 (FIX-229-2): completed trades as PU positives

Registered and committed before any code for it is written or run. It closes the spec
item "completed trades as PU positives", which the first pass did not build. Parts 1-3
above, their thresholds and their results stand unchanged.

**Hypothesis.** A completed trade is a labeled positive for "this manager wanted this
player", seen against an unlabeled set (every other player he could have asked for).
Adding those positives to the waiver-choice fit sharpens the shared player-value
coefficients, so 2024 waiver claims are predicted better.

**Trade events (PU positives).** `sh_transactions` rows with `type='trade'`,
`status='complete'`, Sleeper leg `w` in 1..16, fit seasons 2021-23 only. Each QB/RB/WR/TE
in `adds_json` (Sleeper id mapped to gsis, same map as Part 2) is one positive event for
the roster that received him.
- Timing: a leg-`w` trade can clear before the week-`w` games, so every feature is as of
  week `w-1` (prior-season values when `w=1`), and "plays next week" is week `w`.
- Unlabeled set: mapped skill players on the league's OTHER rosters at week `w-1`
  (`sh_team_weeks.players_json`; week 1 when `w=1`), plus the received player if absent.
  They are unlabeled, not negatives: they enter only through the conditional-logit
  denominator, the standard selected-completely-at-random reading of PU for choice.
- Claimant terms (positional need, loss streak x last week, bye crunch x plays next week)
  are built the same way as for claims, from his roster and standings at week `w-1`.
- Weight: each event counts `1/k`, where `k` is the number of mapped skill players that
  roster received in that trade, so one trade counts once however many players it moved.
  All 2021-23 trade events are used (no sample). Picks-only legs add no event.

**Model.** M3: the M1 feature set, one coefficient vector, fit on the same seeded 6,000
2021-23 waiver claims as M1 (weight 1 each) plus the weighted trade events.

**Metric and ship rule.** Graded on the same 2024 waiver claims as Part 2 (full pools).
Delta = M3 - M1 mean log loss, 90% CI by 1,000 manager-cluster bootstrap resamples,
seed 20260923 + 3. The trade positives count as helping only if the CI upper bound is < 0;
otherwise M1 stays the population model and the result is logged as a decline. Top-1 is
reported beside it, not decided on.

**Secondary, descriptive only (no decision).** M3 vs M1 log loss on 2024 trade events
built the same way, so the reader can see whether the fit learned trade choice at all.

2025 is not opened. The run prints aggregates only.

### Amendment 1 results (added after the amendment commit `b4908342`)

Run on commit `b5845317` (tree `df9232c7`), the same command and fresh `.backup` copies of both
DBs. The Part 2/3 numbers reproduced exactly on this run (M1 - B0 -1.07341, M2 - M1 -0.00265),
so the comparison below is like for like.

- Trade events in the fit: 16,103 received skill players from 2021-23 trades (total weight 9,752
  after 1/k), next to the same 6,000 sampled claims.
- **M3 - M1 on 2024 waiver claims: +0.555 log loss, 90% CI [+0.544, +0.565]** (28,053 claims,
  4,194 manager clusters). The CI is entirely above 0, so the trade positives make claim
  prediction **worse**. Top-1 drops 9.5% -> 8.5% (-1.0 point [-1.2, -0.8]).
- **Verdict: declined.** M1 stays the population waiver model. Completed trades do not enter it.
- Secondary (descriptive): on 4,330 events from 2024 trades, M3 beats M1 by -1.213 [-1.249, -1.178]
  (M1 6.291 -> M3 5.078). So the fit did learn trade choice; trade choice and waiver choice just
  pull the shared coefficients apart. M3 cuts the recent-usage weight (1.20 -> 0.32) and the PPG
  weight (1.10 -> 0.39): a trade buys a known name, a claim chases this week's usage.
- Read: a trade target and a waiver claim are different decisions. If trades are used later
  (CLONE-01b's accept model is the natural home), they need their own coefficients, not a pooled fit.
