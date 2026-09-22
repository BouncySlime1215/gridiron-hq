---
name: gridiron-070-vs-059-serving-gap-2026-09-22
description: "Why the migration-070 participation columns are history-only and cannot serve a live 2026 week, and why the 059 FTN charting columns are the unit to build instead (Planner pre-registration, 2026-09-22)"
metadata:
  type: project
---

Pre-registration: `/mnt/project-files/PREREG-070-CHARTING-TEAM-WEEK-2026-09-22.md`,
verified on `claude/project-thread-2oztzw` at `4a8085c` (`origin/main` `f620a12`).
Sent to the coordinator 17:40Z; **coordinator agrees with the recommendation and
has put the 059-vs-070 question to the Auditor as the first ruling. No code until
it rules.**

## The finding

`nfl_play_formations` has **exactly one writer**, `ingestFormations` at
`nfl-formations.js:89`, and it fetches
`pbp_participation/pbp_participation_${season}.csv`. Measured on the release
path: **2022-2025 return 206, 2026 returns 404.**

So the migration-070 columns (`was_pressure`, `defense_man_zone_type`,
`defense_coverage_type`, `time_to_throw`) are **history-only, 2016-2025**. They
train and validate; they cannot serve the season the app is projecting.

Migration 059's own header already said this: "Man/zone participation data stops
at 2025; FTN charting is published weekly for 2026."

Both feeds probed by command 2026-09-22 (`curl -sL -r 0-0 -w '%{http_code}'`
against `nflverse-data/releases/download/<feed>/<feed>_<season>.csv`):

| season | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|
| ftn_charting (059) | 404 | 404 | 404 | **206** | 206 | 206 | 206 | **206** |
| pbp_participation (070) | — | — | — | 206 | 206 | 206 | 206 | **404** |

**FTN's first season is 2022**, so the 059 window is 2022-2026 — with 2025 held
out, only THREE fitting seasons. Short, and it must be stated rather than padded
by borrowing participation seasons.

Coverage of both in `nfl_team_week_features` is **0**.

**Build 059; use 070 only as held-out history.** Building 070 alone designs in a
fit/serve mismatch from the start — the fifth of the day. See
[[gridiron-five-questions-rule]].

## Auditor R56 (17:42Z): build on 059, NOT 070

Condition: the two feeds are DIFFERENT SOURCES for "pressure" and are never
pooled; 070 rows enter only as a **crosswalk** (do FTN and participation pressure
agree on the 2022-2025 overlap), never as training rows.

R56 also ruled the unit **out of scope as written**: `nfl_team_week_features`'
only predictive reader is the betting game model. The unit was re-pointed at the
fantasy matchup multiplier — see [[gridiron-matchup-multiplier-seam-2026-09-22]].

## Corrections to the routing (tree-dependent — main moved between readings)

- `writeTeamWeeks` is `nfl-pbp.js:563`, INSERT `:564` — **not `:539`**.
- **91** distinct feature key suffixes at `:447-559` — not 88 at `:440-545`.
- **Six** 059 columns have exactly one consumer (`nfl-formations.js`), not five:
  `n_blitzers`, `n_pass_rushers`, `created_reception`, `read_thrown`,
  `interception_worthy`, `qb_fault_sack`. `catchable` has three.
- **`drop_` has ZERO consumers.** I first called it uncountable by grep; that was
  the right caution for the wrong reason. `grep -rnE "\bdrop_\b" server/
  --include=*.js`, minus migrations, returns exactly 2 hits, both in the writer
  (`nfl-formations.js:154`, `:164`). A substring grep is noise; a column-name
  match is not.
- Charting references in `nfl-pbp.js`: **zero**, by grep count.

## Standing caveat

**Nobody has shown `nfl_play_charting` holds rows in production.** Until
Explorer's read script runs, every number from this unit scopes to the
development database. **If production is empty this is a backfill item, not a
feature improvement**, and it joins the QBR crosswalk row in PLAN-09 §4.

Sharp Football stays refused on licence [[gridiron-sharp-football-source-refused]];
nothing here derives from it.
