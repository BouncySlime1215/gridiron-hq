# Phase A, OL-vs-DL matchup — declined, and it found the boundary

Ran 2026-09-22, the fifth feature. **Verdict: declined.** The line matchup
itself carries nothing, and the two opponent-quality terms that *did* detect
pooled both failed replication — and one of them already exists in the tree.

This run is the most useful of the five, because it is the first to get a
detection at all, and the reason it still fails is instructive.

## 1. The feature and why it was worth testing

The [weekly ceiling result](./weekly-ceiling-the-model-is-already-there.md)
argued that only **week-specific** information can help, player-descriptive
features being exhausted. **Corrected 2026-09-22:** that document's v2 withdraws
the "exhausted" half — there is about +0.067 R² of player-level headroom, not
+0.0037. What survives is the reason week-specific features are a distinct
class: no season-long average of a player can carry what makes *this* week
different for him. OL-vs-DL is week-specific by construction, it changes with
the opponent, and it was worth testing on that basis either way. The result
below is its own measurement and does not depend on the withdrawn figure.

True line-matchup grades are PFF and paid. The free proxy, from
`play_by_play`: how well a team protects (sacks and QB hits allowed per pass
play) against how well *this week's* opponent rushes (sacks and hits generated
per pass play faced), both averaged over prior weeks in-season.

**The feed is live**: `play_by_play_2026.csv.gz` returns 200 with 5,334 rows
across weeks 1-2, so unlike participation this could have shipped. 4,315
team-weeks built, 62 of them in 2026.

The feature genuinely varies within a player-season — median spread of the
opponent pass-rush term across a player's own weeks is 0.0518, p90 0.0760. A
player-invariant average would have spread zero. So it is the right *class*.

## 2. What detected, and what that turned out to mean

| model | MAE | R² | gain, 95% CI | verdict |
|---|---|---|---|---|
| full baseline | 4.7770 | 0.3217 | — | — |
| + own protection alone | 4.7767 | 0.3217 | +0.0004 [-0.0009, +0.0016] | not detected |
| + matchup (opp rush − own protection) | 4.7765 | 0.3219 | +0.0006 [-0.0024, +0.0036] | not detected |
| + sack and hit matchups | 4.7767 | 0.3218 | +0.0003 [-0.0028, +0.0036] | not detected |
| + opponent pass-rush rate | 4.7730 | 0.3223 | **+0.0040 [+0.0010, +0.0071]** | detected pooled |
| + opponent pass EPA allowed | 4.7660 | 0.3230 | **+0.0110 [+0.0073, +0.0147]** | detected pooled |

**The line matchup itself — own protection, and the difference term that is
actually "OL vs DL" — carries nothing.** Only the opponent-side terms moved,
which is the first clue: the signal is about the opponent being good, not about
the lines meeting.

Both survived the checks that killed nothing: four bootstrap seeds (7, 13, 29,
101) give the same interval to four decimals; the coefficient signs are correct
(pass-rush −1.1893, so a tougher rush lowers points; pass EPA allowed +0.2165,
so a leakier defence gives up more); and the shuffled control on pass EPA
returns +0.0001, CI [-0.0007, +0.0008] — the lift vanishes exactly as it must.

## 3. Why neither is claimed

**Opponent pass-rush is absorbed by general opponent quality.** Put opponent
EPA allowed in the model first, and pass-rush on top of it gives +0.0012, CI
[-0.0002, +0.0027] — not detected, across three seeds. So it was never a
pass-rush effect; it was "this defence is good", arriving through the one
channel I happened to measure.

**Both fail split-half replication.** Re-running each test within one era:

| feature | 2018-2021 (n=12,151) | 2022-2025 (n=13,357) |
|---|---|---|
| opponent pass-rush | -0.0033 [-0.0077, +0.0010] | -0.0007 [-0.0042, +0.0028] |
| opponent pass EPA allowed | +0.0061 [-0.0001, +0.0119] | -0.0018 [-0.0043, +0.0005] |

A real effect should appear in both halves with the same sign. Pass-rush is
negative in both halves despite a positive pooled estimate, and pass EPA is
positive in the first half and negative in the second. Neither is established.

**Stated confound, because it weakens the split test rather than the feature:**
splitting the sample also shrinks each walk-forward's training history, so the
early weeks of each half are fit on much less data than the same weeks in the
pooled run. The split is therefore not a clean replication — it changes two
things at once. I am treating both features as *not established* rather than
*refuted*, which is the weaker and more honest claim.

## 4. The finding that matters more than the verdict

**Opponent defensive quality is already a feature in this repo.**
`server/services/nfl-features.js:217` declares `def_epa_per_play`, `:219`
`def_success_rate`, and `:228` `opp_adj_def_epa` — "Defensive EPA allowed
adjusted for offences faced" — computed at `:445`.

So the one class of feature that produced a detection tonight is a class the
project has already built. Two consequences:

1. **My baseline is a research baseline, not the production model.** It knows
   targets, receptions, yards, prior PPR, snap share, games and position — it
   does *not* include the repo's opponent adjustment. That means my pooled
   "detection" was substantially rediscovering a feature that already exists.
2. **This makes the four earlier nulls stronger, not weaker.** The production
   model has strictly more information than my baseline, so a feature that adds
   nothing to my baseline has even less to add to the real one.

The honest next step is therefore not another opponent feature. It is to
**measure whether `opp_adj_def_epa` is actually wired into the projection users
see** — the same question Phase 0 item 5 asks of everything else. A feature
declared in a feature list and computed in a service is not necessarily reaching
a surface, and this thread has already found several things in that state.

## 5. Where the deep predictive feature set now stands

| feature | verdict |
|---|---|
| routes run | declined — indistinguishable from snap share |
| red-zone touches inside 10 | declined — absorbed by targets + snap share |
| practice participation | declined — availability info, already modelled |
| depth-chart change | declined — role info, already inside targets + snaps |
| OL-vs-DL matchup | declined — line matchup carries nothing; opponent terms not established and already built |
| team pace / play volume | dropped unrun — a third volume proxy against a saturated channel |
| coaching run/pass tendency, 4th-down aggression | untested; team-level, and player-invariant unless opponent-adjusted |

Five tested, five declined, one dropped with reasons. The remaining item is
team-level and player-invariant in the form the brief describes, so on the
ceiling argument it should be expected to behave like team pace unless it is
built as an opponent-adjusted, week-specific term.

**Recommendation: stop adding features and audit the ones that exist.** The
evidence now points at wiring rather than invention — a declared feature that
reaches no surface is worth more to fix than a sixth feature is to test.

## The five questions

- **Well built?** Nothing shipped. The harness caught its own pooled detection
  failing to replicate, which is the outcome it exists for.
- **Stats or made up?** Stats. 25,508 out-of-sample player-weeks, 4,315
  team-weeks, four bootstrap seeds, split-half replication, sign checks.
- **How do we know?** Every interval is stated, including the two that detected
  and were then withdrawn.
- **Pointed anywhere else on the platform?** No — and §4 is the point: the
  class that works is already declared in `nfl-features.js` and needs a wiring
  check, not a rebuild.
- **How does it unify?** By redirecting the effort from building to verifying.
