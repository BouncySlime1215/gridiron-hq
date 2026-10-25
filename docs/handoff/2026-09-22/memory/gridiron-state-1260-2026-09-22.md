---
name: gridiron-state-1260-2026-09-22
description: "17:38Z-17:41Z twenty-second batch: Sharp Football REFUSED on licence (nothing wired or stored, 2025 never fetched); NEW FLEET RULE licence-before-measurement; Explorer FINDING that FTN charting columns never reach nfl_team_week_features, routed to Planner as incumbent state for migration-070 with nfl-pbp.js granted; Nick milestone line held until production charting rows confirmed"
metadata:
  type: project
  modified: 2026-09-22T17:43:00.000Z
---
- **Sharp Football REFUSED on licence** ([[gridiron-sharp-football-source-refused]], Explorer): no LICENSE file; README says the data comes from a restricted Google Sheet; the Pages index says it exists only to serve sharpfootballanalysis.com's paid widgets; robots noindex. **Nothing wired or stored; pulled files deleted; 2025 never fetched.** [[gridiron-sharp-football-source]] updated to status REFUSED with a pointer.
- **NEW FLEET RULE** [[gridiron-licence-before-measurement-rule]]: the licence/terms check is a **gate BEFORE measuring** whether any external data is good. Explorer measured first this time and says so.
- **FINDING (Explorer, [[gridiron-charting-never-reaches-team-week]]):** the FTN charting columns (`migration 059_play_charting_ftn_columns.js:10-13`) **never reach `nfl_team_week_features`** — `nfl-pbp.js:539` write, `:440-545` 88 suffixes, zero charting refs; the five columns' only consumer is `nfl-formations.js`; `nfl-team-tendencies.js:5` and `nfl-ensemble.js:2446` inherit the gap. Package `/mnt/project-files/PACKAGE-CHARTING-TEAM-WEEK-GAP-2026-09-22.md`, pre-registered on 654ff93, no held-out split claimed. **Production rows in `nfl_play_charting` UNVERIFIED** (rig 0 rows; settled by Explorer's read script when Nick runs it).
- **Routed 17:41Z to Planner** as the incumbent state for its migration-070 unit; **`nfl-pbp.js` granted to Planner** for that unit ([[gridiron-file-allocation]]). **Nick milestone line HELD** until production rows are confirmed.
Prev [[gridiron-state-1259-2026-09-22]]. Next [[gridiron-state-1261-2026-09-22]].
