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
correct. What is missing is that `shrinkage_fits` and `shrinkage_k` are empty —
**measured on this rebuild, not on the live database**, which exposes no route
for those tables. If production already carries an active fit, the "before" arm
of every comparison here is not what production is running. Worth one query
before relying on any of it.
Running `node scripts/promote-volume-shrinkage.mjs` (without `--dry-run`) against
the live database, then re-running `scripts/promote-weekly-ensemble.mjs`, is the
whole change. It moves live start/sit output, so it is deliberately not done from
here.

The start/sit figures above match an earlier recorded run (0.6274 → 0.6336) to
within 0.0004, which means this gate has been run before and the fit was still
never persisted.

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

## Reproducing this

```
node scripts/migrate.mjs                          # empty database
node -e "..."                                     # nflverse + ffopportunity + games.csv sync
node scripts/study-opportunity-volume.mjs         # section 3
node scripts/promote-volume-shrinkage.mjs --dry-run   # section 2
```
