# Does any live surface show last week's points as a projection?

**Answer: no surface displays it, the repository already found this exact bug
and fixed it on 2026-09-18, and two fallback paths can still reach the old
behaviour.** One of those is checkable with a single query I cannot run from
this container.

R&D's finding — "last week's actual points" as a naive projection scores
R² −0.339, worse than the league average — is independently corroborated inside
this repository, with numbers, from before this thread existed.

---

## 1. The trace

The headline number on the Lineup page is `d.projected_points`
(`client/src/pages/Lineup.tsx:118`), and each row shows `p.week_points`
(`:247`, `:297`). Both resolve through one chain:

```
lineup-brain.js:279   const base = p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0;
lineup-brain.js:281   week_points = base * vegasLift multiplier
```

The same chain is repeated verbatim at `lineup-posture.js:69`,
`waiver-wire.js:128` and `trade-engine.js:2618`, so every surface that prints a
week total prices a player identically. That consistency is deliberate and
documented at `lineup-brain.js:264-272`.

Following it back:

- `current_week_ppg` (`trade-engine.js:359`) = the coordinator-corrected weekly
  projection × game multiplier × active probability.
- `adj_ppg` (`:385`) = 0.25 × current week + 0.75 × rest-of-season.
- `ppg` = a season rate.

**None of these is last week's actual score.** No display path reads a
most-recent-week box score as a headline number. There is no product bug of the
shape asked about.

## 2. What the repository already found

The naive pattern was not absent by luck. It was there, it was caught, and the
fix is documented with its own walk-forward numbers at
`weekly-ensemble.js:110-130` and `:15-29`.

The weekly ensemble blends five heads: `structural`, `season_to_date`, `last3`,
`last1`, `median`. **Four of the five are re-weightings of one series — the
player's own prior fantasy points.** At week 2 a player has exactly one prior
game, so `season_to_date`, `last3`, `last1` and `median` are all *the same
number*: his week-1 score. The promoted vector put 80% of its weight on those
four heads, so a week-2 projection was 80% one game.

The file says so in its own words: *"production applied it from week 2, where
season_to_date, last3, last1 and median are all the player's single week-1
score — so 80% of a week-2 projection was one game."*

The fix (fit-2, promoted 2026-09-18) gives a player with 1-3 prior in-season
games **the structural head alone** in weeks 2-4. Its walk-forward numbers:

| | live fit-1 MAE | structural-only MAE | diff, player-clustered 90% CI | n |
|---|---|---|---|---|
| 2024 | 4.7233 | 4.4867 | −0.2313 [−0.3575, −0.1053] | 929 |
| 2025 | 4.7099 | 4.3175 | −0.3965 [−0.5222, −0.2725] | 969 |

Start/sit pair accuracy 0.605 → 0.626 (2024) and 0.621 → 0.647 (2025); 2025 80%
coverage 0.756 → 0.811. Weeks 1 and 5-18 are byte-identical to fit-1.

That is the same phenomenon R&D measured, found independently, graded against a
pre-registered gate, and shipped. Worth saying plainly: **whoever did that work
was right, and the R² −0.339 result corroborates them rather than catching
them.**

## 3. Two fallback paths that can still reach the old behaviour

### 3.1 The frozen cold-start weights have no early-week block — NEEDS A LIVE CHECK

`weekly-weight-store.js:69`:

```js
if (!fit) return { id: 'frozen-2023', weights: WEEKLY_ENSEMBLE_WEIGHTS, source: 'frozen' };
```

`WEEKLY_ENSEMBLE_WEIGHTS` (`weekly-ensemble.js:60-65`) carries **no `early`
block**, so a week-2 prediction on that path gets the per-position vector with
all four history heads live — and at week 2 all four equal the week-1 score.
Effective weight on last week's points:

| position | weights [struct, s2d, last3, last1, median] | weight on the week-1 score at week 2 |
|---|---|---|
| QB | 0.40, 0.45, 0.00, 0.10, 0.05 | **0.60** |
| RB | 0.50, 0.20, 0.10, 0.15, 0.05 | **0.50** |
| WR | 0.60, 0.00, 0.00, 0.10, 0.30 | **0.40** |
| TE | 0.80, 0.20, 0.00, 0.00, 0.00 | 0.20 |

The path is reached when no promoted fit predates the week being predicted
(`activeWeeklyWeightSet`, `:34-36`, filtered by the active learning epoch).
**The live app is at 2026 week 2 right now, which is exactly the window this
affects.** Whether it is live depends on one row I cannot read from this
container:

```sql
SELECT id, epoch_id, through_season, through_week, promoted
  FROM weekly_ensemble_fits
 WHERE promoted = 1
 ORDER BY through_season DESC, through_week DESC, id DESC
 LIMIT 3;
```

If a promoted fit for the active epoch predates 2026 week 2 and carries the
`early` block, this is closed. If the epoch id moved, or no fit qualifies, every
QB on the page is 60% his week-1 score. **The check costs one query and should
be run before anyone calls this closed.** This is a reachability question, not a
claim that it is happening.

### 3.2 A weekly number standing in for a rest-of-season rate

`trade-engine.js:365`:

```js
const rosBasePpg = ros?.ros_ppg ?? weeklyPpg;
```

When the ROS model has no entry for a player, the rest-of-season rate falls back
to the weekly number. The comment directly above it records what that used to
cost — *"It used to BE weeklyPpg, which at week 2 is 80% the week-1 score (Coker
29.9 after a 33.8-point week 1; Waddle 2.72 after 1.2)"* — so the hazard is
known and the main path was fixed, but the fallback still has the old shape.

This is smaller than 3.1: with fit-2 active, `weeklyPpg` at week 2 is
structural-only for a 1-game player, so the fallback inherits a much better
number. It is only dangerous if 3.1 is also live, in which case the two compound
— a week-1 score becomes both this week's projection and the rest-of-season
rate. Worth a `ros_basis: null` count on the live leagues to see how often the
fallback fires at all.

## 4. Unrelated finding from the same pass

While tracing, I checked the shipped fantasy feature builder against the
same-week-aggregate contamination trap from
`opponent-defence-the-oracle-was-the-player.md`.

**`opportunity-model.js` is clean.** Its `teamVolume` and `defenceFaced`
histories are pushed only after the graded week's features are emitted
(`:261-268`, after the feature block at `:195-243`), so `team_volume_ewma` and
`opp_volume_faced` are strictly prior. The module states the rule at `:18-21`
and the code keeps it. `vacated_same_pos` reads the injury report for the
current week, which is published before kickoff and is therefore legitimate. No
change needed.

## The five questions

- **Well built?** A read-only trace. No server file is changed by this document.
- **Stats or made up?** The walk-forward table in §2 is the repository's own
  measurement, quoted from `weekly-ensemble.js`, not re-run by me. Everything
  else is a code path cited at `file:line`.
- **How do we know?** §1 and §3 are traced end to end from the rendered field to
  the weight vector. §3.1 is explicitly *unresolved* and names the query that
  resolves it, because a claim about live behaviour needs a live read this
  container cannot make.
- **Pointed anywhere else on the platform?** `weekly-weight-store.js` and
  `trade-engine.js`, both owned elsewhere; this is a report, not a change.
- **How does it unify?** It confirms a colleague's result against an independent
  one, and turns "is this bug live" into one query somebody can actually run.
