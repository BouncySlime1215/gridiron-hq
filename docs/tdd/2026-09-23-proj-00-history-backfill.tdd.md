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
