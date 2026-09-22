# TDD evidence: the current-season participation 404 is a skip, and prior seasons have a named backfill

Work-queue unit R-02 (plan item 21, pipeline fragility). Branch
`claude/local-r-02-formations-ingest-404`, cut from `origin/main` at `bd56319b`
(#128). Re-audit findings on #119, #87 and #92
(`~/gridiron-local/reaudit-2026-09-22.json`, not in the repo).

Sections 1-3 (audit, licence gate, extend-or-build) were committed first, in
`03efefdd`, before any test was written. Sections 4-9 were added after.
Section 10 answers the independent skeptics' review of `d8ae7352`; where it
corrects an earlier section, the earlier text is marked "corrected, see 10".

Commits, oldest first:

| sha | subject |
|---|---|
| `03efefdd` | docs: audit, licence gate and extend-or-build for the participation 404 skip |
| `459b8870` | test: the current-season participation 404 is a skip, and completed seasons have a named backfill (RED) |
| `ed0337bb` | fix: the current-season participation 404 is a recorded skip, and completed seasons load through a named command (GREEN) |
| `3671ff16` | test: participation's LA is stored as the canonical LAR, and a blank possession stays unknown (RED) |
| `6dd3d2a5` | fix: participation rows store the canonical team code, so the Rams join their formation history (GREEN) |
| `d15d599e` | test: pin the season the growth cycle asks nflverse for (kills surviving call-site mutant C2) |
| `d8ae7352` | docs: RED/GREEN, real-data numbers, re-freeze gap and mutation sweep for the participation 404 skip |
| `90175c96` | test: a completed season's participation 404 stays a failure, and so do 403, 429 and 410 (RED) |
| `a162c26b` | fix: only the season in progress may 404 as "not published"; a completed season's 404 stays a failure (GREEN) |
| `f0c48e47` | test: a team vector sees participation only from seasons before its own, as nflverse publishes it (RED) |
| `f133269d` | fix: team history reads participation only from seasons before the target, matching when nflverse publishes it (GREEN) |
| `5256cc89` | test: pin what the backfill command does, not just its guards: the season it asks for, the rows it stores, exit 1 on a 404 |
| `dba47f86` | test: a 404 for the last completed season is a failure too (kills boundary mutants M13 and C5) |
| `072c690c` | test: the writer's note on a completed season's 404 must not call it normal (RED) |
| `eda2376a` | fix: the participation 404 note says it is expected only for the season in progress and a fault for a completed one (GREEN) |

`eda2376a` is the last code commit. The commit after it changes only this
file (corrections in this header and in sections 3, 4, 6, 8 and 9, and the
new section 10); its sha is in the PR.

**What changes for Nick, in two sentences.** In season, the growth job stops
calling itself broken every time it asks for this season's formation file,
which nflverse does not publish until after the Super Bowl; it now records that
as "not published yet, skipped" and saves the list of skipped steps in the run
record. Completed seasons now load with one command,
`GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs 2025`,
and on a local copy of the database that fills 45,184 plays for 2025 and gives
32 of 32 team vectors built for 2026 week 3 their formation features (0 of 32
before). A team vector only ever sees participation from seasons before its
own, because that is all anyone has at kickoff: nflverse publishes a season
after its post-season. A 404 for a season that is already complete is still
reported as a failure.

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
   (Corrected, see 10.1: at `d8ae7352` the caller did not check which season
   was in progress; it now passes `availableSeason()` to the rule.)
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
(`charting-summary-box-contamination` 5, `formations-participation-columns` 9,
`forward-ledger` 6, `ftn-charting` 2, `nfl-weekly-feature-store-feed-zero` 3,
`week1-readiness` 7): **32 tests, 32 pass.** (Corrected, see 10.4: this line
said 35 at `d8ae7352`; re-run on `ed0337bb` gives 32, and none of these files
changes on any sha of the branch before `f0c48e47`.)

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
then. 4 of 4 pass. With the other formations and growth files
(`formations-possession-team-code` 4, `formations-participation-columns` 9,
`growth-participation-404-skip` 8, `growth-participation-season-gate` 3,
`backfill-formations-command` 3, `growth-cycle-outcome` 14), run together on
`6dd3d2a5`: **41 tests, 41 pass.** (Corrected, see 10.4: this line said "28 of
28" and named no files.)

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
`finalized_week + 1` each time (`nfl-model-growth.js:314`). Since `f133269d`
those features come only from seasons before the vector's own (section 10.2),
which for an in-season vector is all it could ever see anyway.

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

**The exact command, if the Auditor approves a re-freeze.** Leak-free only
from `f133269d` on: before that, `teamHistory` read participation by game
week, so re-freezing a completed season put that season's earlier weeks into
its own vectors, which nobody had at kickoff (section 10.2 has the skeptic's
reproduction and the fix). Originally verified on the local copy only, in a
scratch checkout of `bd56319b` with the constant edited to a probe string and
then restored (`git status` clean after):

1. Load the completed seasons first, one per run:
   `GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node scripts/backfill-formations.mjs <season>` for 2022, 2023, 2024, 2025.
2. Change `WEEKLY_FEATURE_STORE_VERSION` at `server/services/nfl-weekly-feature-store.js:12` to a new string, in its own PR.
3. Re-freeze completed seasons only (never the season in progress, which is
   the defect above):
   `GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 node --input-type=module -e "const s = await import('./server/services/nfl-weekly-feature-store.js'); console.log(JSON.stringify(s.backfillTeamFeatureVectors({ seasons: [2022, 2023, 2024, 2025], startWeek: 5, endWeek: 18 })))"`

Probe result for 2025 week 5 under the probe version, **on the `bd56319b`
read, withdrawn**: `targets 28, frozen 28, existing 0, failures 0`; 28 of 28
rows carried `formation_` keys (average `feature_count` 2,679 against 2,426),
but those keys were 2025 weeks 1-4, published in February 2026. That was
look-ahead, not a success. On the fixed read, with only 2025 loaded on this
copy, a 2025 week-5 build has **0 of 28** vectors with `formation_` keys, which
is correct: the only participation published before that kickoff is 2024 and
earlier, and this copy has not loaded 2024 (section 10.2). A re-freeze of 2025
that carries formations needs step 1 to load 2024 first; that run was not
done here (one download per the coordinator's instruction).

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
- **The v2 research store has the same look-ahead, not fixed here.**
  `server/services/nfl-weekly-feature-store-v2.js:619-638` reads
  `nfl_play_formations` and the charting join in the weekly shape, and its
  `participation()` satellite (`:240`) is merged through `mergePrior` (`:140`),
  which also admits earlier weeks of the target season. v2 is study code used
  only by `scripts/backfill-feature-store.mjs` and
  `scripts/grade-feature-vector.mjs`, and not this unit's file; any lift
  measured through it on participation features carries the look-ahead.
- **charting_ features lose same-season values in re-frozen vectors.** FTN
  charting itself is published weekly, but `teamHistory` gets the possession
  team by joining it to `nfl_play_formations`, so it inherits participation's
  cutoff. Serving never had same-season charting_ values either (no
  current-season participation rows exist in season), so this is parity, not a
  loss against serving. Taking possession from play-by-play instead would give
  both training and serving in-season charting: a feature change for the
  Auditor.
- **`scripts/nfl-2022-2025-rebuild.mjs:129` still filters `<= 2023`** before
  calling `ingestFormations`. Not this unit's file; reported.
- **The POST route defaults to season 2023** (`nfl-betting.js:1544`). Not
  changed.
- **Only 2025 was measured on real data.** 2022 (NGS era, 22 MB, lower fill per
  R&D's measurement) was not loaded here.
- The `ok` note and `skipped_steps` are only as right as the rule that 404 means
  "not published". If nflverse moved the release, the season in progress would
  still read as a skip, but a completed season asked for through the route now
  ends `ingest_error` (10.1), and the backfill command exits 1 (10.3).
- The season in progress is `availableSeason()`: `NFL_SEASON` (production sets
  `"2026"`, `fly.toml:24`), else the newest `game_lines` season. Between the
  Super Bowl and the day that season's file appears, its 404 is still recorded
  as a skip, which is correct. A stale `NFL_SEASON` would make the rule treat
  the wrong season as in progress; keeping that setting current is outside
  this unit.

**Defect fixed**, on tree `bd56319b`: `nfl-model-growth.js:247` +
`:177-178` (the #92 x #119 interaction) and `nfl-formations.js:120` (raw team
code). **Incumbent, by command:** on `bd56319b`, the real 2026 request through
`ingestFormations` + `cycleOutcome` returns `ingest_error` (section 5).
**What would make it wrong:** nflverse starting to publish participation during
the season (the fetch still runs, so it would simply be ingested), or a 404
that means something other than "not published".

## 9. Nick's five questions

1. **Well built?** Yes. Four existing functions extended (the writer, the skip
   rule, the verdict, the team-history read), one small command added, no new
   table, no migration, no deleted data. Each RED fails on the unfixed code for
   the stated reason. Final sweep (10.7): 25 of 25 non-control mutants die, 7 of 7 of them at a call site; the designed survivor survived and the control reports not applied.
2. **Stats or made up?** Neither a stat nor a model number: this is plumbing.
   The counts are real rows from nflverse on a local copy (45,184 plays for
   2025, 0 before) and the 404 is a real response. The one number that looked
   like a result, "28 of 28 re-frozen vectors carry formation keys", was
   look-ahead and is withdrawn (10.2).
3. **How we know:** tests (four RED/GREEN pairs; 176 tests across 16 files on
   `eda2376a`, which are listed in 10.6), mutation sweeps, and real-data runs on a
   local copy with a known-nonzero control first. No backtest, because nothing
   here changes a prediction by itself. The hand-set rules are two: "a 404 for
   the season in progress is a skip" and "a team vector sees participation
   only from earlier seasons", both taken from nflreadr's statement that
   participation is "provided after all post-season games are completed".
4. **Pointed anywhere else?** The run status is written to
   `nfl_model_growth_runs` (`nfl-model-growth.js:374-375`), read by
   `latestRun()` (`:112`) and `nflModelGrowthStatus()`, which
   `nfl-profitability.js:222` serves. The formation rows feed `teamHistory`
   (`nfl-weekly-feature-store.js:114`, participation reads `:159`, `:169`) ->
   `buildTeamFeatureVector` -> `freezeWeeklyFeatureState`
   (`nfl-model-growth.js:327`) and `buildTeamCard` (`nfl-team-card.js:188`),
   and the `/formations` routes (`nfl-betting.js:1551`, `:1561`). No client
   page reads the growth status directly.
5. **How it unifies:** one writer (`ingestFormations`), one team-code map
   (`team-codes.js`), one verdict function (`cycleOutcome`), one notion of the
   season in progress (`availableSeason()`, the same one the cycle runs). The
   skip is a field (`skipped`, `absence: 'not_published'`, `skipped_steps`), so
   a person and a program read the same absence. The backfill goes through the
   same writer the cycle and the route use; no second ingest path. Training
   and serving now read participation with the same cutoff.

## 10. Independent review of `d8ae7352`, and what changed

Two skeptic lenses (claims and statistics; test liveness) raised six
blocking findings. All six were right; each is answered below with the
command that shows it and the commit that fixes it. Every number here is on a
local copy or a temp database, not production.

### 10.1 A completed season's 404 was recorded as "not published" (fixed)

`unpublishedSeasonSkip` skipped any 404, on the premise that the cycle's
season is the one being played. `POST /profitability/model-growth/run`
(`server/routes/nfl-betting.js:229-233`) passes the season its body names, so
a 404 for a published season was filed as "not published yet".

Reproduction, the skeptic's own script run on both trees (temp DB; week-1
finals for 2024 and 2026 in `game_lines`; participation stubbed to 404;
`runNflModelGrowthCycle({ season: 2024, force: true })`):

```
d8ae7352: skipped_steps ["formation_participation"]
          step {"season":2024,"skipped":true,"absence":"not_published","http_status":404,...}
dba47f86: skipped_steps []
          step {"season":2024,"http_status":404,"error":"participation for 2024 returned 404",...}
```

(Both runs end `source_lag` because the temp DB has no team features; the
step's own verdict through `cycleOutcome` with no lag is `ingest_error`, which
the test pins.)

- **RED 3, `90175c96`**, `test/growth-participation-404-skip.test.js`:
  **11 tests, 9 pass, 2 fail** (re-run on the committed sha in a scratch
  worktree). The acceptance assertion:
  ```
  not ok 7 - a 404 for a completed season is a failed download, not a skip
    error: a completed season's 404 is a fault; step was {"season":2024,"skipped":true,
      "absence":"not_published","http_status":404,...}
  ```
- **GREEN 3, `a162c26b`**: `unpublishedSeasonSkip(step, season, inProgressSeason)`
  skips only a 404 whose season is the one in progress or later, and never
  when the season in progress is not a finite number. The call site passes
  `availableSeason()` (`NFL_SEASON`, which production sets to `"2026"` at
  `fly.toml:24`, else the newest `game_lines` season). 404-skip,
  growth-cycle-outcome and season-gate: **28 tests, 28 pass.**
- **Boundary, `dba47f86`**: the first full sweep on `5256cc89` found two
  survivors, M13 (rule also skips `season - 1`) and C5 (call site hands the
  rule `availableSeason() - 1`), because the test's completed season was two
  seasons back. The tests now check both 2025 and 2024; both mutants die.
- **The note a person reads, RED `072c690c` / GREEN `eda2376a`**: after the
  fix, the step for 2024 still carried the writer's note "a season is
  published only after its post-season is complete", which reads as normal.
  RED: `not ok 7 ... the note a person reads does not call 2025's 404 normal`.
  The writer (which does not know the season in progress) now says the 404 is
  expected only while the season is in progress and a fault for a completed
  season.
- **The real 404, final tree, real network** (scratchpad `real-404.mjs`, season
  in progress 2026, which is `MAX(game_lines.season)` on the local copy):
  step `{"season":2026,"skipped":true,"absence":"not_published","http_status":404}`,
  verdict `ok`, skipped `["formation_participation"]`. Unchanged.

### 10.2 The documented re-freeze put future participation into past vectors (fixed)

`teamHistory` (`server/services/nfl-weekly-feature-store.js`) read
`nfl_play_formations` by game week, `season < S OR (season = S AND week < w)`,
the shape of the feeds that really are published weekly. Participation is
published once a year, after the post-season (the 2025 file's last-modified is
2026-02-10). So after a backfill, any vector built for a week of a loaded
season (the section-6 re-freeze, a team card, `buildTeamCard` at
`nfl-team-card.js:188` uses the same builder) carried that season's earlier
weeks, while the served in-season vector can only ever see last season's. One
key, two meanings.

Reproduction without any version bump, pure reads through
`buildTeamFeatureVector` (scratchpad `asof-probe.mjs`), on a `cp` of the
section-5 local copy after its 2025 backfill (sha256 prefix
`42cab57c99195104`; local copy, not production):

| read | `a162c26b` (weekly shape) | `f133269d` (fixed) |
|---|---|---|
| SQL: KC 2025 week-4 shotgun share | 0.662791 | 0.662791 |
| SQL: KC 2025 week-18 shotgun share (last 2025 week) | 0.493827 | 0.493827 |
| KC 2025 wk 5 vector `formation_shotgun_share__latest` | **0.662791** (= 2025 week 4: look-ahead) | absent (no participation published before that kickoff is loaded on this copy) |
| KC 2025 wk 5 vector `charting_motion_share__latest` | 0.55814 | absent |
| KC 2026 wk 3 vector `formation_shotgun_share__latest` | 0.493827 | 0.493827 |
| 2025 wk 5 vectors with `formation_` / `charting_` keys | 28 / 28 of 28 | **0 / 0 of 28** |
| control: 2025 wk 5 vectors with `injury_` keys | 28 of 28 | 28 of 28 |
| 2026 wk 3 vectors with `formation_` / `charting_` keys (known-nonzero) | 32 / 32 of 32 | 32 / 32 of 32 |

**What is served does not move.** sha256 over `(team, evidence_hash,
feature_count)` for all 32 builds of 2026 week 3 (scratchpad `serve-hash.mjs`;
`evidence_hash` covers the whole history): `7bffcc29254bf55c` on `f0c48e47`
and on `f133269d`, 88,146 features on both. Production `nfl_play_formations`
has 0 rows (section 5), so no production vector changes either. What does
change is what a re-frozen or rebuilt past vector contains, which is model
input: listed for the Independent Auditor with the re-freeze decision
(section 6).

- **RED 4, `f0c48e47`**, `test/team-history-participation-as-of.test.js` with
  `test/nfl-weekly-feature-store-feed-zero.test.js`: **8 tests, 5 pass, 3 fail**
  (re-run on the committed sha):
  ```
  not ok 4 - a 2025 week-5 vector sees no 2025 participation: its latest shotgun share is 2024's
    expected: 0   actual: 1
  not ok 6 - the history rows themselves carry no same-season participation
    + [4, 3, 2, 1]   - []
  ```
  The two that pass on the unfixed code are guards: weekly feeds still read
  the target season's earlier weeks, and prior-season participation still
  reaches the vector (the known-nonzero case, which kills a deleted read).
- **A test that was wrong, changed in the RED commit:** the #87 feed-zero test
  read 2025 week-1 participation from a 2025 week-2 history, which is exactly
  the look-ahead. It now reads the same rows from a 2026 week-1 history; its
  three sentinel assertions are unchanged and pass on both trees.
- **GREEN 4, `f133269d`**: the `formation_` and `charting_` reads take
  `season >= TRUSTED_HISTORY_START AND season < target`. `charting_` joins
  through `nfl_play_formations` for the possession team, so it inherits the
  same cutoff (section 8 has what that costs). **8 tests, 8 pass.**

### 10.3 The backfill command's behaviour had no test (tests added)

`5256cc89` spawns `scripts/backfill-formations.mjs` for real against a
migrated temp database, with `fetch` replaced by a stub preloaded through
`node --import` (no network). A 200 for 2025: asks for exactly
`pbp_participation_2025.csv`, stores 3 rows, all under 2025, prints the
attribution, exits 0. A 404: exits 1, writes nothing, stderr names the 404. A
503: exits 1. The code was already right, so these pass on it; their liveness
is the skeptic's two survivors, now killed (SC1 = their S1, `season - 1`;
SC2 = their S2, `process.exitCode = 0`).

### 10.4 Two test counts that did not reproduce (corrected)

- GREEN 1 neighbours: **32**, not 35 (per-file on `ed0337bb`: 5 + 9 + 6 + 2 +
  3 + 7). Section 4 is corrected.
- GREEN 2: **41 of 41** for the six named files on `6dd3d2a5`. The "28 of 28"
  named no files; my guess at its source is a re-run of the GREEN 1 set
  (14 + 8 + 3 + 3 = 28 on that tree). Section 4 is corrected.

### 10.5 403, 429 and 410 were untested (tests added)

`90175c96` runs the cycle with 403, 429 and 410 for the season in progress
and adds all three to the pinned rule. They pass on the fixed and unfixed
rule alike, since only 404 was ever skipped; their liveness is the skeptic's
U1 (every 4xx becomes a skip), killed by 2 tests in sweep 3 and again in
the final sweep on `eda2376a` (10.7).

### 10.6 Final run

Tree `eda2376a` (a clean detached checkout of it), 16 files: the 13 that
import `nfl-model-growth.js`, `nfl-weekly-feature-store.js` or
`nfl-formations.js` directly, `backfill-formations-command` (runs
`scripts/backfill-formations.mjs` as a child process),
`nfl-team-card-injury-cutoff` (reaches `nfl-weekly-feature-store.js` through
`nfl-team-card.js:15`) and `nfl-weekly-feature-store-v2-feed-zero` (the v2
twin of the feed-zero test; it imports no changed module):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap <16 files>`:
exit 0, **176 tests, 176 pass, 0 fail, 0 cancelled, 0 skipped**, stderr empty
(scratchpad `r02/final4.tap`). Per file (counted on `dba47f86`,
scratchpad `r02/final3.tap`, same 176 total; `eda2376a` adds one assertion
to an existing test and no test): growth-participation-404-skip 11,
backfill-formations-command 6, team-history-participation-as-of 5,
nfl-weekly-feature-store-feed-zero 3, growth-cycle-outcome 14,
growth-participation-season-gate 3, formations-possession-team-code 4,
formations-participation-columns 9, charting-summary-box-contamination 5,
forward-ledger 6, ftn-charting 2, week1-readiness 7, model-integrity 88,
nfl-team-card-injury-cutoff 5, nfl-weekly-feature-store-v2-feed-zero 3,
nfl-weekly-state 5. The first eight of those sum to 55, which is the sweep's
baseline count on `eda2376a` (10.7).

Not run here: 28 more test files reach a changed module indirectly, almost
all through `scheduler.js` (found by listing the server modules that import a
changed module, then the tests that import those). The Gate phase's single
`npm run check` runs them.

`node scripts/wiring-map.mjs --check` on `eda2376a`: exit 0, "no
missing-feed findings" (scratchpad `r02/wiring4.out`; its last three lines
match the `dba47f86` run).

### 10.7 Final mutation sweep (tree `eda2376a`)

Harness: scratchpad `mutate4.py` (same rules as section 7: one mutant at a
time, applied only if the target text occurs exactly once, md5 before, after
and after restore). v4 differs from v3 in where it runs: it mutates a detached
scratch worktree checked out at `eda2376a`, refuses to start on the builder
worktree, refuses to start unless that scratch tree is clean and at the stated
sha, runs the unmutated test set first (baseline 55 of 55
pass), restores the file on SIGTERM, SIGHUP or SIGINT, writes one line per
mutant as it goes, and checks `git status --porcelain` is empty at the end.
Test set: the 8 files that pin this unit
(growth-participation-404-skip, backfill-formations-command,
growth-cycle-outcome, growth-participation-season-gate,
formations-possession-team-code, formations-participation-columns,
team-history-participation-as-of, nfl-weekly-feature-store-feed-zero),
55 tests. Tree `eda2376a`. Output: scratchpad `r02/sweep4.jsonl`, baseline tap `r02/sweep4-base.tap`. **25 of 25 non-control mutants die, 7 of 7 of them at a call site; the designed survivor survived and the control reports not applied.**

| id | kind | file | mutation | verdict | killed by (first two) |
|---|---|---|---|---|---|
| M1 | unit | `nfl-model-growth.js` | skip rule: any status becomes a skip | KILLED | any other participation status is still a failed download; a 403, a 429 or a 410 for the season in progress is still a failed … (+1) |
| M2 | unit | `nfl-model-growth.js` | skip rule: never skip | KILLED | the cycle records the current-season participation 404 as a skip, …; cycleOutcome counts that 404 as a skip, not a failed download (+2) |
| U1 | unit | `nfl-model-growth.js` | skeptic U1: every 4xx becomes a skip | KILLED | a 403, a 429 or a 410 for the season in progress is still a failed …; the production skip rule, pinned directly |
| M11 | unit | `nfl-model-growth.js` | in-progress check deleted: any season 404 is a skip | KILLED | a 404 for a completed season is a failed download, not a skip; the production skip rule, pinned directly |
| M12 | unit | `nfl-model-growth.js` | in-progress check excludes the season in progress | KILLED | the cycle records the current-season participation 404 as a skip, …; cycleOutcome counts that 404 as a skip, not a failed download (+2) |
| M13 | unit | `nfl-model-growth.js` | in-progress check off by one: last completed season skips | KILLED | a 404 for a completed season is a failed download, not a skip; the production skip rule, pinned directly |
| M3 | unit | `nfl-model-growth.js` | cycleOutcome: skip list ignores an error key | KILLED | a step that carries an error is a failure even if it also says skipped |
| M4 | unit | `nfl-model-growth.js` | cycleOutcome: skip flag beats an error | KILLED | a step that carries an error is a failure even if it also says skipped |
| M5 | unit | `nfl-model-growth.js` | ok note no longer names the skip | KILLED | cycleOutcome counts that 404 as a skip, not a failed download |
| M6 | unit | `nfl-model-growth.js` | run record drops skipped_steps | KILLED | the stored run record carries the skip as a field |
| M7 | unit | `nfl-formations.js` | writer drops http_status | KILLED | the cycle records the current-season participation 404 as a skip, …; cycleOutcome counts that 404 as a skip, not a failed download (+4) |
| M8 | unit | `nfl-formations.js` | writer stores the raw team code | KILLED | the feed's LA is stored as the canonical LAR |
| M9 | unit | `nfl-formations.js` | blank possession stored as empty string | KILLED | a blank possession stays unknown, not an empty-string team |
| M10 | unit | `backfill-formations.mjs` | command accepts a pre-2016 season | KILLED | it refuses a season nflverse could not have published |
| F1 | unit | `nfl-weekly-feature-store.js` | formation read includes the target season (look-ahead) | KILLED | a 2025 week-5 vector sees no 2025 participation: its latest shotgun …; the history rows themselves carry no same-season participation |
| F2 | unit | `nfl-weekly-feature-store.js` | charting read includes the target season (look-ahead) | KILLED | the charting family, joined through participation, has the same cutoff; the history rows themselves carry no same-season participation |
| F3 | unit | `nfl-weekly-feature-store.js` | formation read returns nothing | KILLED | defenders_in_box history excludes literal-zero sentinel plays from …; a 2025 week-5 vector sees no 2025 participation: its latest shotgun … (+1) |
| F4 | unit | `nfl-weekly-feature-store.js` | weekly team-feature read also cut to prior seasons (over-restriction) | KILLED | weekly feeds still read the target season's earlier weeks |
| C1 | call-site | `nfl-model-growth.js` | call site stores the raw writer result (pre-fix wiring) | KILLED | the cycle records the current-season participation 404 as a skip, …; cycleOutcome counts that 404 as a skip, not a failed download (+1) |
| C2 | call-site | `nfl-model-growth.js` | call site asks nflverse for the wrong season | KILLED | the cycle asks nflverse for its own season, once; a 404 for a completed season is a failed download, not a skip |
| C3 | call-site | `nfl-model-growth.js` | call site hands the rule the wrong season | KILLED | the cycle records the current-season participation 404 as a skip, …; a 404 for a completed season is a failed download, not a skip |
| C4 | call-site | `nfl-model-growth.js` | call site trusts the cycle season as the one in progress | KILLED | a 404 for a completed season is a failed download, not a skip |
| C5 | call-site | `nfl-model-growth.js` | call site hands the rule last season as in progress | KILLED | a 404 for a completed season is a failed download, not a skip |
| SC1 | call-site | `backfill-formations.mjs` | skeptic S1: command loads season - 1 | KILLED | a published season: asks for exactly that file, stores its rows, …; a 404 writes nothing and exits 1, so the failure is seen |
| SC2 | call-site | `backfill-formations.mjs` | skeptic S2: command exits 0 after a failed download | KILLED | a 404 writes nothing and exits 1, so the failure is seen; any other download error exits 1 too |
| S1 | designed-survivor | `nfl-model-growth.js` | equivalent: numeric coercion of a numeric status | SURVIVED | none |
| N1 | not-applied-control | `nfl-formations.js` | target text absent: must report NOT APPLIED | NOT APPLIED | n/a |

md5 base / restored: `nfl-model-growth.js` 74ff3a55 / 74ff3a55; `nfl-formations.js` 7c00d244 / 7c00d244; `backfill-formations.mjs` 2fc2ebfc / 2fc2ebfc; `nfl-weekly-feature-store.js` d4124fb9 / d4124fb9.

The first run of this sweep, on `5256cc89`, had two survivors (M13, C5); the
test was strengthened in `dba47f86` (10.1) and both die above. The skeptic's
own mutants are here under their ids: U1, and S1/S2 as SC1/SC2 (renamed
because S1 is this harness's designed survivor).

**A harness fault, found by the skeptic and fixed.** An earlier attempt at
this final sweep used `mutate3.py`, which mutated the builder worktree in
place. It stopped partway through without running its restore: no process
of it remained and its output files were 0 bytes (my guess is that it was
killed, since an exception would have run its `finally` restore). It left
mutant C3 (`season + 1` handed to the skip rule) in the builder's
`server/services/nfl-model-growth.js` (md5 `ed111c40`, byte for byte C3's
mutant in the table above, against the committed `74ff3a55`). It produced
no output, and no result from it is used anywhere.
The file was restored with `git checkout -- server/services/nfl-model-growth.js`
(md5 `74ff3a55` again). No commit ever held the mutant: on each of the eight
commits `90175c96`..`eda2376a`, `git show <sha>:server/services/nfl-model-growth.js | grep -c 'season + 1, availableSeason()'`
gives 0, while the real call text `ingestFormations(season), season, availableSeason()`
gives 1 on each from `a162c26b` on (the known-nonzero control; `90175c96` is
the RED commit before that call existed). The commit that adds this section
touches only this evidence file.

### 10.8 Holdout looks

No model metric, grade or outcome was computed on 2025. The 2025 reads in this
unit are feature-vector builds for 2025 week 5 on a local copy (counting
`formation_` keys and reading one feature value, 10.2) and row counts of the
2025 participation file (section 5). No label or result was read.
