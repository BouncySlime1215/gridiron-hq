# nfl_route_splits — TDD report

> **WITHDRAWN 2026-09-22, and the code is not in this branch.** §4d below
> measured nflsavant against the nflverse participation feed this repo already
> downloads and found it a **strict subset** — 106 receivers against 500, and
> the sparse-coverage-shell weakness §5 records as inherent to the data turned
> out to be an artifact of the worse source. So the loader, its migration, its
> tests and its feature-store reader have been removed rather than shipped:
> `server/migrations/069_nfl_route_splits.js`,
> `server/services/nfl-route-splits.js`, `test/route-splits.test.js`,
> `test/route-splits-feature-store.test.js`, the `source-registry.js` and
> `nfl-feature-coverage.js` registrations, and the
> `nfl-weekly-feature-store.js` read.
>
> **This document is kept on purpose.** It is the evidence for the decision,
> and §4d is the measurement anyone rebuilding this should start from. The
> replacement is not a new third-party source: it is the nflverse columns that
> **migration 070 in this same branch already adds** — `was_pressure`,
> `defense_man_zone_type`, `defense_coverage_type` and `time_to_throw` on
> `nfl_play_formations`. That is the unit, and it is unbuilt.
>
> The process lesson is in `docs/RD-HANDOFF-CONTRACT.md`: the intake gate now
> asks what we already download that carries this, and why the new source beats
> it. Nobody asked, so nobody answered, and correct code was written against
> the wrong feed.

**Item:** per-receiver targets broken out by route family (13) and coverage
shell (7), each with EPA per target, catch % and success %, from nflsavant.com's
open JSON API. Handed over by the Data & techniques R&D thread as a package
(SPEC.md, a working `clean.mjs` prototype, three cleaned `.jsonl` files); built
here under the intake gate in `docs/RD-HANDOFF-CONTRACT.md`.

**Files owned and changed:** `server/migrations/069_nfl_route_splits.js`,
`server/services/nfl-route-splits.js`, `test/route-splits.test.js`, this
document. Plus one registration line each in `server/services/source-registry.js`
and `server/services/nfl-feature-coverage.js`, both granted by the coordinator
under the one-editor rule; Scheduler confirmed no collision on source-registry.

**Base:** `main` at 654ff93.

---

## 1. Audit — what existed, and the decision

| Checked | Found |
|---|---|
| `route_splits`, `coverage_shell`, `nflsavant` anywhere in .js/.mjs/.sql/.ts/.tsx | zero hits outside `node_modules` |
| nearest existing neighbours | `nfl_ngs` (separation, cushion, YAC-over-expected) and `nfl_pfr_adv` (charting) — both per-player-week **totals**, no breakdown by route or coverage |
| the join key | `nfl_ngs`'s key column is named **`player_id`**, not `gsis_id`, and holds `r.player_gsis_id` (`server/services/nfl-advanced.js:113`) |
| season-aggregate convention | week 0 already means "season aggregate" in this codebase (`server/services/nfl-advanced.js:111`) |

**Decision: BUILD.** Nothing to extend and no prior copy to unify against.

On the join key, the record should be accurate about who was right. The handoff
prose read "keyed by gsis_id", which this thread flagged as a column that does
not exist. R&D's reply corrected the correction: `gsis_id` is genuinely the
field name in **nflsavant's own JSON response**, the delivered rows already used
`player_id`, and no SQL in the package was written against a wrong column. The
flag was worth raising and the wording has been sharpened at the source, but the
claim that it "would not compile" overstated a documentation ambiguity as a
code defect. Recorded here rather than quietly dropped.

Two things in the handoff spec **were** wrong, both surfaced by the same read
and both fixed here:
- it called for a "new migration" while describing `nfl_ngs`, which is not in a
  migration at all (`server/db/schema/nfl-a-to-m.js:43-47`, created ad-hoc at
  import);
- it gave the table a three-column primary key when `nfl_ngs`'s own key is four
  (`season, week, player_id, kind`).

**Migration number.** Allocated 069 by the coordinator, then verified here
rather than assumed: all 150 remote branch tips were fetched and their
`server/migrations/` listed. Highest claimed anywhere is `066_league_transactions_raw.js`;
**067, 068 and 069 are unclaimed on every branch.** Also found: 062 is used
three times, not twice — `062_roster_weekly_panel.js` sits on the three
`f921do` branches alongside main's `062_google_identity_and_invites.js` and
`062_league_payload_season.js`.

## 2. The defect found before any implementation was written

The handoff's DDL was `week INTEGER` (nullable, "NULL = season aggregate") with
`PRIMARY KEY (season, week, player_id)`.

**SQLite permits many NULLs in a composite primary key.** So for every
season-aggregate row the constraint never fires, `ON CONFLICT DO UPDATE` is
unreachable, and each re-sync appends another copy of the season — silently,
because nothing errors. Demonstrated in `node:sqlite` before writing the
loader: two inserts of the same `(2024, NULL, '00-0036900')` produced **2 rows**;
with a `week=0` sentinel the second is correctly rejected with
`UNIQUE constraint failed`.

**Fix:** `week INTEGER NOT NULL`, season aggregates at week 0 — which is
already this codebase's own convention, not a new one.

### And a second key decision, from R&D's spec correction

The key is **four columns**, `(season, week, player_id, kind)`, matching
`nfl_ngs` exactly (`server/db/schema/nfl-a-to-m.js:46`), where one player-week
holds a passing, a receiving and a rushing row. Only `'routes'` exists here
today; the point is that a second slice of this source can land later without
altering an applied migration, which this project does not do. Changed while the
migration was still unapplied anywhere — the cheap moment to change it.

**Why a migration and not `server/db/schema/`,** given that `nfl_ngs` lives
there: `server/db/migrate.js:10-20` states the rule outright — migrations govern
schema added "going forward", and centralising the ~40 existing ad-hoc CREATE
sites is explicitly a separate, higher-risk project. A table added tonight is
going forward.

## 3. RED → GREEN

| Commit | Evidence |
|---|---|
| `369ac56` TDD RED | 11 tests, failing with `ERR_MODULE_NOT_FOUND` on the migration — a genuinely absent source file, with `node_modules` installed (`npm ci` exit 0), not the missing-dependency failure CLAUDE.md warns reads identically |
| `1081b1e` TDD GREEN | 11/11 pass; 12/12 after the four-column key was added |

**Mutation test — five deliberate defects, each caught by its own test:**

| Mutation | Result |
|---|---|
| week sentinel reverted to NULL (the handoff's own DDL) | 4 fail |
| unknown route/shell codes silently dropped | 1 fail |
| absent shell efficiency zeroed instead of null | 1 fail |
| failing fetch swallowed into an empty result | 1 fail |
| generated prose `summary` ingested | 1 fail |
| key narrowed back to three columns | 4 fail |
| restored | 12/12 pass |

## 4. Numbers

Re-derived from the delivered files rather than quoted from the handoff:

| Claim | Re-run here |
|---|---|
| 2024 / 2025 / 2025-wk5 rows | 100 / 92 / 71 — match |
| distinct `stats` fields | 65 — match |
| `player_id` resolution | 100/100 non-null, unique, all matching `^00-0\d{6}$` |
| shell sparsity | `cover_4` 20/100, `cover_0` 6/100, `cover_6` 2/100 — match |

**Full `npm run check`, exit 0:** typecheck clean; lint 884 JavaScript files;
**2997 tests, 2956 pass, 0 fail, 41 skipped, 318.8s**; build ok; startup smoke
passed on an isolated database (32 teams). The test step is 5m19s against CI's
`timeout-minutes: 20`.

## 4b. Unit 2 — the feature-store wiring

RED `3f820f1` (`test/route-splits-feature-store.test.js`, failing
with "no earlier player observations" because `playerHistory` did not read the
table), GREEN `ce71cc8`, 3/3.

One additive loop in `playerHistory` beside the existing `nfl_ngs` one, prefixed
`route_`. Existing loops untouched. All 65 fields then get the thirteen
transforms with no further code.

Two things the obvious version gets wrong, both now tested and both
mutation-checked:

| Decision | What goes wrong without it |
|---|---|
| `week > 0` in the WHERE clause | every player gains a phantom week-0 observation and a whole season's totals fold into the rolling weekly means. `nfl_ngs`'s sync drops week 0 for the same reason (`nfl-advanced.js:111`) |
| `optionalRows`, not `rows` | this table arrives by migration rather than with the schema, so a database that has not migrated has no table and `rows()` throws where the other feeds do not |

The feature-dictionary provenance label moved from `player+ngs+pfr+pff` to
`player+ngs+pfr+pff+routes`, so newly registered features name what they are
built from. `INSERT OR IGNORE` keys on `feature_id`, so existing rows are
unaffected.

Mutations, each failing exactly one test: `week>0` dropped, `optionalRows`
swapped for `rows`, `route_` prefix collided with `ngs_`.

## 4c. Unit 4 — the ablation gate cannot run in this container

The gate R&D specified, and the right one, is an A/B ablation scored through
`backtest.js`'s CRPS and PIT calibration, fit 2022-2024 and tested on 2025 —
because `nfl-model-watch.js:1-18` records two features that passed isolated
out-of-sample validation and still degraded the shipped pipeline.

**The source side is fine.** Probed directly rather than assumed:
`route-spotlight` returns 200 for 2021 (106 receivers), 2022 (106), 2023 (108),
2024 (100) and 2025 (92), and the weekly endpoint returns real rows for
2022 wk5, 2023 wk12, 2024 wk1 and 2025 wk5. The full fit/test window is
available, free, from this container.

**The outcome side is not.** This container has no populated database — no
sqlite file over 1 MB anywhere under `/home/user`, and `data/` holds only an
empty `line-history/`. The ablation needs `nfl_player_week_features` and
realized weekly outcomes across 2022-2025; both come from the live 445 MB
database or a full multi-season nflverse ingest. Backfilling nflsavant alone
(~106 receivers x ~18 weeks x 4 seasons, roughly 7,600 polite requests, 25-40
minutes) would supply the route side and still leave nothing to score against.

So unit 4 is **blocked on a database copy**, which is already an open item on
the project's missing-data log rather than a new gap. Until it runs, the claim
that route splits improve projections is a **guess**, and §6 says so.

## 4d. VERDICT — do not sync this source. nflverse already has it, better.

Measured after the fact, prompted by R&D's package #6. The comparison is on
2022, both sources, same receivers. Script committed at
`docs/evidence/route-source-overlap.mjs`.

**Route type.** nflverse `pbp_participation` carries a `route` column for the
targeted receiver, joinable to play-by-play on game id and play id.

| | nflsavant | nflverse participation |
|---|---:|---:|
| receivers with labelled routes | 106 | **500** |
| of nflsavant's receivers, present in nflverse | — | **106 of 106 (100%)** |
| receivers nflverse has that nflsavant does not | — | **394** |
| labelled target-routes | 10,222 | **18,176** |
| join rate on plays with a named receiver | — | 18,176 / 18,285 = **99.4%** |

nflsavant is a strict subset. Every receiver it covers is in nflverse, and
nflverse covers 394 more with 78% more labelled routes.

**Coverage shell — and this kills the one weakness I documented as inherent.**
§5 records sparse shells as a known limit of the data: COVER_4 on 20 of 100
receivers, COVER_0 on 6, COVER_6 on 2, needing a coverage gate before anything
consumes them. That sparsity is **an artifact of nflsavant's aggregation, not
of the football.** On the same 18,176 route plays, participation carries a
coverage shell on **18,156 of them (99.9%)**:

| shell | plays |
|---|---:|
| COVER_3 | 5,822 |
| COVER_1 | 4,108 |
| COVER_4 | 2,933 |
| COVER_2 | 2,588 |
| COVER_6 | 1,568 |
| COVER_0 | 759 |
| 2_MAN | 313 |
| PREVENT | 65 |

Plus `defense_man_zone_type` on the same 18,156 (12,976 zone / 5,180 man),
`was_pressure` on 18,176 of 18,176, and `time_to_throw` on 18,176 of 18,176.
A shell nflsavant never reports (PREVENT) is there, and the three it reports
for a handful of receivers are in the thousands of plays.

**Taxonomy.** nflverse uses 12 route values against nflsavant's 13 families,
and nflsavant's are mostly merges of nflverse's (HITCH/CURL, SHALLOW
CROSS/DRAG, TEXAS/ANGLE). The one distinction nflsavant makes that nflverse
does not is QUICK OUT versus DEEP OUT against a single OUT — and participation
carries `ngs_air_yards` per play, so out depth is derivable rather than lost.

**So: `nfl_route_splits` is correct code pointed at the worse feed.** It is not
deleted — the migration, loader, registration and feature-store wiring all work
and cost nothing while unused — but **nothing should call `syncRouteSplits`**,
and the 2022-2025 backfill was stopped at 30 of 76 pulls once this was clear
rather than spending another 20 minutes of a small site's bandwidth on data we
had just decided not to use. If the route dimension is wanted, it should come
from participation, which is free, versioned, reproducible, already downloaded
by `nfl-formations.js`, and five times the sample.

This is what the intake gate in `docs/RD-HANDOFF-CONTRACT.md` asks item 2 for —
"the data, plus where it came from and that it is free" — and what the gate did
not ask, and now should: **is there a source we already have that carries it?**

## 5. Known limits, carried forward not papered over

- **This is targets by route, not routes run.** No denominator. A receiver who
  ran forty go routes and was targeted once appears once. Nothing may describe
  it as usage, and the routes-run gap stays open.
- **The taxonomy was discovered, not documented.** A code added upstream is one
  we have never seen, so the loader reports unknown codes in the sync result
  instead of dropping them.
- **Sparse shells.** Only `COVER_1`, `COVER_2`, `COVER_3` and `2_MAN` carry
  enough targets to model on. The rest are kept but left null where unmeasured,
  so a consumer can apply its own coverage gate; that gate does not exist yet
  and belongs with the feature-store wiring.
- **Third-party derived data, not a league feed.** Undocumented, unversioned,
  and it can change or disappear. `source-registry.js` says plainly that there
  is no fallback. There is no trust-tier field in that registry to set — adding
  one would be its own change, not a side effect of this one.
- **Nothing is wired to a consumer yet.** This unit is the table and the
  loader. The feature-store loop (`nfl-weekly-feature-store.js:223-228`) and the
  ablation gate are separate units, each needing its own ownership grant.

## 6. The five questions

1. **Is this well built?** The loader and its constraint, yes — 11 tests, all
   five mutations caught, full check green, and the one design defect in the
   handoff was found and fixed before implementation. As a *feature*, no: it is
   a table with no consumer until the feature-store unit lands.
2. **Is it based on stats, or made up?** Real third-party data, re-verified
   here: 100/92/71 rows, 65 fields, 100/100 ids resolved. `route_entropy` is
   computed by us from those targets, not supplied. Nothing is estimated and
   nothing is a hand-set constant.
3. **How do we know?** For the ingest, the re-derivations in §4 and the
   mutation table in §3. For predictive value, **we do not know yet — nothing
   has been backtested.** `nfl-model-watch.js:1-18` records two features that
   passed isolated out-of-sample validation and still degraded the shipped
   pipeline, so the gate is an A/B ablation through `backtest.js`'s CRPS and PIT
   calibration (fit 2022-2024, test 2025), not a correlation and not MAE. Until
   that runs, any claim that this improves projections is a **guess**.
4. **Should this data be pointed anywhere else?** Yes, and deliberately not
   yet. It joins `nfl_ngs` on `player_id` with no crosswalk, so the feature
   store is the natural first consumer; the Trade Brain and start/sit surfaces
   are plausible seconds. Each waits on the ablation in question 3.
5. **How does it unify?** It is shaped like `nfl_ngs` on purpose — same key,
   same flat numeric `stats` blob, same season-aggregate convention — so it
   expands through the existing thirteen transforms rather than needing its own
   path, and a number here cannot disagree with a number there.
