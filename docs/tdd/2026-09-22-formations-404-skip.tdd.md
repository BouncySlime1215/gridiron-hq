# TDD evidence: the current-season participation 404 is a skip, and prior seasons have a named backfill

Work-queue unit R-02 (plan item 21, pipeline fragility). Branch
`claude/local-r-02-formations-ingest-404`, cut from `origin/main` at `bd56319b`
(#128). Re-audit findings on #119, #87 and #92
(`~/gridiron-local/reaudit-2026-09-22.json`, not in the repo).

Sections 1-3 (audit, licence gate, extend-or-build) were committed first, in
`03efefdd`, before any test was written. Sections 4-9 were added after.

Commits, oldest first:

| sha | subject |
|---|---|
| `03efefdd` | docs: audit, licence gate and extend-or-build for the participation 404 skip |
| `459b8870` | test: the current-season participation 404 is a skip, and completed seasons have a named backfill (RED) |
| `ed0337bb` | fix: the current-season participation 404 is a recorded skip, and completed seasons load through a named command (GREEN) |
| `3671ff16` | test: participation's LA is stored as the canonical LAR, and a blank possession stays unknown (RED) |
| `6dd3d2a5` | fix: participation rows store the canonical team code, so the Rams join their formation history (GREEN) |
| `d15d599e` | test: pin the season the growth cycle asks nflverse for (kills surviving call-site mutant C2) |

**What changes for Nick, in two sentences.** In season, the growth job stops
calling itself broken every time it asks for this season's formation file,
which nflverse does not publish until after the Super Bowl; it now records that
as "not published yet, skipped" and saves the list of skipped steps in the run
record. Completed seasons now load with one command,
`GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs 2025`,
and on a local copy of the database that fills 45,184 plays for 2025 and gives
32 of 32 team vectors built for 2026 week 3 their formation features (0 of 32
before).

## 1. Audit: what already exists for this surface (tree `bd56319b`)

| piece | where | what it does today |
|---|---|---|
| table | `nfl_play_formations` (`server/db/schema/nfl-a-to-m.js`, columns widened by migration 070) | one row per play: formation, personnel, box, rushers, time to throw, pressure, coverage |
| the only writer | `ingestFormations` `server/services/nfl-formations.js:65`, `INSERT ... ON CONFLICT DO UPDATE` at `:86` | downloads one season of `pbp_participation_<season>.csv`; on any non-OK status returns `{ error, note }` at `:68-75` instead of throwing |
| scheduled caller | `runNflModelGrowthCycle` `server/services/nfl-model-growth.js:247` | `attempt('formation_participation', () => ingestFormations(season))`, inside the download branch gated at `:227` (`finalized_week > 0 && (force \|\| coreLag)`). `season` is `availableSeason()` (`:53-56`): `NFL_SEASON`, else `MAX(game_lines.season)` = 2026 |
| step recorder | `attempt` `nfl-model-growth.js:149-153` | stores the returned object as-is, so a returned `{ error }` is recorded exactly like a throw |
| verdict | `cycleOutcome` `nfl-model-growth.js:168`, filter at `:177-178` | any ingestion step with `.error` makes the run `ingest_error` with a note calling derived data stale |
| scheduler | `server/services/scheduler.js:1416` job `nfl_model_growth` (6 h, off-thread) -> `refreshNflModelGrowth` `:1008` | runs the cycle |
| manual route | `POST /api/nfl-betting/formations/ingest` `server/routes/nfl-betting.js:1541` (season defaults to 2023 at `:1544`) | runs `ingestFormations` + `ingestCharting` inside the server process; bearer session required |
| hand-run script | `scripts/nfl-2022-2025-rebuild.mjs:129` | still filters `value <= 2023` before calling `ingestFormations`, so it never loads 2024 or 2025 (the gate #92 removed from the cycle survives here) |
| existing tests | `test/growth-cycle-outcome.test.js` (#119), `test/growth-participation-season-gate.test.js` (#92) | #119 pins "a step with `.error` is `ingest_error`"; #92 pins "the cycle attempts participation for 2024 and 2099". Neither covers the two together |
| frozen consumer | `freezeTeamFeatureVector` `server/services/nfl-weekly-feature-store.js:193`, early return of an existing row at `:196`; formation history read by `teamHistory` `:145-154` | a vector already frozen for (season, week, team, version) is returned unchanged; the table has `BEFORE UPDATE` / `BEFORE DELETE` abort triggers (`server/db/schema/nfl-n-to-z.js:874-876`) |

**The defect, as the re-audit found it and as this tree still has it.** #92
(`6e722719`) removed the `season <= 2023` gate so the cycle now calls
`ingestFormations(2026)` on every download cycle. nflverse returns 404 for
2026. `ingestFormations` returns `{ error: 'participation for 2026 returned
404', note }`; `attempt` stores it; #119's `cycleOutcome` counts it as a failed
download. So every in-season cycle that downloads ends `ingest_error`, for an
absence the code's own comment (`nfl-model-growth.js:241-246`) calls "one
honest line in the ingestion detail rather than a failure".

**The gap behind it.** The cycle only ever asks for its own season, which is
never published while the season is being played (see the licence text below:
"provided after all post-season games are completed"). Out of season the
download branch does not run (no `coreLag`). So the scheduled job can never
fill `nfl_play_formations`, and the only other paths are the manual POST
(season defaults to 2023) and the rebuild script (gated to `<= 2023`). On a
fresh local copy of the production DB, `nfl_play_formations` has **0 rows**
(numbers and commands in section 5).

## 2. Licence gate (read 2026-09-22, before any row was measured)

Probe, `curl -s -o /dev/null -w "%{http_code}"` on
`raw.githubusercontent.com/nflverse/nflverse-data/<branch>/<file>`:

| branch | LICENSE | LICENSE.md | LICENSE.txt | COPYING | README.md |
|---|---|---|---|---|---|
| master | 404 | **200** | 404 | 404 | 200 |
| main | 404 | **200** (byte-identical to master, `cmp` exit 0) | 404 | 404 | 200 |
| gh-pages | 404 | 404 | 404 | 404 | 404 |

- `nflverse-data/master/LICENSE.md`, first line: "Attribution 4.0 International" (CC BY 4.0).
- `nflverse-data/master/README.md` (699 bytes): no licence or dataset-specific terms.
- Release page `github.com/nflverse/nflverse-data/releases/tag/pbp_participation`: "Participation data for plays from NGS".
- **Dataset-specific terms, `nflreadr.nflverse.com/reference/load_participation.html`:**
  "Participation data from 2023 onwards is courtesy of FTN and is provided after
  all post-season games are completed. This data is released under the CC-BY-SA
  4.0 Creative Commons license and attribution must be made to FTN Data via
  nflverse (from 2023 onwards) or NFL NextGenStats via nflverse (for 2022 and
  earlier)."

**Verdict: usable, with attribution.** The participation files carry stricter
terms than the repo-wide CC BY 4.0: CC BY-SA 4.0, attributed to "FTN Data via
nflverse" (2023+) or "NFL NextGenStats via nflverse" (2022 and earlier). Free,
no personal-use clause, no paywall. **Open obligation, not closed by this
unit:** `git grep -n -i "FTN Data\|CC-BY-SA\|NextGenStats via"` over
`server client/src scripts` finds nothing, so the app shows this attribution
nowhere. FTN charting (same FTN terms) is already ingested on the timer at
`nfl-model-growth.js:248` with the same gap. Standing rule 10 says CC BY data is
usable only once attribution is visible, so the production backfill should wait
for that line (a Nick / coordinator call, listed under known defects).

The same text is the documentary source for the fix: the current season is not
published until its post-season ends, so a 404 for the cycle's own season is the
expected state, not a failed download.

## 3. Extend or build

**Extend, no new store.** Every piece already exists; what is wrong is the
interaction between #92 and #119 and the missing way to load a completed season.

1. `ingestFormations` (`nfl-formations.js:68-75`): **extend** the non-OK return
   with machine-readable `season` and `http_status` fields. It keeps returning
   `error` for every non-OK status, because the route and the rebuild script
   both treat `error` as a failure and a 404 for a completed season (2016-2025
   are published) should stay loud there.
2. `nfl-model-growth.js:247`: **extend** the call site. The cycle's season is the
   one being played, so a 404 for it becomes a recorded skip
   (`skipped: true, absence: 'not_published'`) with no `error` key. Any other
   status, or a throw, stays a failure. The judgement lives with the caller that
   knows which season is in progress; the writer only reports the fact.
3. `cycleOutcome` (`:168`): **extend** so a skipped step is counted as a skip,
   named in the `ok` note and returned as a field, never as a failure.
4. Prior seasons: **build one thin named command**, not a timer.
   `scripts/backfill-formations.mjs <season>` loads one season through the
   existing writer and prints 2022-2025 row counts. Not on the timer because a
   completed season is a 49-50 MB CSV parsed in memory (`res.text()` then
   `split`), the same size class as the nflverse depth CSV that standing rule 13
   says OOMs the 2 GB production machine. Peak memory is measured below rather
   than assumed.
5. Team-vector re-freeze: **document, not bump.** See section 6.

Not touched (other threads' files or out of scope, reported instead):
`scripts/nfl-2022-2025-rebuild.mjs:129` stale `<= 2023` gate; the missing
attribution line; the route's 2023 default.

## 4. RED and GREEN

Every test run below used
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap <files>`,
with fetch stubbed inside each test file (no test reaches the network).

### RED 1: `459b8870` (tests only, code at `bd56319b`)

`test/growth-participation-404-skip.test.js` and
`test/backfill-formations-command.test.js`: **11 tests, 3 pass, 8 fail.**

The acceptance assertion, failing on the unfixed code. The step is the one the
real call site stored after a whole cycle ran with participation stubbed to 404:

```
not ok 5 - cycleOutcome counts that 404 as a skip, not a failed download
  error: expected ok with a recorded skip, got ingest_error: A finalized week was available
    and every required release had published, but a download failed: formation_participation.
    The rest of the cycle ran against rows that feed did not update, so anything derived from
    it is as stale as the last successful run. The scheduler retries it on the next cycle.
```

The step itself:

```
not ok 4 - the cycle records the current-season participation 404 as a skip, not an error
  error: a 404 for the season being played is the documented absence; step was
    {"error":"participation for 2026 returned 404","note":"nflverse has not published
    participation for 2026; the current season is never available."}
  + 'participation for 2026 returned 404'
  - undefined
```

The other six failures, each for its own reason: `not ok 6` stored run record
has no `skipped_steps` (`+ undefined - ['formation_participation']`); `not ok 9`
`ingestFormations` has no `http_status` (expected 404, got undefined);
`not ok 11` `nfl-model-growth.js exports the rule it applies` (`'undefined' !==
'function'`); `not ok 1-3` the backfill command does not exist
(`Cannot find module .../scripts/backfill-formations.mjs`, exit 1 where 2 is
required).

The 3 that pass on the unfixed code are guards on what must not change: a 503
is still `ingest_error`, a thrown fetch is still `ingest_error`, and a step
carrying both `error` and `skipped` is a failure.

### GREEN 1: `ed0337bb`

- `ingestFormations` non-OK return gains `season` and `http_status`
  (`server/services/nfl-formations.js:88`). It still returns `error`, so the
  POST route and the rebuild script still treat every non-OK status as a
  failure.
- `unpublishedSeasonSkip(step, season)` (`server/services/nfl-model-growth.js:164`),
  exported: a step with `error` and `http_status === 404` becomes
  `{ season, skipped: true, absence: 'not_published', http_status: 404, note }`;
  anything else passes through untouched.
- Call site `nfl-model-growth.js:271`:
  `attempt('formation_participation', async () => unpublishedSeasonSkip(await ingestFormations(season), season), ...)`.
- `cycleOutcome` (`:188`) collects skipped steps (`:190`, no `error` and
  `skipped === true`), returns them as `skipped` from every branch, and the `ok`
  note appends "Not published yet, so skipped rather than failed:
  formation_participation." (`:215`). An `error` key always wins (`:199`).
- The run record stores `skipped_steps` (`:361`), which `latestRun()` (`:112`)
  serves.
- `scripts/backfill-formations.mjs`: refuses (exit 2) without an explicit
  `GRIDIRON_DB_PATH` or with anything but one season from 2016 through the
  current year, before any import opens a database; loads one season through
  `ingestFormations`; prints the result, seconds, its own peak RSS, the licence
  and attribution, and `nfl_play_formations` rows by season from
  `TRUSTED_HISTORY_START` through the last completed season; exit 1 on any
  download error, including a 404.

RED 1 files plus the two pre-existing growth test files: **28 tests, 28 pass.**
Neighbouring files that import either changed module
(`charting-summary-box-contamination`, `formations-participation-columns`,
`forward-ledger`, `ftn-charting`, `nfl-weekly-feature-store-feed-zero`,
`week1-readiness`): **35 tests, 35 pass.**

### RED 2: `3671ff16`, found by the real-data run in section 5

After loading 2025, 31 of 32 week-3 team vectors had formation features. The
missing team was LAR; the only possession code in the 2025 rows that
`game_lines` does not use was LA. `ingestFormations` stored `possession_team`
raw, and `teamHistory` binds `possession=?` to the game_lines code
(`nfl-weekly-feature-store.js:150`). `test/formations-possession-team-code.test.js`:
**4 tests, 2 pass, 2 fail.**

```
not ok 2 - the feed's LA is stored as the canonical LAR
  error: teamHistory binds possession to the game_lines code, which is LAR
    'LA' !== 'LAR'
not ok 4 - a blank possession stays unknown, not an empty-string team
    '' !== null
```

### GREEN 2: `6dd3d2a5`

`nfl-formations.js:143` stores `canonicalTeamCode(possession)` from
`server/services/team-codes.js` (the one team-code map) and `null` for a blank.
`reconcileHistoricalTeamCodes` (`nfl-advanced.js:441`) already rewrites this
column, but only when a growth cycle reaches it with every core source current
(`nfl-model-growth.js:310`), so a backfilled season would sit unjoinable until
then. 4 of 4 pass; with the other formations and growth files, 28 of 28.

## 5. The numbers (local copy, not production)

Local copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"`
at 2026-09-22 19:42Z, sha256 prefix `d86acdfeed02867a` before any write.

**Known-nonzero control first**, then the empty table
(`sqlite3 <copy> "select season,count(*) from nfl_play_charting ..."`):

| season | `nfl_play_charting` (control) | `nfl_play_formations` before |
|---|---|---|
| 2022 | 41,643 | 0 |
| 2023 | 48,225 | 0 |
| 2024 | 48,031 | 0 |
| 2025 | 47,316 | 0 |
| 2026 | 5,174 | 0 |

`nfl_team_feature_vectors` (v1): 2,110 rows, 0 containing `formation_`, control
`injury_` 2,110 of 2,110.

**Source check**, `curl -sIL .../pbp_participation/pbp_participation_<s>.csv`:
2022 200 (22,245,804 bytes), 2023 200 (49,967,956), 2024 200 (49,688,308),
2025 200 (49,094,943, last-modified 2026-02-10, after the post-season),
2026 **404**.

**Backfill of 2025**, tree `ed0337bb` (write-tree `b300e068d2d6`):
`/usr/bin/time -l env SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node scripts/backfill-formations.mjs 2025`
exit 0:

```
"rows_before": 0, "plays_stored": 45184, "with_formation": 36076,
"seconds": 3.1, "max_rss_mb": 270, "licence": "CC BY-SA 4.0",
"attribution": "FTN Data via nflverse"

nfl_play_formations rows by season:
  2022        0
  2023        0
  2024        0
  2025    45184
```

`/usr/bin/time` agrees: 284,540,928 bytes maximum resident set size. 45,184
matches the 2025 row count R&D measured independently on 2026-09-22
(`gridiron-participation-not-dead-after-2023`). 2022-2024 stay 0 on this copy
on purpose: one season was downloaded, per the coordinator's "keep downloads
small". Each loads with the same command and a different year.

**Re-run of 2025** after GREEN 2, tree `6dd3d2a5`: exit 0, `rows_before`
45,184, `plays_stored` 45,184, table still 45,184 (the upsert refreshes, it
does not duplicate), 3.3 s, `max_rss_mb` 286 (`/usr/bin/time` 300,302,336
bytes). Possession codes after: `LA` 0, `LAR` 1,643, null 0, empty string 0.

**Does the data reach the consumer?** `buildTeamFeatureVector(2026, 3, team)`
for all 32 teams scheduled in week 3 (a pure read, nothing frozen; probe script
in the session scratchpad):

| state | built | with `formation_` keys | avg `formation_` keys | control: with `injury_` keys |
|---|---|---|---|---|
| before backfill | 32 | **0** | 0 | 32 |
| after 2025, raw team code (`ed0337bb`) | 32 | 31 (LAR missing) | 69.8 | 32 |
| after GREEN 2 re-run (`6dd3d2a5`) | 32 | **32** | 72.0 | 32 |

**The verdict on the real 404**, real network, each tree's writer and verdict,
the step stored the way that tree's call site stores it:

```
base   (bd56319b): step {"error":"participation for 2026 returned 404",...}  status ingest_error
R-02   (ed0337bb+): step {"season":2026,"skipped":true,"absence":"not_published","http_status":404,...}
                   status ok, skipped ["formation_participation"]
```

The command on the unpublished season: `node scripts/backfill-formations.mjs 2026`
prints `http_status: 404`, writes nothing, exits 1.

## 6. The team-vector re-freeze gap: documented, not bumped

**The gap, measured.** `freezeTeamFeatureVector` returns an existing row
unchanged (`nfl-weekly-feature-store.js:194-196`) and
`nfl_team_feature_vectors` has `BEFORE UPDATE` and `BEFORE DELETE` abort
triggers (`server/db/schema/nfl-n-to-z.js:874-876`). After the 2025 backfill on
the local copy, `backfillTeamFeatureVectors({ seasons: [2025], startWeek: 5, endWeek: 5 })`
returned `targets 28, frozen 0, existing 28`, and those 28 rows still hold 0
`formation_` keys. So every vector frozen before a backfill keeps its
formation-free state.

**What does pick it up.** Every vector frozen after the backfill: the table
above shows fresh builds carry formation features. The cycle freezes
`finalized_week + 1` each time (`nfl-model-growth.js:314`).

**A bigger version of the same gap, found while measuring (reported, not
fixed).** 2026 weeks 5-18 are already frozen: 416 team vectors created
2026-09-17T04:37Z, cutoff placeholders `2026-W5-pregame` through
`2026-W18-pregame`, built when only 2026 week 1 had been played.
`backfillTeamFeatureVectors` defaults to `seasons` including 2026
(`nfl-weekly-feature-store.js:308`), so a call with defaults froze future weeks
from history that ends at the call date. When the season reaches week 5,
`freezeWeeklyFeatureState` will return those rows unchanged: no formations, and
no 2026 weeks 2-4 either. On the local copy the only upcoming 2026 weeks a new freeze
can still write are 3 and 4.

**Why not bump the version here.** `WEEKLY_FEATURE_STORE_VERSION`
(`nfl-weekly-feature-store.js:12`) is one constant for team vectors, player
vectors, the feature dictionary and the coverage contract
(`nfl-feature-coverage.js:64`). A bump hides every frozen row from every reader
keyed on version until a backfill re-freezes them, and re-frozen past weeks
carry a `created_at` after their cutoff. That changes model inputs, which
standing rule 2 sends to the Independent Auditor. It is not a pipeline unit's
call.

**The exact command, if the Auditor approves a re-freeze.** Verified on the
local copy only, in a scratch checkout of `bd56319b` with the constant edited
to a probe string and then restored (`git status` clean after):

1. Load the completed seasons first, one per run:
   `GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs <season>` for 2022, 2023, 2024, 2025.
2. Change `WEEKLY_FEATURE_STORE_VERSION` at `server/services/nfl-weekly-feature-store.js:12` to a new string, in its own PR.
3. Re-freeze completed seasons only (never the season in progress, which is
   the defect above):
   `GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node --input-type=module -e "const s = await import('./server/services/nfl-weekly-feature-store.js'); console.log(JSON.stringify(s.backfillTeamFeatureVectors({ seasons: [2022, 2023, 2024, 2025], startWeek: 5, endWeek: 18 })))"`

Probe result for 2025 week 5 under the probe version: `targets 28, frozen 28,
existing 0, failures 0`; 28 of 28 rows carry `formation_` keys; average
`feature_count` 2,679 against 2,426 for the v1 rows of the same week.

## 7. Mutation sweep

Harness: `mutate.py` in the session scratchpad (not committed). One mutant at a
time; applied only if the target text occurs exactly once; md5 before, after
and after restore; the six targeted test files (42 tests) run each time.

**Sweep 1, tree `6dd3d2a5`: 12 killed, 1 survived that should not have (C2),
designed survivor survived, control not applied.** C2 moved the call site to
`ingestFormations(season - 1)`: the stub answered every participation URL the
same way and no test pinned which file was asked for, so a cycle that
downloaded last season's published ~50 MB file on every run would have passed.
Fixed in the test (`d15d599e`: the stub records participation URLs and the
test asserts exactly `pbp_participation_2026.csv`, once).

**Sweep 2, tree `d15d599e`:**

| id | kind | mutation | verdict | killed by |
|---|---|---|---|---|
| M1 | unit | skip rule: any status is a skip (`=== undefined`) | KILLED | 503 still fails; rule pinned directly |
| M2 | unit | skip rule never skips | KILLED | step is a skip; verdict ok; run record; rule pinned |
| M3 | unit | skip list ignores an `error` key | KILLED | error wins over skipped |
| M4 | unit | failure list excludes anything flagged skipped | KILLED | error wins over skipped |
| M5 | unit | ok note no longer names the skip | KILLED | verdict test (note names the step) |
| M6 | unit | run record drops `skipped_steps` | KILLED | stored run record test |
| M7 | unit | writer drops `http_status` | KILLED | step is a skip; verdict; run record; writer field |
| M8 | unit | writer stores the raw team code | KILLED | LA stored as LAR |
| M9 | unit | blank possession stored as `''` | KILLED | blank stays unknown |
| M10 | unit | command accepts seasons from 2000 | KILLED | refuses a season nflverse could not publish |
| C1 | call site | store the raw writer result (the pre-fix wiring) | KILLED | step is a skip; verdict; run record |
| C2 | call site | ask nflverse for `season - 1` | KILLED | the cycle asks for its own season, once |
| C3 | call site | hand the rule `season + 1` | KILLED | step is a skip (season field) |
| S1 | designed survivor | `Number(step.http_status) !== 404` (equivalent for a numeric status) | SURVIVED, as designed | none |
| N1 | not-applied control | target `res.status === 410` (absent) | NOT APPLIED (0 matches, md5 unchanged) | n/a |

md5 base / restored: `nfl-model-growth.js` e62841fd / e62841fd,
`nfl-formations.js` a512a231 / a512a231, `backfill-formations.mjs` 2fc2ebfc /
2fc2ebfc. Which rule each test pins: the "production skip rule" test imports
`unpublishedSeasonSkip` from `nfl-model-growth.js` (the production rule, not a
fixture); the cycle-level tests read the step the real call site stored; the
`cycleOutcome` tests use the real function.

`node scripts/wiring-map.mjs --check` on `d15d599e`: exit 0, "no missing-feed
findings".

## 8. Known defects and what this does not cover

- **Attribution is not visible anywhere.** Participation is CC BY-SA 4.0 with
  "FTN Data via nflverse" / "NFL NextGenStats via nflverse" attribution; the app
  shows neither (and none for FTN charting, already on the timer). Under
  standing rule 10 the production backfill should wait until that line is
  visible. The command prints the attribution; that is not the same thing.
- **Production is still empty.** This branch adds the command; nobody has run
  it against the production database. That needs Nick's word (deploy / Fly
  shell), and see the previous point.
- **Prior seasons are not on the timer**, by choice: peak RSS 270-286 MB for one
  season in a standalone process, the size class of the depth CSV that rule 13
  keeps off the 2 GB machine. Whether 286 MB inside the server process is safe
  is not measured; putting it on the timer is a separate decision.
- **Frozen vectors keep their formation-free state**, and 2026 weeks 5-18 are
  pre-frozen from week-1 history (section 6). Auditor decision.
- **`scripts/nfl-2022-2025-rebuild.mjs:129` still filters `<= 2023`** before
  calling `ingestFormations`. Not this unit's file; reported.
- **The POST route defaults to season 2023** (`nfl-betting.js:1544`). Not
  changed.
- **Only 2025 was measured on real data.** 2022 (NGS era, 22 MB, lower fill per
  R&D's measurement) was not loaded here.
- The `ok` note and `skipped_steps` are only as right as the rule that 404 means
  "not published". If nflverse moved the release, every season would 404 and
  the cycle would report a skip; the backfill command would still fail loudly
  (exit 1) on a completed season.

**Defect fixed**, on tree `bd56319b`: `nfl-model-growth.js:247` +
`:177-178` (the #92 x #119 interaction) and `nfl-formations.js:120` (raw team
code). **Incumbent, by command:** on `bd56319b`, the real 2026 request through
`ingestFormations` + `cycleOutcome` returns `ingest_error` (section 5).
**What would make it wrong:** nflverse starting to publish participation during
the season (the fetch still runs, so it would simply be ingested), or a 404
that means something other than "not published".

## 9. Nick's five questions

1. **Well built?** Yes. Three existing functions extended, one small command
   added, no new table, no migration, no deleted data. RED fails on the unfixed
   code for the stated reason; 13 of 13 non-control mutants die, including
   three at the call site; the designed survivor survives and the control
   reports not applied.
2. **Stats or made up?** Neither a stat nor a model number: this is plumbing.
   The counts are real rows from nflverse on a local copy (45,184 plays for
   2025, 0 before) and the 404 is a real response.
3. **How we know:** tests (RED then GREEN, 42 targeted tests), a mutation sweep,
   and real-data runs on a local copy with a known-nonzero control first. No
   backtest, because nothing here changes a prediction by itself. The one
   hand-set rule is "a 404 for the cycle's own season is a skip", taken from
   nflreadr's own statement that participation is "provided after all
   post-season games are completed".
4. **Pointed anywhere else?** The run status is written to
   `nfl_model_growth_runs` (`nfl-model-growth.js:358-363`), read by
   `latestRun()` and `nflModelGrowthStatus()`, which `nfl-profitability.js:222`
   serves. The formation rows feed `teamHistory` -> `buildTeamFeatureVector` ->
   `freezeWeeklyFeatureState` (`nfl-model-growth.js:314`) and `buildTeamCard`
   (`nfl-team-card.js:178`), and the `/formations` routes (`nfl-betting.js:1551`,
   `:1561`). No client page reads the growth status directly.
5. **How it unifies:** one writer (`ingestFormations`), one team-code map
   (`team-codes.js`), one verdict function (`cycleOutcome`). The skip is a field
   (`skipped`, `absence: 'not_published'`, `skipped_steps`), so a person and a
   program read the same absence. The backfill goes through the same writer the
   cycle and the route use; no second ingest path.
