---
name: gridiron-nflverse-cc-by-attribution
description: "nflverse-data is CC BY 4.0 (master/LICENSE.md) and the app gives it no attribution anywhere user-visible; ffopportunity.js is the one source that declares a data_license, and it is the pattern to copy."
metadata:
  type: project
---
Explorer, 2026-09-22, read on tree `654ff93` [[gridiron-name-the-tree-rule]].
Package `/mnt/project-files/PACKAGE-NFLVERSE-ATTRIBUTION-2026-09-22.md`.

**The licence, fetched not assumed:**
`https://raw.githubusercontent.com/nflverse/nflverse-data/master/LICENSE.md`
→ 200, first line **"Attribution 4.0 International"** (CC BY 4.0). The reader
package `nflverse/nflreadr` is separately MIT. CC BY is free for commercial and
derived use; its one substantive obligation is **attribution**.

**The app pulls from that repo** — `RELEASE` in `nflverse.js`, `REL` in
`nfl-advanced.js:27` — feeding at least `player_week_usage`, `player_week_snaps`,
`nfl_snaps`, `nfl_ngs`, `nfl_pfr_adv`, `nfl_depth`, `nfl_injuries`,
`nfl_play_charting` and the pbp behind `nfl_team_week_features`.

**Measured absence:** `grep -rn data_license server/ client/ scripts/` → ONE
line, `ffopportunity.js:21`. `grep -ril "CC BY|creativecommons"` (no
node_modules) → ONE file, the same one. nflverse appears in `client/src` twice
and neither is attribution: `DataSetupBanner.tsx:12` is a code COMMENT,
`Model.tsx:58` is a status count. gridiron-hq itself has no LICENSE file
(neutral — Nick's call, noted only because the repo is public).

**The pattern to copy** is `ffopportunity.js:17-23`: a frozen
`FFOPPORTUNITY_SOURCE` with `data_license: 'CC BY 4.0'`, returned on the API
surface at `:89` and `:127`, plus a header at `:9-10` distinguishing the DATA
licence from the package CODE licence (GPL-3, not copied).

**METHOD LESSON, and it nearly bit me:** my Sharp Football refusal checked only
`main/LICENSE` and `main/LICENSE.md`. nflverse's licence lives at
`master/LICENSE.md` — a path that check never tried. **Always probe LICENSE and
LICENSE.md across master, main and gh-pages before concluding "no licence".**
Re-ran it for Sharp: all six 404, refusal stands and never rested on that leg
alone. [[gridiron-licence-before-measurement-rule]]
[[gridiron-sharp-football-source-refused]]

**Not legal advice.** What satisfies CC BY for a single-user deployed app is a
judgement call; the finding is that there is NOTHING, which is the one state
that is clearly not enough.

## 18:50Z: nfldata DROPPED; officials + coaches come from nflverse-data (CC BY 4.0)
**Thread "Licensed source for refs and coaches"** (started on Nick 18:30:22Z cmsg_01YAsw8AnFv4ioRMQw8dfPmTME1jXFkAM8767qTfTJSdqv "go get refs nd coahces pls figure it out look it up"; resolved 18:50Z; only CSV header lines were pulled). Nick told 18:50Z.
- **nfldata DROPPED:** LICENSE / LICENSE.md / LICENSE.txt / COPYING all 404 on master, main and gh-pages (raw.githubusercontent.com, 18:3xZ); README credits Lee Sharpe, no licence; nothing says nfldata inherits CC BY; nflreadr's DESCRIPTION "MIT + file LICENSE" covers code only, its README says data is "governed by their terms of use". Nothing was ever pulled from it.
- **Officials (per game, 2015+):** `https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv` (200; what `nflreadr::load_officials()` reads). Columns game_id, game_key, official_name, position, jersey_number, official_id, season, season_type, week; one row per official per game. **KEYING: game_id is the old 10-digit id (2015091000), not 2015_01_X_Y.**
- **Head coaches + referee (per game):** `https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv` (200) has away_coach, home_coach, referee, game_id, old_game_id. **Do NOT use nflreadr::load_schedules' URL** (it points at nfldata's games.rds).
- **Licence:** nflverse-data `master/LICENSE.md` = CC BY 4.0 → add "officials and schedules" to the existing credit (Release #133 + the UI line). Suggested credit line: **"Officials and schedule data: nflverse (nflverse-data releases), CC BY 4.0."**
- **Assistants / coordinators:** not in nflverse. Wikidata CC0 (coverage unmeasured). **Pro Football Reference REFUSED** (data_use.html forbids competing databases / redistribution). ESPN / NFL.com: no open licence.
- **NEXT UNIT (after the freeze): Scheduler** ingests officials.csv + games.csv — licence descriptor first, table + writer function named file:line ([[gridiron-name-the-table-rule]]). Brake answer still owed by Nick. Origin [[gridiron-state-1298-2026-09-22]].
