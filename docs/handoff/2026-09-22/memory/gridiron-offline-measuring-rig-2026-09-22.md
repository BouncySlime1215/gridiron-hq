---
name: gridiron-offline-measuring-rig-2026-09-22
description: How to run the repo's OWN projection code and weekly MAE offline against a scratch sqlite built from free nflverse data — ends the "measured on a proxy" weakness on R&D submissions.
metadata:
  type: reference
---

Built 2026-09-22. Scripts published: `/mnt/project-files/load-rig.mjs`,
`a6-item3.mjs`. Full record `/mnt/project-files/A6-RECONCILE-SPEC.md`.

**No production access. Nothing is written to the live DB.**

    npm ci                                    # 270 packages, ~6s
    export GRIDIRON_DB_PATH=/path/to/scratch/rig.sqlite   # server/db/index.js:10
    node -e "import('./server/db/migrate.js').then(m=>m.runMigrations())"   # 266 tables
    node load-rig.mjs                         # needs stats_player_week_<y>.csv
    node a6-item3.mjs

Data: nflverse release `player_stats`, asset
`stats_player_week_<season>.csv`. **CORRECTED 2026-09-22: 2025 IS reachable.**
`stats_player_week_2025.csv` exists on that release (18,540 REG rows, 18 weeks);
the earlier "no 2025 asset / 404" reading was a naive `split(',')` artefact —
personnel strings carry commas, quote-aware splitter at `nfl-coaches.js:36`.
**2025 is the PROTECTED HOLDOUT: do not run on it.** Spending it is the
Auditor's call and then Nick's. The rig is loaded 2020-2024 by choice, so the
repo's own 2025 figures are still not reproduced. Loads `players` + `player_week_usage` (26 cols,
`mlb-model-misc.js:257-277`), REG only, QB/RB/WR/TE/FB: 29,428 player-weeks,
1,140 players.

**What then runs unmodified:** `replaySeasonWeekly(season, {distributions:false,
kOverride})` from `weekly-backtest.js` (~6s/season), `pairedBootstrapDiff` from
`backtest-significance.js`, and `buildFitSpecs`/`fitK` from `shrinkage-fit.js`.
`kOverride` is keyed `{metric: {position: k}}`; `pickK` (`projections.js:203-205`)
passes the same value for both n params at all 15 call sites, so an override
changes k only, never n.

**VALIDATED before being trusted** — it reproduces the repo's own recorded
volume-k win, held out, both seasons: 2023 4.6220→4.5480 [−0.1219, −0.0276],
2024 4.7570→4.6080 [−0.2042, −0.0917], Spearman up in both. Same sign, same
significance, same direction as the repo's record.

**HONEST LIMIT, always state it:** `nfl_snaps`, `nfl_injuries`,
`nfl_qbr_weekly`, `nfl_depth` and the rest are **empty**, so absolute MAE
differs from production (2024: rig 4.757, repo records 4.921). **Directions and
monotonic orderings are claimable; absolute levels are not.** Never present a
rig number as a production number.


**THE HEADLINE MAE CANNOT SHOW AN AVAILABILITY TERM — and that is production's
property, not the rig's defect.** `weekly-backtest.js:177` is
`if (!played) continue`, so `point.model.mae`, Spearman and `_predictions` are
conditional on the player having played. Production's `player_week_usage` is
ingested **one row per stat line** (`server/services/nflverse.js:227` reads the
same `stats_player_week_<season>.csv` the rig does), so production has no rows
for absent players either.

**Use `decision_including_dnp` / `_decision_rows` for anything about
availability, participation or injury** — they grade a did-not-play week as a
real zero for any player active the week before. The repo built that metric for
exactly this question.

**DO NOT add synthetic absence rows to `player_week_usage`.** I tried it
(`add-absences.mjs`, 11,250 rows from `weekly_rosters`) and it is WRONG: it
makes an absent player look played with actual zero, which production never
does. It moved the rig's 2024 MAE from 4.757 to 4.514 while the repo's own
record is 4.921 — i.e. away from production. It also flipped package #17 to a
false "refuted". The script is published only as a record of the dead end.
Reverted; rebuild with `load-rig.mjs` alone.

**A second trap it exposed:** on a production-faithful rig a player ruled Out
has no usage row that week, so any roster or team-mate lookup must be indexed
at **week + 1** (built from the previous week's appearances). Index on the
current week and you silently drop the very team-mate whose absence you are
testing for.

**Why it matters:** the Auditor's standing weakness on nearly every R&D
submission was "measured on a proxy, not the repo's metric". This ends that.
Use it as the gate metric for any k or head proposal.

Related: [[gridiron-yards-per-34-stands-2026-09-22]],
[[gridiron-five-questions-rule]].
