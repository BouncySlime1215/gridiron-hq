# nfl_route_splits — TDD report

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
