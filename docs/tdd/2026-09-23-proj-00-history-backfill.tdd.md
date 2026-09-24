# PROJ-00-a: history backfill (nflverse play-by-play, participation players, realized weather)

Unit PROJ-00 (plan item "Layer 2 v2: Gaps"). Not statistical: it loads data and
checks the load. It fits no model and produces no model number. Results come
from a local copy of the database, not production
(`.local-db/data.sqlite`, a `.backup` of `~/gridiron-local/data.sqlite` taken
2026-09-23 15:47 ET).

Licences were read and committed first, before any file was downloaded:
`docs/evidence/2026-09-23/proj-00-licences.md` (commit "docs: PROJ-00 licences
recorded before any pull"). Decisions: nflverse pbp usable (CC BY 4.0);
nflverse participation usable (CC BY-SA 4.0, only aggregates go in the repo);
Open-Meteo archive usable; **ESPN leaguedefaults blocked** (the Disney Terms of
Use bar scripted copying to build a data set). Part (3) of the row, the ESPN
2025 weekly pull, is not done. That needs Nick.

## 1. Audit: extend or build

| part | what exists on origin/main (`309877ef`) | decision |
|---|---|---|
| (1) pbp into `nfl_play_by_play` | Table from `server/db/schema/nfl-a-to-m.js:310`, PK `(event_id, play_id)`. The one writer is `storePlays`, `server/services/nfl-espn-pbp.js:181`. It is fed by the ESPN summary endpoint: `backfillSeasons` (`:380`, default seasons 2021-2026) and live polling. Local copy: only 160 rows, all 2026, one game. | **Extend.** Map nflverse pbp rows into the same play shape (`classifyPlay` vocabulary) and write them through `storePlays`, the existing writer. `event_id` = the nflverse `game_id` (e.g. `2023_01_DET_KC`). It names its source and joins to `nfl_play_formations.game_id` and the new participation table. The ESPN `backfillSeasons` then skips a season nflverse already loaded, so each game has one producer. |
| (2) participation players | `nfl_play_formations` (`ingestFormations`, `server/services/nfl-formations.js:79`) reads the same file but keeps per-play counts only: formation, personnel, box and rushers. It has no per-player list. Local copy: 2022-2025, no 2021. | **Build** `nfl_play_participation_players` (migration 074, additive). The writer is new, in `server/services/nfl-participation.js`. The reader is a new status route. |
| (3) ESPN 2025 weekly | `~/gridiron-local/rnd/loop/data/espn_proj_hist/` holds 2021-2024 and 2026, pulled by the R&D loop. | **Blocked by licence.** Not pulled. |
| (4) realized weather 2021-24 | `nfl_game_weather`: the canonical producer is `syncGameWeather`, `server/services/nfl-weather.js:51`, which reads the Open-Meteo archive (realized). Local copy: 2025 has 193 rows and 2026 has 42. **2021-2024 have zero rows.** `nfl_game_weather_forecast_history` holds only *forecasts* (`open-meteo-previous-runs`, lead 1/3/5 days, 2022-2026). | **Extend the canonical producer.** Call `syncGameWeather({ seasons: [2021..2024] })`. Forecast history is not copied into the realized table: a forecast is not what happened, and mixing the two gives one column two meanings. nflverse's `game_lines.temp`/`wind` are used as an independent check on the archive values, not as a second producer. |

`engine_events` (ENGINE-00a) is not on origin/main (`git grep -ln engine_events origin/main` returns nothing), so this unit fills only the existing tables.

## 2. Published counts, recorded before the load (the floor)

Command, run on the files downloaded 2026-09-23 ~21:08Z from
`github.com/nflverse/nflverse-data/releases/download/{pbp,pbp_participation}/`,
kept in `.local-db/raw/` (not in the repo):

    cd .local-db/raw && python3 ../../docs/evidence/2026-09-23/proj-00-floors.py

| season | pbp rows (floor) | pbp games | participation rows | participation games | rows with offense_players | offense player slots |
|---|---|---|---|---|---|---|
| 2021 | 49,922 | 285 | 50,714 | 285 | 46,326 | 509,590 |
| 2022 | 49,434 | 284 | 50,150 | 284 | 45,858 | 504,441 |
| 2023 | 49,665 | 285 | 46,168 | 285 | 46,168 | 507,851 |
| 2024 | 49,492 | 285 | 45,919 | 285 | 45,919 | 505,109 |
| 2025 | 48,771 | 285 | 45,184 | 285 | 45,184 | 497,028 |

sha256 prefixes: pbp 2021 `e8743a568f99667a`, 2022 `0c69a71eb3949895`,
2023 `4649804ee0f0a40b`, 2024 `23370d5d10f8104d`, 2025 `2f135887790a013f`;
participation 2021 `b58e79cd91ea0783`, 2022 `37eae0a8c388d097`,
2023 `ad01aeb4045ee19a`, 2024 `b1f436a98b2a7759`, 2025 `59069adfee7b0f46`.

Participation is published for every season from 2021 to 2025, so the unit does not split on
availability. Route runners are not published per play: the file's `route`
column is the targeted receiver's route only. `was_route_runner` stays NULL.

## 3. Acceptance checks, fixed before the load

- **pbp:** `SELECT season, count(*) FROM nfl_play_by_play WHERE season BETWEEN 2021 AND 2025 GROUP BY season`
  must be >= the pbp floor above for every season.
- **participation match (row check 3):** for each season 2021-2025, the share of
  `player_week_snaps.offense_snaps` (all rows with offense_snaps > 0; the writer is
  `syncSnapCounts`, `server/services/nflverse.js:300`, REG weeks only) whose player-week
  (`players.id` -> `players.gsis_id`, season, week) has at least one
  participation row. Pass: >= 0.95 every season. Secondary, reported but not
  gating: the participation play count over PFR offense snaps on the matched
  player-weeks.
- **weather:** 2021-2024 outdoor, non-neutral home games (`game_lines`, the
  `outdoorGames` filter) get archive rows. Every failure is listed. The archive
  temperature is checked against nflverse `game_lines.temp` (degF) on the same
  game.
- **holdout:** this unit grades nothing on 2025. The 2025 pbp and participation
  load and the 2025 match rate are data-integrity checks. They get one ledger row anyway,
  so the 2025 look is visible.

## 4. RED / GREEN

- Floors: `f9b4d469` "docs: PROJ-00 audit and published-count floors recorded before any load".
  It was committed before any row was loaded.
- RED: `902a53a6` "test: PROJ-00 RED - licence gate, nflverse pbp mapping,
  participation players table". 9 of 9 failed. Failing assertion for row check
  (1), inline: `assert.equal(result.status, 2, 'backfill-history.mjs pbp: exit 1; stderr: Cannot find module .../scripts/backfill-history.mjs')`.
  The others failed on missing modules: `licence-gate.js`, `nflverse-pbp.js` and
  `nfl-participation.js`; `by_source` undefined on `pbpStatus()`; the
  `nfl_play_participation_players` table was absent.
- GREEN: `f876c686` "feat: PROJ-00 load nflverse pbp and participation players
  behind a licence gate". 9 of 9 pass.
- Hardening: `19d403df` "test: PROJ-00 pin the participation command end to end
  and the route's season filter". 10 of 10 pass. It was added because mutation M8 (below)
  showed no test ran the participation command with the real licence file, and
  M10 survived the first sweep.

Test command, run on each tree:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gridiron-test-XXXXXX).sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/proj-00-history-backfill.test.js`.
Adjacent test `test/nfl-pbp-team-code-dedupe.test.js`: 3 of 3 pass on the GREEN tree.

## 5. What it does, and the numbers (local copy, not production)

What changed:
- **Licence gate** `server/services/licence-gate.js`. `licenceDecision(source)` reads the
  `decision:` lines of `docs/evidence/2026-09-23/proj-00-licences.md`. A missing
  file, an unnamed source, or any word but `usable` means refuse. Both loaders
  ask it before they open a database.
- **pbp**: `scripts/backfill-history.mjs pbp <season> <file>` calls
  `ingestNflversePbpFile` (`server/services/nflverse-pbp.js`). It streams the
  gzip through `server/services/csv-stream.js`, maps each row with
  `mapNflversePlay`, and writes one game per transaction through the existing
  writer `storePlays` (`server/services/nfl-espn-pbp.js:181`). The table is
  `nfl_play_by_play`. `backfillSeasons` (`nfl-espn-pbp.js:380`) now skips a season
  that nflverse filled. `pbpStatus` (served at `GET /api/nfl-betting/pbp/status`)
  gains `by_source`.
- **participation**: `scripts/backfill-participation.mjs <season> <file>` calls
  `ingestParticipationFile` (`server/services/nfl-participation.js`). It writes
  `nfl_play_participation_players` (migration
  `server/migrations/074_nfl_play_participation_players.js`, **additive: one new
  table plus one index**). The reader is `participationStatus`, at the new
  `GET /api/nfl-betting/formations/participation`.
- **weather**: `scripts/backfill-history.mjs weather 2021 2022 2023 2024` calls
  the canonical `syncGameWeather` (`server/services/nfl-weather.js:51`). The table is
  `nfl_game_weather` and the source is `open-meteo-archive`. The weather code itself is unchanged.

Setup: `runMigrations()` on `.local-db/data.sqlite` applied 073 and 074. The
automatic pre-migration `.bak` (909 MB) was deleted right after.

**pbp (row check 2).** Command: `SELECT season, count(*), count(distinct event_id) FROM nfl_play_by_play GROUP BY season`.

| season | rows | floor | games | load seconds |
|---|---|---|---|---|
| 2021 | 49,922 | 49,922 | 285 | 4.5 |
| 2022 | 49,434 | 49,434 | 284 | |
| 2023 | 49,665 | 49,665 | 285 | |
| 2024 | 49,492 | 49,492 | 285 | |
| 2025 | 48,771 | 48,771 | 285 | 4.4 |

Every season equals its floor (>= holds). Peak RSS was 124-128 MB per season, from the
command's own `max_rss_mb`. The 2026 ESPN rows are untouched: 160 rows, 1 game. Of
the 2024 rows, the engine vocabulary gives: rush 14,936; pass 12,184; NULL (not
simulated) 10,645; incompletion 6,039; punt 2,119; sack 1,392; fg_make 982;
kneel 437; interception 405; fg_miss 184; fumble 169.

**Participation (row check 3).** Command: `node scripts/backfill-participation.mjs <season> <file>`.
It prints `participationStatus`.

| season | file rows | plays with players | player rows | PFR offense snaps | matched snaps | **snap match share** | matched play ratio |
|---|---|---|---|---|---|---|---|
| 2021 | 50,714 | 46,326 | 509,590 | 208,235 | 206,799 | **0.9931** | 1.0775 |
| 2022 | 50,150 | 45,858 | 504,441 | 204,620 | 202,954 | **0.9919** | 1.0783 |
| 2023 | 46,168 | 46,168 | 507,851 | 206,159 | 203,694 | **0.9880** | 1.1069 |
| 2024 | 45,919 | 45,919 | 505,109 | 206,262 | 203,863 | **0.9884** | 1.1131 |
| 2025 | 45,184 | 45,184 | 497,028 | 200,333 | 198,029 | **0.9885** | 1.1130 |

Every season passes the 0.95 floor. The player rows equal the recorded slot counts exactly.
Cross-source check: every one of the 2,524,018 participation rows joins to an
`nfl_play_by_play` row on (game_id, play_id). The count of orphans is 0:
`SELECT count(*) FROM nfl_play_participation_players p WHERE NOT EXISTS (SELECT 1 FROM nfl_play_by_play b WHERE b.event_id=p.game_id AND b.play_id=CAST(p.play_id AS TEXT))`.

**Weather (row part 4).** `syncGameWeather` result: 768 outdoor home games, 736
written, 32 skipped (the `STADIUMS` indoor/unknown guard), 0 failures, 235.9 s.
Rows by season: 2021 188, 2022 183, 2023 183, 2024 182. The check against
nflverse `game_lines.temp`/`wind` on the same games:

| season | games | with nflverse temp | mean abs temp gap (degF) | mean signed gap | gap > 10 degF | mean abs wind gap (mph) |
|---|---|---|---|---|---|---|
| 2021 | 188 | 188 | 2.28 | +0.11 | 3 | 3.24 |
| 2022 | 183 | 107 | 2.81 | +0.04 | 4 | 3.37 |
| 2023 | 183 | 158 | 2.12 | -0.65 | 1 | 2.40 |
| 2024 | 182 | 179 | 2.20 | -0.52 | 4 | 2.37 |

Sign: gap = archive minus nflverse. The two sources agree within a few degrees, with no bias.

**ESPN leaguedefaults 2025 (row part 3): not done.** The licence is blocked (section 4
of the licence file), so there is no pull, no archive file and no ledger row for
the pull.

**DB growth** (dbstat on the local copy): `nfl_play_participation_players` 117.8
MB plus its index 107.3 MB; `nfl_play_by_play` 46.8 MB plus indexes 10.6 MB. The
file went from 926,785,536 to 1,232,916,480 bytes before the weather rows.

## 6. Mutation sweep

The script is in the scratchpad; each mutant is applied with perl, the test file is run, and the original is restored.

| id | mutant | where | result |
|---|---|---|---|
| M1 | gate returns usable for any verdict | licence-gate.js | killed (1 fail) |
| M2 | gate allows a missing licence file | licence-gate.js | killed (2) |
| M3 | sack check removed | nflverse-pbp.js | killed |
| M4 | team codes not canonical | nflverse-pbp.js | killed |
| M5 | **call site**: ESPN skip removed | nfl-espn-pbp.js backfillSeasons | killed |
| M6 | no per-game flush | nflverse-pbp.js | killed |
| M7 | season guard removed | nflverse-pbp.js | killed |
| M8 | **call site**: participation script asks the gate for the wrong source | backfill-participation.mjs | killed (by the hardening test) |
| M9 | match share counts every snap as matched | nfl-participation.js | killed |
| M10 | **call site**: route drops `?season=` | nfl-betting.js | survived the first sweep, killed after `19d403df` |
| M11 | **designed survivor**: spike maps to NULL instead of incompletion | nflverse-pbp.js | survived, as designed. No test pins the spike mapping, because it is a guess (see known defects) |
| M12 | **not-applied control**: pattern that matches nothing | nflverse-pbp.js | reported NOT APPLIED; suite not run |

## 7. Known defects and follow-ups

1. **ESPN 2025 weekly projections are blocked by licence.** Only Nick can decide
   whether scripted ESPN pulls are acceptable under the Disney ToU. The R&D loop's
   2021-2024 and 2026 files predate this unit and are outside it.
2. The `qb_spike` -> `incompletion` mapping is a guess at ESPN parity, and the
   designed survivor M11 leaves it unpinned. There are 0-2 spikes per game.
3. **Superseded by section 10.** Two producers count "offense snaps": PFR `player_week_snaps` (canonical,
   `syncSnapCounts`) and participation plays. Before the fix, on matched player-weeks,
   participation counted 7.8-11.3% more, because it stored punt, field-goal and kickoff units.
   Scrimmage-only, the gap is 0.08-0.21%. This unit
   shows the ratio only on the status route and does not publish a
   participation snap count, so `player_week_snaps` stays the one snap producer.
   Follow-up: name which one feeds any future per-player number.
4. `nfl_play_by_play` readers (`liveModelValidation`, `playDistributionAudit`,
   `formationReport`) now see about 247k history plays instead of 160. That is the intent:
   history for validation. nflverse `total_home_score` is taken as the running
   score after each play, the same meaning as ESPN's `homeScore`. That match is a guess
   from the two data dictionaries, not a stored side-by-side comparison.
5. Production footprint is about +290 MB for 2021-2025. The loaders are commands and are
   not on the timer (rule 13). Running them on the 2 GB Fly machine is Nick's
   call. Each season peaked at about 128 MB RSS here.
6. The pre-2023 "NFL NextGenStats via nflverse" credit has no `sources`
   descriptor on `/api/data-freshness`. That gap was noted in the licence file and predates this unit.
   `participationStatus` returns the per-season credit.
7. `node scripts/wiring-map.mjs --check` exits 1 with 6 unresolved receivers in
   files this unit does not touch. The output is identical with this unit's changes
   stashed on base `309877ef`.

## 8. Holdout looks

Two data-integrity looks at 2025: ledger rows L160 and L161 (the re-check after the
skeptic fixes, section 10) in `docs/evidence/HOLDOUT-LEDGER.md`.
No outcome, projection or model was graded.

## 9. Nick's five questions

1. **Well built?** It reuses the one `nfl_play_by_play` writer and the one
   weather producer. There is one new additive table with a reader on a route, and loads stream from files.
   10 tests cover it, and 10 of 11 applied mutants were killed; the one survivor was designed in.
2. **Stats or made up?** It is counts only. Each number above has its command. The floors
   were committed before the load (`f9b4d469`).
3. **How we know?** Every pbp season equals the published count. Participation covers
   98.8-99.3% of PFR snaps. There are 0 orphan participation rows. Archive weather is within
   about 2.5 degF of nflverse's own game temperature.
4. **Pointed elsewhere?** ESPN 2025 was stopped by the licence. Forecast history
   was not used as realized weather, because a forecast is not what happened.
5. **How does it unify?** One game has one producer: ESPN skips seasons nflverse
   filled. The play, participation and formation tables share one game key
   (the nflverse game_id).

## 10. Skeptic round 1: fixes and re-measure

Commits: RED `ca02e055` (tests only), GREEN `7a359b24` (fix). Test file: 12/12 pass on
`7a359b24`; on `ca02e055` tests 5, 9 and 11 fail (3 of 12). Tests 1 and 3 are liveness
tests that pass on both trees and kill mutants A and C below. Command:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/proj-00-history-backfill.test.js`.

**What changed.**

1. The gate test now shows that any verdict word other than `usable` refuses. It checks the committed
   `ftn_charting not pulled` line and a temp file that says `pending`. A new script test writes a licence
   file where only the called loader's own source is blocked and the others are usable, for pbp, weather
   and participation. Each run must exit 2, name its own source in stderr, and create no DB.
2. `classifyNflverse` (`server/services/nflverse-pbp.js`) returns null when `two_point_attempt == 1`. This
   matches `classifyPlay`'s `'two-point'` -> null. Before, a failed two-point pass was stored as a
   completed `pass`.
3. The one-producer check now works both ways. `espnPlays(season)` (`nfl-espn-pbp.js`) counts
   non-nflverse rows. `ingestNflversePbpFile` throws, and `backfill-history.mjs pbp` refuses with
   exit 2, when the season already holds ESPN plays.
4. `ingestParticipationFile` (`server/services/nfl-participation.js`) keeps only offensive snaps. It
   judges each play against its nflverse row in `nfl_play_by_play`:
   - punt, fg_make and fg_miss are skipped;
   - other typed plays are kept;
   - untyped plays are kept only when the feed recorded an `offense_formation`. That covers post-snap
     penalties and two-point tries. Kickoffs, extra points and pre-snap penalties have no formation.

   The loader refuses a season with no nflverse pbp, and it refuses a play that has players but
   no pbp row. The migration 074 comment now says "per offensive snap". There is no schema change.

**Where the rule came from** (a scratch Python cross-tab of the release files; the numbers are
per-play counts from the participation file):

- In 2024, kickoff, XP, punt and FG units, and 1,150 pre-snap `no_play` rows, have an empty
  formation.
- Kneels (437) and spikes (75) also have an empty formation but count as snaps. So formation
  alone is not the rule; formation is used only for untyped rows.
- Other rules tried, as the 2024 matched play ratio:
  - pass/run/kneel/spike only: 0.950 (it misses post-snap penalty snaps);
  - adding every non-special-teams no_play: 1.023 (it counts pre-snap fouls);
  - `offense_formation` non-empty alone: 0.986 (it drops kneels and spikes).

**Re-measure** (fresh scratch DB: migrations, then `players` and 2021-2025
`player_week_snaps` copied from the local copy, then
`backfill-history.mjs pbp <y>` and `backfill-participation.mjs <y>` for 2021-2025
on tree `7a359b24`; local copy, not production):

| season | pbp rows (floor) | plays kept | player rows | kicking skipped | untyped, no formation, skipped | PFR snaps | snap match share | matched play ratio (was) |
|---|---|---|---|---|---|---|---|---|
| 2021 | 49,922 (49,922) | 37,752 | 415,270 | 3,262 | 5,312 | 208,235 | 0.9931 | **0.9984** (1.0775) |
| 2022 | 49,434 (49,434) | 37,328 | 410,606 | 3,399 | 5,131 | 204,620 | 0.9919 | **0.9979** (1.0783) |
| 2023 | 49,665 (49,665) | 37,558 | 413,132 | 3,459 | 5,151 | 206,159 | 0.9880 | **0.9989** (1.1069) |
| 2024 | 49,492 (49,492) | 37,219 | 409,407 | 3,285 | 5,415 | 206,262 | 0.9884 | **0.9986** (1.1131) |
| 2025 | 48,771 (48,771) | 36,666 | 403,318 | 3,182 | 5,336 | 200,333 | 0.9885 | **0.9992** (1.1130) |

- The snap match share is unchanged to four places. RED check 3 still passes, and it no longer
  counts special-teams rows.
- **The remaining gap**: participation counts 0.08-0.21% fewer plays than PFR on matched
  player-weeks. That is about 1 play in 600. Why is a guess: a few plays where the feed's player list
  and PFR's charting differ. It was not traced play by play.
- Orphans (participation with no pbp row): 0.
- Participation plays by pbp type, 2024: rush 14,898; pass 12,074; incompletion 6,039;
  NULL 1,805; sack 1,392; kneel 437; interception 405; fumble 169; punt/FG 0.
  Command: a `sqlite3` join on (game_id, play_id).
- Two-point tries: every row whose text has `TWO-POINT CONVERSION ATTEMPT` is now NULL.
  The counts by season are 164, 141, 145, 155 and 136. Before the fix, 2024 had
  pass 110, rush 38 and NULL 7 (builder `.local-db`).
- ESPN guard on the builder `.local-db`: `backfill-history.mjs pbp 2026 play_by_play_2025.csv.gz` gave
  `refused: season 2026 already has 160 ESPN plays`, exit 2. The 2026 row count was 160 before and after.

**Stale copy.** The builder `.local-db` still holds the pre-fix rows: 2pt as pass/rush,
and participation with kicking units. `storePlays` upserts do not rewrite `play_type`. Nothing
reads that copy outside this unit, and it is deleted when the unit closes.
Production was never loaded.

**Mutation sweep, round 2** (`scratchpad/mut.py`: apply the mutant, run the test file, restore):

| id | mutant | result |
|---|---|---|
| A | gate: `verdict !== 'blocked'` (skeptic) | killed by test 1 |
| C | **call site**: pbp command gates on `open_meteo_archive` (skeptic) | killed by test 3 |
| D | no two-point branch | killed by test 5 |
| E | service ESPN guard off | killed by test 9 |
| F | **call site**: script ESPN guard off | killed by test 9 (exit 1, not 2) |
| G | kicking plays kept | killed by test 11 |
| H | untyped, no-formation plays kept | killed by test 11 |
| I | every untyped play dropped | killed by test 11 |
| J | no-pbp guard off | killed by test 11 |

