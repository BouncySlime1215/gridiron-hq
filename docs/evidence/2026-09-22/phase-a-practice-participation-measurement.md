# Phase A, practice participation — measured, not rebuilt

Ran 2026-09-22 after routes run and red-zone usage. **Verdict: practice
participation does not earn a place as a production feature, and the existing
build in the tree is already pointed at the right question.** Nothing should be
built here.

This one fails for a different reason than the other two, and the reason is the
finding.

## 1. What already exists — the reason this was a measurement, not a build

`server/services/contingency.js:121-144` defines two fitted stores,
`nfl_availability_rates` and `nfl_availability_role_rates`, keyed on normalised
`report_status` (out | doubtful | questionable | none) and `practice_status`
(dnp | limited | full | none), producing `p_active` with shrinkage toward a
parent cell and a `fitted_at` stamp. They are fitted by
`scripts/fit-availability.mjs`. The feed is real: `nfl_injuries` is populated by
`syncInjuries` at `server/services/nfl-advanced.js:359`, and consumers exist —
`football-context.js:118-129` (`playProbability`), `draft-assist.js:903`,
`role-scenario-engine.js:158`.

So the existing build answers **"will he play?"**. What nothing in the tree
does is use practice participation to predict **how well he plays given that he
does**. That is the untested axis, and it is not an opportunity-volume proxy,
which is why it was worth the harness time after two volume nulls.

## 2. Data availability — and unlike participation, this one is live

`injuries_{season}.csv` from nflverse, downloaded and content-checked:

| season | rows | note |
|---|---|---|
| 2018 | 5,148 | |
| 2024 | 6,263 | full season |
| 2025 | 6,068 | full season |
| **2026** | **433** | **weeks 1-2, current** |

`practice_status` in 2026 is populated — Full 216, Limited 116, Did Not
Participate 100, one blank — and `report_status` gives Questionable 79, Out 75,
Doubtful 12. 43,560 report rows keyed across 2018-2025 after normalising
exactly as `contingency.js` does.

This matters: it is the first feature in this sequence whose input is available
for the current season, so had it cleared the gate it could have shipped.

## 3. The gate

Baseline knows prior targets, receptions, yards, PPR, snap share, games,
position. The added feature is the **current week's** injury report, which is
published before kickoff and is therefore legitimately available at prediction
time — unlike the lagged averages the other features used.

| model | MAE | RMSE | R² | gain, 95% CI | verdict |
|---|---|---|---|---|---|
| full baseline | 4.7750 | 6.3836 | 0.3218 | — | — |
| + practice status (dnp/limited/full) | 4.7742 | 6.3811 | 0.3224 | +0.0007 [-0.0032, +0.0047] | not detected |
| + report status (questionable/doubtful) | 4.7741 | 6.3800 | 0.3226 | +0.0010 [-0.0020, +0.0041] | not detected |
| + both | 4.7743 | 6.3806 | 0.3225 | +0.0006 [-0.0034, +0.0047] | not detected |

Controls behave: shuffling practice status within season-week-position makes the
model *worse* (-0.0020, CI [-0.0039, -0.0002]), which is the correct signature
of injected noise; the duplicated-snap-share no-op moves nothing (+0.0000).

Population: of 25,523 modelled player-weeks, 20,397 have no report, 3,227 full,
1,474 limited, 404 DNP, 21 none.

## 4. Why it fails, which is the actually useful part

Mean PPR by current-week practice status, among players who played:

| practice status | n | mean PPR |
|---|---|---|
| no report | 20,397 | **7.803** |
| full | 3,227 | 9.248 |
| limited | 1,474 | **9.545** |
| dnp | 404 | 9.262 |
| none | 21 | 9.081 |

Two things fall straight out:

1. **Appearing on the injury report at all predicts a *higher* score** — 9.2 to
   9.5 against 7.803 for the unreported. That is selection, not football: teams
   file reports on players who matter, so the report is a marker of being a
   starter. A naive reading of this table would have a model *upgrade* an injured
   player, and the baseline already knows he is a starter through targets and
   snap share, which is why nothing is left to gain.
2. **Within the reported group, practice status barely separates, and not
   monotonically** — limited (9.545) grades above full (9.248), and DNP (9.262)
   is indistinguishable from full. Players held out of practice and playing
   anyway are disproportionately stars getting a rest day, and "limited" is
   most often a minor knock on a high-volume starter.

So conditional on a player being on the field, the injury report tells you
almost nothing about his production. **Its information is entirely about
whether he plays, not how well** — which is exactly what
`nfl_availability_rates` already models. The existing build is pointed at the
right question, and the feature Nick's brief asks for would be a second,
worse answer to a question already answered.

## 5. Where this leaves the deep predictive feature set

Three features, three nulls, three *different* reasons — which is why this is
information rather than a losing streak:

| feature | why it failed |
|---|---|
| routes run | real signal, statistically indistinguishable from snap share |
| red-zone touches | real signal, fully absorbed by targets plus snap share |
| practice participation | carries availability information, not production information; already modelled |

Two of Nick's seven remain genuinely untested and are neither volume proxies nor
availability signals:

- **Depth-chart change** — a role change, which volume features can only see
  *after* it appears in the volume. `nfl_depth` already exists at
  `server/db/schema/nfl-a-to-m.js:59-63` with `pos_rank` and `pos_slot`, so this
  is again a measurement rather than a build, and it is the one remaining
  feature whose information is genuinely ahead of the volume channel.
- **OL-vs-DL matchup** — changes the value of a touch rather than its count, so
  it does not collide with the saturated volume channel. It needs a labelled
  proxy, since true line-matchup data is not free.

**Recommendation: depth-chart change next**, for the same reason this one was
picked — it already exists in the schema, and its information is the kind that
leads volume rather than trailing it.

I also want to name the possibility honestly rather than let three nulls
accumulate quietly: weekly PPR R² sat at 0.3218 and nothing moved it past
0.3226. It is worth considering that the weekly ceiling here is noise-limited
rather than feature-limited, in which case the honest deliverable for Nick is
not a bigger feature set but a stated confidence interval on every projection
the platform shows. That is a decision above this thread.

## 6. Stated limits

Ridge regression, as with the other two proofs; no numpy, pandas or sklearn in
this container. The DNP-and-played cell is 404 player-weeks, so a real effect
confined to that cell could hide inside the interval — though note the point
estimate there is *above* the full-participation mean, not below it, so the
direction argues against a hidden penalty.

## The five questions

- **Well built?** Nothing built, deliberately — and the finding is that the
  thing already built is correct.
- **Stats or made up?** Stats. 43,560 injury-report rows, 25,523 out-of-sample
  player-weeks, every interval stated.
- **How do we know?** Purged walk-forward, current-week report used because it
  is genuinely pre-kickoff information, paired bootstrap by player, two controls.
- **Pointed anywhere else on the platform?** The existing availability build is,
  at `football-context.js:118-129`. The new feature is not, because it did not
  earn it.
- **How does it unify?** By *not* being added: `nfl_availability_rates` already
  carries this information at the layer where it belongs.
