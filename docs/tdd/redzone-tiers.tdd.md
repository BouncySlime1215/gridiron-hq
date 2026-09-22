# Red-zone opportunity tiers — TDD report

**Item:** split the pooled middle red-zone tier in `td-regression.js` so expected
touchdowns are priced against the band a touch actually came from. Handed over
by the Data & techniques R&D thread (REDZONE-SPEC.md, `band.mjs`, `share.mjs`,
`classes.mjs`), measured by it on nflverse play-by-play REG 2022-2025.

**Files changed:** `server/services/td-regression.js`,
`server/services/nfl-pbp.js` (additive), `test/redzone-tiers.test.js`, this
document. Both service files are other threads'; the coordinator granted a
narrow additive carve-out.

**Base:** `main` at 654ff93. Commits: RED `f4ac603`, GREEN `94daebc`.

---

## 1. Audit — what the repo actually prices

Read from the code rather than from the spec, and the two halves came out
differently.

| | counter | definition | where |
|---|---|---|---|
| rushing | `red_zone_carries` | `yl100 <= 20` | `nfl-pbp.js:371`, emitted `:608` |
| rushing | `goal_line_carries` | `goal_to_go` | `nfl-pbp.js:372`, emitted `:608` |
| rushing | inside the 10 | **did not exist** | — |
| receiving | `red_zone_targets` | `yl100 <= 20` | `nfl-pbp.js:398`-ish, emitted `:621` |
| receiving | `end_zone_targets` | `yl100 <= 10` | `nfl-pbp.js:398`, emitted `:641` |
| receiving | `goal_to_go_targets` | `goal_to_go` | `nfl-pbp.js:400`, emitted `:642`, **no consumer** |

**Rushing: the handoff is right.** No inside-10 counter exists, so the middle
tier genuinely pools a 16.4% band (n=1,030) with a 4.5% band (n=4,795) at a
blended 6.6%. New counter, new tier.

**Receiving: the handoff misreads the repo.** `end_zone_targets` is not
end-zone targets despite the name — it is `ez_tgt`, `yl100 <= 10`. That band was
already separate. What is pooled is goal-to-go with the rest of the inside-10
band, and the counter for it has been written to the blob all along with
`REC_CLASSES` never reading it. So receiving needs **no ingest change**: one new
class over data already collected. R&D was told, so its own 2.1x receiving
figure can be re-derived against the real definitions.

## 2. The trap this would have shipped

`exclusive()` (`td-regression.js:199` before this change) computed
`out[key] = Math.max(0, raw - (f[subtractFrom] ?? 0))`.

Re-pointing `red_zone_carries` at the new `inside_10_carries` means that on any
database ingested **before** that counter existed the key is absent, reads 0,
and `red_zone_carries` subtracts nothing — silently re-admitting goal-line
carries into the tier below. That is exactly the treble-counting the comment at
`td-regression.js:57-64` exists to prevent, arriving on live data with nothing
raising an error, and inflating expected touchdowns for precisely the backs
whose whole value is those touches.

**Fix, and it covers a second case the handoff did not raise.** The subtraction
takes the **larger** of the named parent and a declared `fallbackSubtractFrom`.
Absent handles the old database. Larger also handles a live one: goal-to-go is
**not** strictly a subset of inside-the-10, because a penalty can leave
first-and-goal outside the 10, so a blob can legitimately hold
`goal_line > inside_10` and subtracting the named parent alone would let those
carries leak down a tier.

## 3. RED → GREEN and the mutation table

RED failed with `Cannot destructure property 'exclusive' of '__test' as it is
undefined` — no test hook, no new tiers. GREEN is 7/7.

| Mutation | Result |
|---|---|
| `fallbackSubtractFrom` removed (old-database trap returns) | 2 fail |
| `max()` reduced to the named parent (leak returns) | 2 fail |
| inside-10 tier dropped from `RUSH_CLASSES` | 3 fail |
| goal-to-go tier dropped from `REC_CLASSES` | 2 fail |
| `Math.max(0, …)` floor removed (negative tiers) | 3 fail |
| counter moved from the 10 to the 20 | 1 fail |
| restored | 7/7 pass |

## 3b. The ablation — it passes, and the margin is small

Run after ingesting play-by-play 2022-2025 locally (21,427 player-weeks). Fit
on 2022-2024, scored **once** on 2025, replicating `fitRates` exactly (EM over
player-weeks, 12 iterations, `MIN_EXPOSURE` 200) with the class set and seeds as
parameters, so nothing in the repo was modified to run it. Both arms are the
real before and after, each with its own seeds. 5,229 scored player-weeks.

| | MAE | RMSE | Poisson NLL | bias |
|---|---:|---:|---:|---:|
| three tiers (before) | 0.27196 | 0.44280 | 0.45006 | -4.59% |
| four tiers (after) | **0.27010** | **0.44186** | **0.44861** | -4.85% |
| change | -0.68% | -0.21% | -0.32% | +0.26 pt worse |

**Significance, not just direction.** Paired, player-clustered bootstrap on the
per-row absolute error, 2,000 resamples, seed 20260917, 591 players: mean change
**-0.001859**, 95% CI **[-0.002678, -0.000125]**. The interval **excludes zero**,
so the improvement is real rather than noise.

**It is the tiers, not the seeds.** Refitting the four-tier arm with every seed
scaled by 0.5, 0.75, 1.5 and 2 moves the test MAE only between 0.27005 and
0.27068 — all of them still better than the three-tier arm's 0.27196. The seeds
wash out in the fit, which is what the EM is supposed to do and the confound
worth ruling out given that the seeds changed in the same commit.

**The honest caveat.** Total-touchdown bias gets slightly *worse*, from -4.59%
to -4.85% — the model under-predicts league touchdowns a little more than
before. The split improves per-player accuracy and does not fix, and mildly
aggravates, a pre-existing under-prediction. That is worth someone's attention
on its own and is not this change's to fix.

**Scale.** A 0.68% reduction in mean absolute error on expected touchdowns is a
small correction. It is the correction the measurement predicted, it is real,
and nobody should describe it as more than it is.

## 4. The five questions

1. **Is this well built?** The arithmetic, yes — the tiers partition the touches
   exactly once, the fallback is tested from both directions, and six mutations
   all die. It is additive: nothing existing in either file changed behaviour on
   a freshly ingested database.
2. **Is it based on stats, or made up?** R&D's band rates are measured on
   play-by-play 2022-2025 with stated n. **This thread still has not re-derived
   them.** A local ingest now exists, but it stores per-player-week totals rather
   than per-play bands (`nfl_play_by_play` comes back empty), so 16.4%-versus-4.5%
   cannot be checked from it — that needs raw play-by-play. The rates stay
   quoted. What *is* measured here is whether the split predicts better, which
   is §3b.
3. **How do we know?** For the arithmetic, §3. For the value of the split,
   **we do not know yet**: the gate is an A/B ablation, four tiers against
   three, fit 2022-2024 and tested on 2025, scored through `backtest.js`'s CRPS
   and PIT — and `nfl-model-watch.js:1-18` is the reason that is the gate rather
   than a correlation. It cannot run here for the same missing-database reason.
   Until it does, "this improves touchdown regression" is a **guess**.
4. **Should this data be pointed anywhere else?** Deliberately not. R&D measured
   the red-zone touch mix at r=0.55 within a season but **r=0.136 year over
   year** (89 player-season pairs), so it describes what happened and does not
   predict what will. It belongs in luck decomposition and must not be handed to
   the forward projection as a talent feature — doing so would manufacture the
   false confidence this module exists to strip out.
5. **How does it unify?** It reuses the existing nested-class machinery rather
   than adding a parallel one, so a number on a regression card and a number in
   the fitted rates still come from one place. `fitRates` refits the league
   rates from history, so no constant is hand-set.

---

## Amendment, same night: which half of the change earns the result

The ablation in `docs/evidence/redzone-tier-ablation.mjs` moved rushing and
receiving from three tiers to four **at the same time**, and reported one
number for the pair. A reader would take that as both halves earning their
place. It does not say that, and the decomposition below says something
narrower.

Prompted by the R&D thread withdrawing its own receiving recommendation after
re-measuring the band rates: 1.41x between the two halves of the inside-10
receiving tier, against 3.53x on the rushing side.

Each arm scored against the same 3/3 baseline, on the same 5,229 rows, paired
and player-clustered, 2,000 resamples, seed 20260917.
`docs/evidence/redzone-tier-decomposition.mjs`.

| arm | MAE | vs baseline | mean paired change | 95% CI | zero |
|---|---:|---:|---:|---|---|
| 3 rush / 3 rec (before) | 0.27196 | — | — | — | — |
| 4 rush / 3 rec | 0.27133 | -0.230% | -0.000626 | [-0.001019, -0.000053] | excluded |
| 3 rush / 4 rec | 0.27072 | -0.456% | -0.001240 | [-0.002076, +0.000418] | **included** |
| 4 rush / 4 rec (shipped) | 0.27010 | -0.684% | -0.001859 | [-0.002678, -0.000125] | excluded |

Two things are true at once and neither should be dropped in the retelling:

1. **The receiving tier has the larger point estimate**, twice the rushing
   tier's, and the two are very nearly additive (-0.230 and -0.456 predict
   -0.686; the pair measures -0.684). So the band-rate ratio R&D withdrew on —
   1.41x against 3.53x — does **not** rank the two halves by what they are
   worth to the served forecast. A ratio between bands is not an effect size;
   volume and how badly the pooled rate misprices the players in each band
   matter as much, and this is the shape `nfl-model-watch.js:1-18` exists to
   warn about.
2. **The receiving tier is not individually significant.** Its interval
   includes zero. The rushing tier's does not, despite the smaller point
   estimate — it is the tighter of the two.

So the correct statement about the receiving half is **"not established"**, not
"it does nothing" and not "it is the bigger win". R&D reached the right
conclusion by a route that does not support it; the right reason is the
interval, not the ratio.

The shipped 4/4 combination is what the gate tests and it passes. Nothing is
being ripped out here on a decomposition that was not the pre-registered
comparison. What changes is the claim: the original commit message and §3b
should be read as establishing the **pair**, and only the rushing half on its
own. Whether to keep the receiving tier is routed up rather than decided here —
the argument for keeping it is that the shipped combination passes the gate;
the argument against is that every extra class divides the same exposure, and
`MIN_EXPOSURE 200` is a real constraint on the smaller groups.

**Correction to §3b above.** Where it says the ablation "cannot run here for
the same missing-database reason", that was true when written and is no longer:
`syncPbpSeason` was called directly for 2022-2025, which is why these numbers
exist. §3b's "until it does, this is a guess" has been answered for the pair
and is still open for the receiving half alone.
