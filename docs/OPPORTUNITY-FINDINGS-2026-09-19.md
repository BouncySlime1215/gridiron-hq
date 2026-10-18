# Player opportunity (O1) — what is actually there, measured 2026-09-19

Everything below was re-measured on this date against a database built fresh
from the public sources the app itself uses (nflverse `stats_player_week`,
`snap_counts`, `injuries`, `depth_charts`, `ngs`, `pfr_advstats`, ffverse
`ffopportunity`, and nfldata `games.csv`), seasons 2021–2026. Nothing here is
quoted from an earlier session's notes; where an earlier number is repeated it
is marked as reproduced or as differing.

Loaded row counts, for the record:

| table | rows | 2026 |
|---|---|---|
| `player_week_usage` | 29,755 | 379 |
| `nfl_snaps` | 128,146 | 1,585 |
| `nfl_injuries` | 28,411 | 428 |
| `nfl_depth` | 180,069 | 8,829 |
| `nfl_ngs` | 12,010 | 150 |
| `nfl_pfr_adv` | 25,797 | 739 |
| `nfl_ffopportunity_weekly` | 28,612 | 331 |
| `game_lines` | 15,096 | 544 |

2026 is week 1 only, which is all that has been played.

## 1. There was no opportunity model, and the thing named like one was dead

Three separate artifacts carry the word "opportunity". None of them reached a
number a fantasy user sees.

- **`playerOpportunity` in `nfl-expert-council.js`** was a 0.55/0.35/0.1
  recombination of a per-unit *injury-burden* differential — not usage, despite
  the name. The identifier appeared exactly once in the repository: its own
  declaration. Assigned, never read. **Removed in this change.**
- **The registered `player_opportunity` expert** is alive but is a scoreboard row
  on the betting side. It emits no forecast (`score: 'volume_mae'`), and it
  *consumes* the fantasy engine rather than feeding it. No fantasy route, service
  or client reads it.
- **`priorFfOpportunity`** is attached to every projection at
  `player-week-engine.js:358` and read by nothing — not by the engine, not by a
  route, not by the client. It self-declares `authority: 0`. Write-only.

`opportunity-redistribution.js` is complete and correct code sitting behind
`redistributeVolume = false`, with its own measurements recorded in its header
showing all three variants made the projection 9.5–12.6% worse. Its only caller
is an evaluation script.

## 2. The real opportunity defect is the volume shrinkage constants — reproduced

`projections.js` shrinks target share and carry share toward a positional prior
with `K.share = 6` and team pass/rush volume with `K.team_volume = 10`. The
variance-components fitter in `shrinkage-fit.js` estimates these properly, and
**no fit has ever been persisted**, so production has always run the hand-picked
values.

Fitting strictly on seasons ≤ s−1 and substituting only the five volume metrics:

| fitted through | `target_share` | `carry_share` (RB) | `team_pass_att` | `qb_attempts` |
|---|---|---|---|---|
| 2023 | 0.277 | 0.172 | 2.91 | 0.352 |
| 2024 | 0.211 | 0.126 | 2.00 | 0.318 |
| 2025 | 0.175 | 0.081 | 1.28 | 0.264 |

Against the hand-picked 6 and 10. Volume is being regressed roughly 20–30× harder
than the data supports, in a head whose stated thesis is that volume should be
regressed *lightly*.

Structural head, walk-forward:

| season | hardcoded k | volume-fitted k | Spearman |
|---|---|---|---|
| 2024 | 4.747 | **4.586** | 0.658 → 0.681 |
| 2025 | 4.638 | **4.519** | 0.648 → 0.671 |

**`scripts/promote-volume-shrinkage.mjs --dry-run` passes all five of its
pre-registered gate conditions on this data**, including the two that matter for
what a user sees. (This run had `nfl_qbr_weekly` empty; see the section below,
which repeats it under the live database's actual QBR state and under a full
backfill, because the answer is not the same in all three.)

| | 2024 | 2025 |
|---|---|---|
| full ensemble MAE, weights re-fit per arm | 4.453 → **4.428** | 4.362 → **4.341** |
| start/sit pair accuracy, DNP scored 0 | 0.6349 → **0.6395** | 0.6272 → **0.6334** |
| 80% coverage (2025) | 0.759 → **0.786** | |
| CRPS (2025) | 3.102 → **3.056** | |

Both ensemble differences are significant under a player-clustered paired
bootstrap. The re-fitted weights move the structural head from 0.20–0.25 up to
0.50–0.55, which is the docstring's own prediction that a better head should earn
more weight.

### The verdict depends on whether QBR is loaded — checked, not assumed

`projections.js:230` documents a walk-forward-validated QB structural head fed by
`nfl_qbr_weekly`. The rebuild above had that table empty, so the head was inert
in every number on this page. Running the same gate with QBR loaded for all six
seasons changes the answer:

| `nfl_qbr_weekly` state | 2025 structural head | 2025 ensemble | gate |
|---|---|---|---|
| empty everywhere (first rebuild) | 4.638 → 4.519 | 4.362 → 4.341, significant | **passes** |
| 2021-2026 fully loaded | 4.758 → 4.394 | 4.363 → 4.347, **not** significant | **fails (3)** |
| 2025-2026 only — **what the live app has** | 4.758 → 4.394 | 4.364 → 4.343, significant | **passes** |

The live database was read on 2026-09-19 at 16:38Z: `nfl_qbr_weekly` holds 0 rows
for 2021-2024, 540 for 2025 and 34 for 2026. That third row is therefore the one
that describes production, and it passes.

Two things follow, and the second is the one that matters operationally.

The shrinkage fix is directionally right in **every** configuration — the
structural head is better in all three seasons and significant in all three, and
feeding the QB head actually widens the head-level gap (2025: −0.119 without QBR,
−0.364 with it). What narrows is the *net ensemble* benefit, because the ensemble
re-fit can lean on other heads once the QB head carries real information.

**So backfilling QBR for 2021-2024 would stop this gate passing.** Another thread
is pulling exactly that (2,754 rows, `syncQbr`). If that lands on the live
database before the promotion, the gate has to be re-read and may well come back
false on condition 3. Promote first, or accept that it needs re-deciding after.

**This is a database write, not a code change.** The gate script, the fitter, the
cutoff-safety guard and the recency-units guard all already exist and are
correct. What is missing is a row: `shrinkage_fits` and `shrinkage_k` are empty.
That was first measured on the rebuild, and it has since been read on the live
machine (2026-09-19, 20:58Z): **0 rows in `shrinkage_fits`, 0 active, 0 rows in
`shrinkage_k`**. Production has never carried a fit, so the "before" arm of every
comparison here is what the app is really running.
Running `node scripts/promote-volume-shrinkage.mjs` (without `--dry-run`) against
the live database, then re-running `scripts/promote-weekly-ensemble.mjs`, is the
whole change. It moves live start/sit output, so it is deliberately not done from
here.

The start/sit figures above match an earlier recorded run (0.6274 → 0.6336) to
within 0.0004, which means this gate has been run before and the fit was still
never persisted.

### A second, independent grade — the opportunity number itself

Everything above grades the fit on **points**. The Model evidence audit thread
graded it on **opportunity**, which is the thing a user actually reads, and got
the same answer from a different slice: 2024 and 2025, weeks 5-17, 4,828 paired
player-weeks, baseline the player's own season-to-date average, paired bootstrap
clustered by player (`scripts/grade-opportunity-vs-baseline.mjs`, PR #68).

The shipped constants **lose in all four cells** against that baseline — an
average a manager could do in his head — and the fitted constants win all four.

| | 2024 targets | 2024 carries | 2025 targets | 2025 carries |
|---|---|---|---|---|
| shipped k = 6 / 10, MAE | 2.006 | 2.003 | 1.901 | 1.943 |
| own season-to-date average, MAE | 1.773 | 1.626 | 1.768 | 1.602 |

Their fit reproduces the vector measured here to three decimals, from a separate
rebuild. Three things were checked in their script before citing it: the baseline
is strictly prior (`week < ?`, not `<=`); `buildPlayerWeekEngine` passes
`WEEKLY_ROLE_RECENCY` (`player-week-engine.js:271-273`), so this caller is on the
fitted path and `activeKVectorFor` does not strip the volume metrics from it; and
`cutoffSafeKVector(predictingSeason)` bounds `k` to seasons before the graded one,
so neither arm sees the week it predicts.

One label to read precisely: the graded quantity is `projection.params.targets`,
the engine's reconciled parameter, not the figure the News card prints. The card
prints `volume.targets_per_game × roleMultiplier × activeProbability`
(`news-fantasy-impact.js:118`), which is the structural per-game number from
`projections.js:723` before the engine reconciles it against team totals
(`player-week-engine.js:225`, `:627`, `:673`). Both sit downstream of the same
fitted `k`, so the finding's direction carries; the number graded is not the
number displayed.

**This adds a screen to the list.** The blast-radius measurement in
`scripts/measure-shrinkage-blast-radius.mjs` named start/sit, trade values, props
and the ROS list. News fantasy impact belongs on it too: `/news` is routed
(`client/src/App.tsx:135`) and its "Projected fantasy usage" panel is built from
`buildPlayerWeekEngine`, which is the fitted path.

## 3. Teammate absence: the effect is real, the payoff mostly is not

`scripts/study-opportunity-volume.mjs` grades a fitted opportunity model and a
vacated-share correction against three baselines, expanding-window (the model
grading season s is fitted only on seasons before s), with a paired bootstrap
resampled by whole player.

**The mechanism is there.** In log space, the coefficient on a same-position
teammate's vacated share is positive in every position and every season:

| head | 2024 | 2025 |
|---|---|---|
| WR/TE targets | 0.492 | 0.668 |
| RB carries | 0.718 | 0.828 |
| RB targets | 1.390 | 1.647 |

Roughly half of a vacated receiving share and most of a vacated backfield share
shows up in the teammates.

**The payoff is inside the noise, except for running backs.** Against the best
baseline, pooled:

| head | 2024 | 2025 | affected rows 2024 | affected rows 2025 |
|---|---|---|---|---|
| RB carries | **−0.86%** | **−0.98%** | −2.72% | −4.57% |
| RB targets | −0.56% | +0.08% | −3.32% | — |
| WR/TE targets | −0.38% | +1.02% | −1.37% | +1.80% |
| QB attempts | +0.51% | +4.18% | — | — |

RB carries is the only head whose sign holds in both seasons on both slices. Its
pooled 90% intervals still straddle zero ([−0.077, +0.027] and [−0.092, +0.037]),
so under this repository's own promotion discipline it does not ship. **Nothing
here is wired into a projection.** The module and the study are the deliverable;
promotion needs a season it has not seen.

A full ridge model over sixteen features (share, snap trajectory, expected
points, team volume, vacated share, spread, implied total, opponent funnel) is
**worse than an exponentially-weighted average of the player's own recent
volume** for RB carries (+7.5%, +10.7%) and QB attempts, and inside the noise for
WR/TE (−0.41%, −1.63%, both intervals straddling zero) despite a consistently
better Spearman. This is the fourth attempt at this question in this repository
and it agrees with the previous three: for next-week volume, the player's own
recent usage is very hard to beat.

### Why the earlier attempts measured nothing

They looked for absent teammates among the players who have a box-score row in
the graded week. A player ruled out has no box-score row that week, so the search
finds nobody and the feature silently never fires. Built that way here, the
teammate-out slice was **0 of 5,336 rows**. Built from the roster as of prior
weeks, it is 2,170 of 5,336 — 41%. The test
`test/opportunity-model.test.js` pins this.

## 3b. The graded population is bounded by the source file, not by row counts

The live database holds noticeably more weekly usage rows than the rebuild these
numbers were measured on — 8,857 against 6,037 for 2025, about 40% more — which
looks at first like the live gate would grade a different population from the one
validated here. It does not, and the reason is worth writing down because the row
counts alone point the wrong way.

**The writer has no position filter.** `syncWeeklyUsage`
(`server/services/nflverse.js:255-265`) writes every REG-season row from the
nflverse weekly CSV whose `gsis_id` matches a row in `players`. Kickers, punters,
linemen and defenders all land in `player_week_usage` if the player exists in
`players`. The filter lives one level up, in `players` — and on this rebuild
`players` is 8,294 rows that are exactly WR 3,250 + RB 2,452 + TE 1,584 +
QB 1,008, already fantasy-only, so 100% of its usage rows are QB/RB/WR/TE with
zero orphans. Live's `players` is 965 ESPN-roster-sourced rows and is not
restricted that way.

**What the source file actually contains**, counted directly from
`stats_player_week_{season}.csv`, regular season only:

| season | QB/RB/WR/TE rows | distinct players | K rows | all other positions |
|---|---|---|---|---|
| 2023 | 5,801 | 577 | 543 | 11,462 |
| 2024 | 5,864 | 589 | 543 | 11,723 |
| 2025 | 6,037 | 610 | 543 | 11,960 |

The rebuild's `player_week_usage` holds 5,801 / 5,864 / 6,037 at 577 / 589 / 610.
**It is complete — exactly at the source ceiling on all six numbers.** Live's
extra rows are the non-fantasy positions: 2025 alone offers LB 2,939, CB 1,987,
DT 1,526, SAF 1,455 and DE 1,408 to a `players` table that carries some of them.

Two consequences follow, and they are the useful part:

1. `history()` (`server/services/projections.js:292` and `:300`) carries
   `AND p.position IN ('QB','RB','WR','TE')` on both of its branches, and
   `replaySeasonWeekly` grades by iterating the projection map. Non-fantasy usage
   rows cannot enter the graded set however many of them exist.
2. **The graded `n` on live can only be equal to or smaller than the numbers
   below, never larger.** The writer cannot produce more fantasy-position rows
   than the source file holds, and the rebuild already holds all of them.

Read the gate's graded `n` accordingly. It tracks fantasy-position rows in weeks
5-18 nearly one to one — the rebuild has 4,623 such rows in 2025 and graded
n = 4,468, a ratio of 96.7%, the remainder being rows with no prior in-season
history to baseline against.

- **at or just below 4,361 (2024) and 4,468 (2025)** — same population, the
  vector transfers, proceed.
- **materially below** — live's `players` is missing fantasy players who played
  those seasons, so the walk-forward fit ran on a thinner set than was validated
  here. Understand it before the write, not after.
- **above** — cannot happen against this source. If it does, a premise is wrong
  rather than the fit, and it should stop the write until it is understood.

## 4. Two defects found on the way

- **`syncDepthCharts` reported success while storing nothing.** Seasons through
  2024 date their rows from `game_lines`, and with no schedule loaded every row
  is dropped for want of a date — while the function returned
  `{ rows: 0, seasons_loaded: 6, failures: [] }`. Downloading rows and storing
  none now raises, naming the missing dependency. With the schedule loaded first,
  the same call stores 180,069 rows.
- **Two scripts were unrunnable off the author's laptop**
  (`eval-redistribution.mjs`, `grade-harness.mjs` hardcoded an absolute
  `/Users/...` path). Now resolved relative to the script.

## Is it well built, is it based on stats, how do we know, where else should it point, what does it unify

**Is it based on stats.** Every number on this page was re-measured on
2026-09-19 against a database built from the public sources the app itself uses,
and the live readings that replaced the two hedges were taken on the machine.

**How do we know.** The gate is pre-registered, walk-forward, with the ensemble
re-fitted inside each arm and a player-clustered paired bootstrap. Where a claim
is inferred rather than measured it is marked as inferred in the sentence that
makes it. The graded population is bounded by counting the nflverse source files
directly rather than by trusting a row count — section 3b.

**What is not evidence.** The level check in
`scripts/measure-shrinkage-blast-radius.mjs --vs-actuals` grades against the
season the projection is built from. It shows the current constants sit low, and
nothing more. The forecast evidence is the gate's, and as of this writing the
gate has not been run against the live database.

**Where else this should point.** The opportunity signal itself does not earn a
surface — section 3 refuses it, and the cascade multipliers were refused on the
same bar in `docs/tdd/cascade-grade.tdd.md`. What does travel is the
roster-as-of-prior-weeks slice construction: any surface asking "who is out and
who inherits" hits the same silent-zero defect without it.

**What it unifies.** Two independent grades now agree that the shipped volume
constants are beaten and the fitted ones win — one on points, one on opportunity,
built from different rebuilds and different slices.

## Reproducing this

```
node scripts/migrate.mjs                          # empty database
node -e "..."                                     # nflverse + ffopportunity + games.csv sync
node scripts/study-opportunity-volume.mjs         # section 3
node scripts/promote-volume-shrinkage.mjs --dry-run   # section 2
```
