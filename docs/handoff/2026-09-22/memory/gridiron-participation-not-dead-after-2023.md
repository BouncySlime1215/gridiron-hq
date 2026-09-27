---
name: gridiron-participation-not-dead-after-2023
description: nfl-formations.js says participation ends after 2023 — false, 2024 and 2025 exist and are better filled; and ingestFormations drops five columns including route type and coverage.
metadata:
  type: project
---

Measured 2026-09-22 against the actual nflverse files.

**The repo's comment is wrong.** `server/services/nfl-formations.js:23-26`
(repeated in the error note at :60-63) says "participation ends after 2023 —
the NFL restricted the tracking feed behind it." False.
`pbp_participation_2024.csv` (45,919 rows) and `_2025.csv` (45,184) both
return 200 and are BETTER populated than 2022: personnel, defenders in box and
number of pass rushers are all 1.000 for 2023-2025 against 0.762 / 0.744 /
0.427 in 2022. The true statement is "ends after 2025; the current season is
not published" — `pbp_participation_2026.csv` is a genuine 404.

**Consequence:** anyone reading that comment writes off two full seasons of
formation data that exist and that `ingestFormations` already handles.

**The bigger find: `ingestFormations` (:55-95) downloads a 49 MB file and
stores nine of its columns.** These five are dropped and are not in
`nfl_play_formations`:

    route                  route type of the TARGETED receiver
    was_pressure           1.000 filled from 2023
    time_to_throw          seconds snap to release
    defense_man_zone_type  man or zone
    defense_coverage_type  coverage shell

`route` joins to a player through pbp's `receiver_player_id` on **99.4% of
targets** (2025: 17,469 of 17,582; completions 99.9%; sacks 0.1%, which is
what proves it is the target's route and not a QB field). About 17,500
labelled target-routes a season, ~70,000 over 2022-2025.

**Still NOT routes-run.** One route per play, target only — it gives a
receiver's route-type MIX among his targets, never his route count, so
targets-per-route-run still needs the Big Data Bowl bundle and Nick accepting
the competition rules.

**FTN charting IS a live in-season feed**, which no comment says:
`ftn_charting_2026.csv` had 2,854 rows, weeks 1-2, `date_pulled`
2026-09-21T17:01Z, 100% fill on all 29 columns. It charts with a lag — week 1
had 2,675 rows and week 2 only 179 — so a consumer must read the week's row
count, never assume the week is complete. `ingestCharting` stores 24 of 29
and drops nothing material.

**Correction to my own earlier claim:** I reported these release tags as 404
and treated the data as blocked. I probed the wrong path. The working one is
`https://github.com/nflverse/nflverse-data/releases/download/<tag>/<tag>_<season>.csv`,
which is what the repo has used all along.

**How to apply:** fix the comment first (one line, no behaviour change), then
ingest 2024-2025 formations, then widen the table by the five columns. Nothing
tested for signal yet — do not claim route mix predicts anything until it is
measured against target share under [[gridiron-icc-weighting-invariance]]-style
discipline and the `nfl-model-watch.js:1-18` ablation gate.

Spec: `PARTICIPATION-SPEC.md` + `verify.mjs`. Related:
[[gridiron-feeds-never-pulled]], [[gridiron-kaggle-open-access-2026-09-22]].
