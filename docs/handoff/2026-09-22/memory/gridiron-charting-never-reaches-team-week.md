---
name: gridiron-charting-never-reaches-team-week
description: "The FTN charting columns the app ingests weekly (n_blitzers, n_pass_rushers, catchable, drop_, read_thrown...) never become team-week features: nfl-pbp.js builds all 183 from play-by-play alone and never reads nfl_play_charting."
metadata:
  type: project
---
Measured by Explorer 2026-09-22 on tree `654ff93`. Free, in-house, no licence question.

**The ingest exists.** `server/migrations/059_play_charting_ftn_columns.js:10-13`
adds `n_blitzers, n_pass_rushers, catchable, created_reception, drop_,
read_thrown, interception_worthy, qb_fault_sack` to `nfl_play_charting`, and its
header says FTN charting "is published weekly for 2026".

**The team-week builder never reads it.** `server/services/nfl-pbp.js` writes
`nfl_team_week_features` at `:539` and contains ZERO references to
`nfl_play_charting` or `charting`. Its feature object has **88 distinct key
suffixes** (`:440-545`), every one derived from play-by-play.

**Missing entirely from those 88:** man coverage, blitz rate, pressure *rate*
(only `pressure_epa` / `clean_pocket_epa` exist), play-action rate, play-action
EPA, time to throw, 11/12 personnel, yards before contact, run yards after
contact.

**Sole consumer.** `n_blitzers`, `n_pass_rushers`, `read_thrown`,
`qb_fault_sack` and `created_reception` are each read by exactly ONE file in the
tree: `server/services/nfl-formations.js`.

**Why it matters:** `nfl-team-tendencies.js:5` describes "183 features each"
under the X's & O's page, and `nfl-ensemble.js:2446` names
`nfl_team_week_features` as `team_features`. Both inherit the gap.

**NOT YET ESTABLISHED:** whether `nfl_play_charting` holds any ROWS in
production. The rig has 0 rows in every NFL table. The table is in the pristine
census list of `EXPLORER-READ-B-2026-09-22.sh`, so the production read settles
it at no extra cost. Until then this is reachability, not availability.

Weaknesses registered: FTN starts 2022 (ragged left edge beside pbp features);
`n_blitzers` is charted judgement, so charter drift can look like a trend.
Pre-registered check in `/mnt/project-files/PACKAGE-CHARTING-TEAM-WEEK-GAP-2026-09-22.md`.
Found while refusing [[gridiron-sharp-football-source-refused]].

**Correction 18:31Z (Planner, measured on 4a8085c; see [[gridiron-state-1271-2026-09-22]]):** `writeTeamWeeks` is `nfl-pbp.js:563` with the INSERT at `:564` (not `:539`); the suffix list is 91 entries at `:447-559` (not 88); six 059 columns have a single consumer, not five (`catchable` has three); `drop_` cannot be counted by grep. The conclusion (charting never reaches `nfl_team_week_features`) stands. Also: the 070 participation columns are history-only — `pbp_participation_2026.csv` returns 404 — so the build target is the 059 FTN charting unit with 070 as held-out history.
