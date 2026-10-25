---
name: gridiron-officials-coaches-source
description: Licence result 2026-09-22 18:5xZ — refs and head coaches come from nflverse-data releases (CC BY 4.0), not nflverse/nfldata (no licence); PFR refused; Wikidata CC0 for assistant staff, coverage unmeasured
metadata:
  type: reference
  modified: 2026-09-22T18:32:55.960Z
---
- **Officials by game:** `https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv` (what nflreadr::load_officials reads). Cols game_id (OLD 10-digit id e.g. 2015091000), game_key, official_name, position, jersey_number, official_id, season, season_type, week; 2015+.
- **Head coach + referee per game:** `.../releases/download/schedules/games.csv` cols away_coach, home_coach, referee, game_id, old_game_id. nflreadr::load_schedules still reads nfldata games.rds — do not use that URL.
- **Licence:** nflverse-data master/LICENSE.md = CC BY 4.0 → extend the existing nflverse attribution line [[gridiron-nflverse-cc-by-attribution]].
- **nflverse/nfldata:** no licence on any leg (LICENSE/.md/.txt/COPYING 404 on master, main, gh-pages; README none) → DROP recommended [[gridiron-licence-before-measurement-rule]].
- **Assistant/coordinator staff:** Wikidata CC0 (no attribution); coverage unmeasured. **Pro Football Reference REFUSED** (data_use.html: no competing database; some datasets' licences preclude redistribution).
