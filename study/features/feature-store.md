# The weekly feature store as the substrate — what it added, and what it bought

**Produced:** 2026-09-17.
**Code:** `server/services/nfl-weekly-feature-store-v2.js` (study-only copy; production stays on v1 — see that file's header), `scripts/backfill-feature-store.mjs` (new), `scripts/grade-feature-vector.mjs` (new).
**Reproduce:**

```bash
node --env-file-if-exists=.env scripts/backfill-feature-store.mjs      # ~7 min, writes a 1.8GB study database
node --env-file-if-exists=.env scripts/grade-feature-vector.mjs        # ~6 min
```

---

## 1. Headline

Four feature families were graded separately under the cutoff-safe procedure. **Three returned exact nulls** — zero weight in the blend, meaning the fit could not find any use for them at all. The fourth, the whole player vector through a ridge, **passes the gate with a real but very small effect**, and survives a placebo.

| Family | Features | Head weight | 2025 (held out once) | Out-of-sample seasons | Season-clustered 90% CI | Gate |
|---|---|---|---|---|---|---|
| (a) man/zone split × opponent man rate, receivers | 10 | **0.00** | not opened | 0/5 | [0.0000, 0.0000] | FAIL |
| (b) deviation transforms only (`delta_1`, `slope_6`) | 272 | **0.00** | not opened | 0/5 | [0.0000, 0.0000] | FAIL |
| (c) full player vector, ridge | 871 | **0.50–0.60** | **−0.11% MAE** (4.6727 → 4.6676) | **5/5** | **[+0.0152, +0.0257]** | **PASS** |
| (d) O-line continuity + pressure allowed | 17 | **0.00** | not opened | 0/5 | [0.0000, 0.0000] | FAIL |
| (e) **placebo**: (c)'s features on the wrong player | 871 | **0.00** | not opened | 0/5 | [0.0000, 0.0000] | FAIL |
| (f) **decomposition**: (c) minus the v2 keys | 613 | 0.40 | −0.05% (4.6727 → 4.6704) | 4/5 | [−0.0011, +0.0090] | FAIL |
| (g) **decomposition**: only the v2 keys (`apm_`, `mz_`) | 259 | 0.30 | **−0.54%** (4.6727 → 4.6475) | 4/5 | [+0.0062, +0.0214] | **PASS** |
| (h) **calibration oracle**: leave-one-out season mean | 1 | 0.40–0.50 | −0.95% (4.6727 → 4.6284) | 5/5 | [+0.0467, +0.0699] | PASS |

Read the last three rows before the ones above them. They were added in review and they change what §4 and §6 can say.

- **(f)/(g): (c)'s effect is not "the whole vector reweighted." It is the 259 keys v2 added.** Split the 870 surviving keys at the v1/v2 line and the 612 pre-existing ones fail the gate outright (+0.0023 on 2025, bootstrap flat), while the 259 new ones — regularised APM and the per-receiver man/zone counts — clear it with **five times** (c)'s forward effect and a paired bootstrap that **does** clear zero (mean −0.0248, 90% CI [−0.0457, −0.0051], `p_b_better` 0.978). Pooling them diluted the only thing in this wave that moved, which is exactly the failure mode §1 of the grading script warns about. Neither half works alone: `apm_` by itself is 3/5 and flat, `mz_` by itself is 1/5 and flat. It is the pair, and it is one post-hoc look at a season this file has now opened four times, so it is a hypothesis to pre-register — not a result.
- **(h): this gate cannot separate a real improvement from a small oracle.** A single feature — the player's own leave-one-out *season mean*, which contains his scores in later weeks of the same season and which no live model can ever have — clears the same bar 5/5 at +0.048 on 2025, an order of magnitude above (c). That number is the size of the entire remaining player-level opportunity, and 2026-09-17 already measured that the same quantity used standalone *loses* to the production ensemble. Everything in this table should be read as a fraction of +0.048.
- **This is an MAE proxy, not TARGET-SPEC's gate.** §5 of TARGET-SPEC says in so many words that MAE is *replaced* as the gate for a projection change: attainable-arm all-play win rate is primary, minimum practical effect 0.010. Nothing here measures it. "PASS" above licenses running the all-play replay; it does not license promoting anything.

A zero head weight is not a near-miss. The base and candidate weight grids share a step, so the five-head baseline is literally a point in the six-head grid with the head at zero. When the fit chooses that point it is saying the head is worthless *given what we already have* — and every downstream number is then identically zero by construction.

**The size of the win in (c): between +0.005 and +0.026 MAE points on a scale of ~4.67.** That is 0.1% to 0.5%. The honest forward number — fit 2021–23, select 2024, open 2025 once — is the small end: **+0.0051, and the paired bootstrap over player-weeks does not clear zero** (90% CI [−0.031, +0.022]).

**The one number that moved more than MAE did:** Spearman rho on 2025 went **0.5936 → 0.6089**. Rank quality is what a lineup decision consumes, and this is a +0.015 move against an MAE move of +0.0051. It is not proof of anything — TARGET-SPEC's real gate is the attainable-arm all-play rate, which this wave did not run — but it is the only direction in these results worth another day.

---

## 2. What was added to the store

The store already ingested `nfl_team_week_features`, `nfl_snaps`, `nfl_injuries`, `nfl_player_week_features`, `nfl_ngs` and `nfl_pfr_adv`. Its scheme coverage was the gap: `nfl_play_formations` is empty, `nfl_play_charting` is 2026-only, `nfl_pfr_adv` starts in 2024. For 2021–2025 there was no coverage shell, no motion, no play-action and no personnel anywhere in the store.

Three read-only satellite databases now fill it. They are cached once per process and merged through `mergePrior`, which drops every observation that is not strictly earlier than the target week.

| Source | Database | What it adds |
|---|---|---|
| `adv_team_week` | `line_history.sqlite` | motion, play-action, RPO, screen, no-huddle, coverage shells, personnel, pressure — both sides, 2020–2025 (FTN columns start 2022) |
| `pbp_participation` × `play_by_play` | `nflverse.sqlite` | coverage shells faced/generated, blitz, defenders in box, pressure, time to throw, personnel groupings, **and the per-receiver man/zone split** |
| `snap_counts` | `nflverse.sqlite` | O-line continuity: same five starters as last week |
| `player_value_weekly` | `player_value.sqlite` | regularised APM (`value_epa`) per player-week |

The version moved to `nfl-weekly-feature-store-v2`. The vector tables are immutable by trigger, so a new source family has to arrive as a new version; v1 vectors stay readable at their own version.

### Backfill, measured

| | Rows | Time | Avg features | Avg coverage |
|---|---|---|---|---|
| Team vectors, 2021–2025 wk5–18 | 2,078 | 93s | 4,197–4,452 | 0.962–0.965 |
| Player vectors, 2021–2025 wk5–18 | 20,451 | 316s | 948–974 | 0.904–0.909 |

154 player-weeks (0.7%) had no prior observation at all and got no vector. Database grew from 675MB to **1,798MB**.

**The backfill writes to a copy, not to production.** 1.1GB of research vectors do not belong in a database a refresh loop writes every fifteen minutes and that has already had one WAL blowup. `VACUUM INTO` takes a consistent snapshot of the live file and the backfill lands in `data/derived/feature-store-study.sqlite`. Production still gets the vector where it needs one — the live weekly freeze writes the current week only, ~1,500 rows.

**Corrected in review: that last sentence understates the production cost, and the arithmetic in it points the wrong way.** A v2 player vector is 33.4KB of JSON against v1's 23.8KB, and a v2 team vector is 156KB against 87.8KB. ~1,500 player rows plus 32 team rows is ~55MB *per week*; across an 18-week season that is 27,000 rows and roughly 1GB — **more rows and more bytes than the 20,451-row backfill that was deliberately kept out of production.** Deferring the backfill does not avoid the growth, it only delays it by one season. Whether production should carry the v2 surface at all is a real decision and it is not settled by "the weekly freeze is small."

### Man/zone split coverage

Receivers (WR/TE/RB/FB) with enough routes against **both** man and zone for the split to be stable, at 20 routes each:

| Season | Receivers with routes | Stable split |
|---|---|---|
| 2021 | 557 | **334** |
| 2022 | 537 | **318** |
| 2023 | 513 | **374** |
| 2024 | 527 | **371** |
| 2025 | 524 | **341** |

That is ample. The family's null is not a sample-size null.

**One trap worth recording:** `pbp_participation.offense_positions` only exists from 2023. The first backfill silently produced **zero** man/zone observations for 2021 and 2022 — which would have left family (a) with one fit season and no way to notice. The fix is a `roster_weekly` fallback for the position of each participant.

---

## 3. Why three families returned exact zeros

The prior from 2026-09-17 was that the player level is saturated: the ensemble at MAE 4.390 already beats a leave-one-out season-mean oracle at 4.411. The open question was whether anything discriminates a player's **good weeks from his bad weeks**.

**(a) The man/zone interaction was the one candidate with a strong prior, and it is dead.** The head is genuinely different information — it correlates 0.54 with structural, well below the 0.95 that killed xFP — but standalone it is at MAE 5.511 against structural's 5.116 on the same rows, and the fit gives it nothing. A receiver's man-versus-zone efficiency gap, crossed with the opponent's own prior man rate, does not tell you which weeks he goes off. The interaction varies by opponent, which was the whole argument for it; it varies in a direction that does not pay.

**(b) The within-player deviation transforms are dead.** 272 features of `delta_1` and `slope_6` over the whole vector, standalone MAE 5.745, zero weight. Weekly movement in a player's own measured state is not predictive of weekly movement in his scoring.

**(d) O-line continuity and pressure allowed are dead.** This family had the cleanest mechanism story — a shuffled line is a real short-lived shock — and it produced a head correlating **1.00** with the structural projection. It is a reparameterisation of what the model already has, not new information.

---

## 4. The one positive, and how hard it was pushed

Family (c) — all 871 player-vector features at ≥80% fit-season coverage, through a ridge with the penalty chosen on 2024 — takes 0.50 to 0.60 of the blend weight and beats the baseline in **5 of 5 out-of-sample seasons**.

Three things were done to try to break it:

1. **The placebo.** The same 871 features permuted within their own season-week, so every marginal distribution and every row count is identical and only the link between a player and his own history is destroyed. The placebo takes **zero weight**, ridge drives its penalty to λ=10, its standalone MAE is 6.278, and it correlates **0.01** with all five existing heads. The gate is measuring the features, not the procedure.
2. **Overfitting, measured rather than assumed.** 871 features over 11,891 fit rows is 13.7 rows per feature. The train/test gap is **+0.1203 MAE (2.6%)** — the ridge is holding. The placebo's gap is +0.0577, so the honest model is working harder and still generalising.
3. **The in-sample seasons were removed from the gate.** The first run of the grading script counted 2021–2023 as five-season evidence for a model fitted on 2021–2023, and the family "passed" on its own training data while *losing* on 2025. The gate is now leave-one-season-out, so all five signs come from models that never saw the season they score.

**What it is not.** The head correlates 0.88–0.94 with the existing five, so at the level of the blend this is not new information — it is a better-weighted version of the same information. The 2025 forward result (+0.0051) is a quarter of the leave-one-season-out mean (+0.0205), and that gap is the price of only being allowed to use the past. The player-week bootstrap on 2025 does not clear zero.

**Corrected in review: the last sentence of that paragraph is the interesting one, and the reason (c) fails it is that (c) is the wrong family.** Families (f) and (g) split the 870 keys at the v1/v2 line. The 612 keys the store already had are dead — +0.0023 on 2025, interval through zero, the same null the 15-key ridge in `test-new-heads.mjs` already returned over the same surface. The 259 keys v2 added carry the effect on their own: **−0.54% on 2025 (4.6727 → 4.6475), paired bootstrap mean −0.0248 with 90% CI [−0.0457, −0.0051]**, and a train/test gap of 0.6% against (c)'s 2.6% at 46 rows per feature rather than 13.7. Diluting 259 live features with 612 dead ones cost roughly 80% of the effect and pushed the bootstrap back through zero.

Three caveats that keep this from being a promotion:

1. **It is post-hoc.** The split was run after (c) had already been seen to pass, on a TEST season this script now opens four times. Family-wise error is not controlled; one bootstrap at `p_b_better` 0.98 among four looks is roughly what chance delivers.
2. **Neither source works alone.** `apm_` alone is 3/5 with a flat interval; `mz_` alone is 1/5 with a flat interval. Only the 259 together move. That can be a real interaction a 259-dimension ridge can express and an 82- or 178-dimension one cannot — or it can be selection noise. The two are not distinguished here.
3. **The imputation is not what is driving it.** `subsetVectorFeatures` fills an absent key with a raw 0 that standardises into a large negative outlier, i.e. an implicit missingness indicator. Re-running (g) with fit-season *median* imputation, which standardises to a neutral zero, gives +0.0245 and the same significant bootstrap. Checked, and null: the effect is in the values, not in the missingness pattern.

---

## 5. Defects found in the store itself

These are real and were not fixed in this wave.

1. **`z_latest` is never computed for players.** `buildPlayerFeatureVector` passes an empty league map to `transforms`, so players get 12 of the 13 advertised transforms and **zero** `z_latest` features — confirmed on the frozen vectors. Family (b) is therefore `delta_1` and `slope_6` only. Those are the genuinely within-player transforms (`z_latest` is cross-sectional), and under a linear fit that already contains `latest`, `z_latest` is an affine reparameterisation whose only new content is the week-varying league mean and sd — so the expected cost of the gap is small. The fix is a cached per-(season, week) league cross-section; it was skipped because it would mean rebuilding all 20,451 frozen vectors for a transform with a weak prior.
2. **Team `z_latest` covers only 183 of 361 raw metrics.** `teamLeagueLatest` reads `nfl_team_week_features` alone, so none of the new satellite metrics get a league-relative z.
3. **`nfl_feature_dictionary`'s primary key is `feature_id` without the version**, so a v2 insert is silently ignored for any feature id v1 already registered. The dictionary reports 300 player and 2,004 team features at v2 — those are the *new* ids, not the full v2 surface.
4. **The man/zone axis does not exist for 2026.** `pbp_participation` ends at 2025 and `adv_team_week`'s 2026 rows have no `man_rate`. Even if family (a) had worked, it could not be run live this season.

Found in review, and these three are about the *server*, not the study:

5. **Warming the satellites costs ~10.6s of blocked event loop and ~500MB of permanently resident heap, inside the server process.** `node:sqlite` is synchronous, the participation scan joins ~170,000 plays, and the caches are process-lifetime with no release. The first v2 `freezeWeeklyFeatureState` pays it — and that runs from `nfl-model-growth.js:242`, reachable both from `scheduler.js:701` and from the `/nfl-betting` route, so the whole HTTP server stalls for those eleven seconds and then carries the half gigabyte for the life of the process. On an 8-core Mac that already has load problems this is not free. It wants either a `releaseSatelliteCaches()` called after the weekly freeze, or an env gate that keeps the satellites out of the server and in the study scripts.
6. **A missing satellite degrades the vector without changing the version.** `satellite()` catches the open error and returns null by design, so a v2 vector frozen on a machine without `data/line-history/nflverse.sqlite` has a materially different feature surface from one frozen with it — and the version string, which is supposed to identify that surface, says `v2` either way. `satelliteStatus()` was added in review and is now reported by `weeklyFeatureStoreStatus()`, so at least the condition is visible on the status endpoint; the version contract is still weaker than it reads.
7. **The satellites reach one season below `TRUSTED_HISTORY_START`.** `SATELLITE_FLOOR = TRUSTED_HISTORY_START - 1` is justified by the 12-week lookback crossing a season boundary, but it means a production 2022 vector can carry 2021 satellite observations while the store's own policy string still says quarantined seasons are not used in rolling state. Strictly prior, so not a leak — but the policy and the code disagree.

---

## 6. What this means for the plan

The measured picture from 2026-09-17 holds and got sharper. Player-level aggregates are saturated; this wave tested **week-level** signal, which was the remaining hypothesis, and three of the four week-level families returned exact zeros — including the man/zone interaction, which had the strongest prior of anything in the wave.

The closest thing to earning its place is not one of the four designed families. **Corrected in review: nor is it "the whole vector reweighted."** It is the 259 keys this wave actually added — regularised APM plus the per-receiver man/zone counts — which carry five times (c)'s forward effect once the 612 dead v1 keys are taken out from around them (family (g), −0.54% on 2025 with a bootstrap that clears zero). What moves most is still rank order: rho 0.5936 → 0.6059 for (g), 0.6089 for (c).

The next test worth the day is therefore narrower than "run (c) through all-play," and it is two steps:

1. **Pre-register the 259-key family and run *that* head through the attainable-arm all-play replay.** That is TARGET-SPEC §5's actual gate, minimum practical effect 0.010 all-play, and it is where a rank improvement would show up. The 259-key head is the better object to send: fewer parameters, a 0.6% train/test gap, and a forward effect that is not buried.
2. **Before believing either, put the calibration oracle next to it.** Family (h) — the player's own leave-one-out season mean, which is unavailable to any live model — clears the same MAE bar at +0.048. Any candidate here is between 5% and 50% of an oracle whose *standalone* version is already known to lose to production. That is the honest size of what is left.

If neither moves all-play, the projection is finished and the effort belongs on availability and the person side, exactly as section 6 of TARGET-SPEC already says.
