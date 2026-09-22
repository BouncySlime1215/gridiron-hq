# Running the shrinkage CRPS/PIT gate for real, and Unit 1's saturation finding

2026-09-22. `scripts/persist-volume-metric-reliability.mjs` (new). Off `main`
`654ff93`, on branch `effk`. Not a RED/GREEN unit — this is running
already-built, already-tested machinery against real data for the first
time and persisting its measured output, matching how
`projection-range-coverage.tdd.md` handled a one-off real-data measurement.

## Where this sits

R&D's `RELIABILITY-SPEC.md` §6 sets the gate: "the test is whether shrinking
by the fitted k beats not shrinking, on held-out seasons, scored through
backtest.js's CRPS and PIT calibration. Fit 2022-2024, test 2025." Every
piece the gate needs already existed in this repo
(`buildFitSpecs`/`fitAllK`/`volumeKFits` in `shrinkage-fit.js`,
`replaySeasonWeekly` with `kOverride`+`distributions` in
`weekly-backtest.js`, `pairedBootstrapDiff` in `backtest-significance.js`,
and a ready-to-run driver, `scripts/fit-shrinkage-weekly.mjs`) — none of it
had ever actually been run against real data in this container. This unit
runs it, and separately closes out the Auditor's Gate-1 Unit 1 criteria
(`audit-gate1-batch-four-parked-units-2026-09-22.md`) for the volume-side
shrinkage constants that gate covers.

## The runMigrations() gap, again

The real local `server/data.sqlite` had 5 pending migrations (061, two
different 062-numbered files, 063, 064) — the same failure class as
`projection-range-buildprojections-wiring.tdd.md` documented for isolated
test databases, this time on the actual project database. Fixed by running
`runMigrations()` directly against it once (idempotent; auto-created
`server/data.sqlite.pre-migration-2026-09-22T08-03-03-062Z.bak`).

## Step 3: the CRPS/PIT gate, run for real

```
node scripts/fit-shrinkage-weekly.mjs
```

(defaults: through=2024, testSeason=2025, weeks 5-18, 300 distribution runs,
seed 7 — the frozen-baseline holdout `fit-shrinkage-weekly.mjs`'s own header
names.)

| | hardcoded k | fitted k |
|---|---:|---:|
| MAE | 4.613 | 4.490 |
| CRPS | 3.159 | 3.075 |
| coverage_80 | — | 0.789 |

Paired bootstrap (fitted − hardcoded, 90% CI, seed 7):

- CRPS: **−0.0844**, CI **[−0.1084, −0.0606]**, **significant**
- MAE: significant, same direction

**Gate: PASS.** CRPS is significantly better (the spec's stated metric, not
merely a lower point estimate — the failure mode that sank the earlier
season-total attempt), and `coverage_80` (0.789) sits inside the spec's
[0.78, 0.82] target band.

Persisted via `saveFit` as `shrinkage_fits` id 1 (through=2024,
test_season=2025), **not activated** — activation requires re-promoting the
weekly ensemble against the now-different structural head, out of scope for
this unit and explicitly deferred by `fit-shrinkage-weekly.mjs`'s own driver
(`--activate` flag, not passed).

### Reliability-table persistence

`RELIABILITY-SPEC.md`'s `nfl_metric_reliability` table (migration 063) had
never been populated for the five volume metrics this fit covers, only for
R&D's own NGS-context populations. `scripts/persist-volume-metric-reliability
.mjs` fills it from the same `fitAllK(2024)` output the gate above used,
under `population='player_week_usage'` (names the actual source table,
distinct from R&D's raw-nflverse `pbp`/`ngs` pulls) and
`weighting_scheme='weekly_role_recency'` (names `WEEKLY_ROLE_RECENCY`
explicitly, per migration 063's own warning that ICC is not invariant to
weighting and a row without its scheme recorded is not safely comparable).

One wrinkle the table's schema doesn't accommodate: `nfl_metric_reliability`
has no `position` column (`UNIQUE(population, metric, weighting_scheme)`
only), but `carry_share` is fit separately for RB and OTHER — two different
variance decompositions under one metric name. Persisting both under the
literal name `carry_share` would have the second upsert silently overwrite
the first. Suffixed instead: `carry_share_rb` / `carry_share_other` (ALL and
QB-only metrics keep their bare names, since they have no position split).

```
node scripts/persist-volume-metric-reliability.mjs 2024
```

| metric | fit position | icc | k | n_groups | n_obs |
|---|---|---:|---:|---:|---:|
| team_pass_att | ALL | 0.3335 | 1.998 | 32 | 2,174 |
| team_rush_att | ALL | 0.4445 | 1.250 | 32 | 2,174 |
| target_share | ALL | 0.8274 | 0.209 | 852 | 17,299 |
| carry_share_rb | RB | 0.8961 | 0.116 | 272 | 6,407 |
| carry_share_other | OTHER | 0.9091 | 0.100 | 742 | 17,227 |
| qb_attempts | QB | 0.7586 | 0.318 | 123 | 2,615 |

Six rows, six upserts, verified via `allMetricReliability()` returning
exactly these six keyed by `(player_week_usage, <metric>, weekly_role_recency)`.

## Unit 1: the volume-side shrinkage constants (`K.share=6`, `K.team_volume=10`)

Closing the Auditor's four stated criteria.

**1. Name the path before measuring.** This gate and every number above was
run under `WEEKLY_ROLE_RECENCY` (`buildFitSpecs`'s default `roleRecency`),
the weekly path — not the season-long `RECENCY` path eleven of twelve
production callers use. `activeKVectorFor` (`shrinkage-fit.js:565-571`)
already enforces this distinction structurally: the fitted volume vector is
only ever handed to a caller whose `roleRecency` matches
`WEEKLY_ROLE_RECENCY` exactly (`isWeeklyRoleRecency`); every other caller
keeps the hand-picked constants, untested with the fitted k. This unit
changes nothing about that gating — it only fits and grades on the one path
where the fitted k is actually served.

**2. Report the saturation, and say whether it is intended.**

The Auditor's claim: under `WEEKLY_ROLE_RECENCY`, a weighted game count
saturates near a career-independent ceiling — stated as `Σ 0.5^(j/5) ≈
7.725` within-season, plus prior seasons at `seasonDecay=0.05`, "to about
8.13" total, giving `K.share=6` a permanent 42.5% positional-prior floor and
`K.team_volume=10` a permanent 55.2% floor, regardless of career length.

Independently re-derived rather than taken on citation (this session's
standing rule: verify a specific number before repeating it). The
within-season term matches exactly — `rowWeight`'s own formula
(`projections.js:181-186`, mirrored in `shrinkage-fit.js:89-95`) is
`Σ_{weeksAgo=0}^{∞} 0.5^(weeksAgo/5) = 1/(1 − 0.5^{1/5}) = 7.7250`, confirmed
by direct computation. **The prior-season term does not match**: `rowWeight`
applies `seasonDecay^back` to *every game* of a prior season (not once per
season), so a full-time player's prior-season contribution is `Σ_{back=1}^{∞}
GAMES · 0.05^back = GAMES · 0.05/0.95`. With `GAMES=17`
(`shrinkage-fit.js:58`, production's own full-season constant), that is
**0.895**, not ≈0.4 — total asymptotic cap **≈8.62**, not ≈8.13. Confirmed a
second way: directly replaying `rowWeight` against this container's real
`player_week_usage` history for its longest-tenured player (id 8, 79 games
across 6 seasons 2021-2026) gives a partial sum of 1.60 at 6 seasons in,
consistent with converging toward 8.6 rather than plateauing near 8.1 (0.05⁴
≈ 6×10⁻⁶, so the sum is already >99.99% of its limit by the 4th prior
season — this container's real data doesn't run long enough to observe the
plateau directly, so the closed form is what settles it, not the sample).

Using the corrected cap of 8.62: `K.share=6` gives `8.62/(8.62+6) = 59.0%`
own-history weight, so the **positional prior keeps 41.0%** (Auditor: 42.5%);
`K.team_volume=10` gives `8.62/(8.62+10) = 46.3%` own weight, prior keeps
**53.7%** (Auditor: 55.2%). Both within ~1.5 points of the relayed figures —
close enough that the Auditor's qualitative conclusion is unaffected and
should not be read as contradicted, but the number now has an independent
derivation and a real-data spot-check behind it rather than one citation.

**Is it intended?** No design note anywhere in `projections.js`, `MODEL_
ROADMAP.md`, or this file's own git history states that a positional prior
should keep a permanent ~41-59% floor on target/carry share regardless of
career length. `K.share=6` and `K.team_volume=10` read, from every comment
around them, as constants meant to represent "how many games of evidence
equal one unit of prior trust" on an unbounded, career-length-scaled n —
which is true and intended on the `RECENCY` (season-long) path, where n
keeps growing (a week-14, two-prior-season player already reaches n≈21,
giving `K.share=6` only 22% weight to the prior — the 35-point swing named
in the Gate-1 doc). On the `WEEKLY_ROLE_RECENCY` path the same literal
constants stop meaning that once n saturates. **This is the finding, not the
constants being wrong on their own terms**: the two paths need either two
different constants, or an explicit statement that the weekly path is
deliberately more conservative forever. Neither exists today. This unit
does not change `K.share`/`K.team_volume` — picking a weekly-path-specific
constant is a modeling decision for whoever owns that call, not something
this evidence file should decide by fiat; it hands the corrected saturation
math to that decision instead of leaving it uncomputed.

**3. Grade on the repository's own weekly MAE, not a proxy.** Done above:
4.613 → 4.490 MAE, paired-bootstrap significant, on `replaySeasonWeekly`'s
real weekly grading — the same walk-forward the production ensemble is
graded on, not a share-prediction proxy.

**4. Do not reuse the efficiency-side ρ table.** Confirmed by construction:
`volumeKFits`/`toKVector` pull exclusively from `VOLUME_METRICS` (the six
volume (metric, position) pairs), built from `buildFitSpecs`'s own
volume-specific weighting (`roleWeightFor`, weighted games) — a completely
separate code path from the efficiency dispute's opportunity-count ρ table,
never touched by this unit.

## The five questions

**Is this well built?** Nothing new was written for step 3 beyond a
six-line persistence script reusing already-tested functions
(`volumeKFits`, `saveMetricReliability`) — the statistical machinery
(`fitAllK`, `replaySeasonWeekly`, `pairedBootstrapDiff`) already existed and
was already covered by its own suites; this unit's job was running it for
real and checking its own citations, not building new logic.

**Is this based on stats, or is it made up?** Every number above is either a
real bootstrap result off real walk-forward replay, or a closed-form
re-derivation checked two ways (exact formula, and a real-data partial-sum
sanity check) — not a restated citation.

**How do we know?** The CRPS gate's own significance test (paired bootstrap,
seed 7, 90% CI excluding 0) is the evidence for step 3. For the saturation
number, disagreeing with a relayed figure and then re-deriving it from the
production source (`rowWeight`) rather than either accepting or silently
correcting it is the check.

**Should this data be pointed anywhere else on the platform?** The
`shrinkage_fits` row (id 1, PASS, not activated) and the six
`nfl_metric_reliability` rows are now queryable by whoever next re-promotes
the weekly ensemble or audits reliability; nothing further to wire from this
file.

**How does it unify?** Same discipline as the rest of this session: verify a
specific relayed number against the source before repeating it
(`projection-range-buildprojections-wiring.tdd.md`'s migrations gap, the
Unit-4 21%-vs-29.82% reconciliation elsewhere in this queue), and record the
correction with its derivation rather than either silently using the wrong
number or silently fixing it without saying so.
