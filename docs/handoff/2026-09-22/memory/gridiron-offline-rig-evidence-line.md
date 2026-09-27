---
name: gridiron-offline-rig-evidence-line
description: The offline rig (repo's own code + free nflverse data) is the REQUIRED evidence line for any constant or head proposal as of 2026-09-22 — directions only, never magnitudes, and it reports "no effect" for anything it is blind to.
metadata:
  type: project
---

Built by Data & techniques R&D, package #18, 2026-09-22. Files in
/mnt/project-files: `load-rig.mjs`, `a6-item1/2/2ci/3.mjs`, `A6-RECONCILE-SPEC.md`.

**What it is:** `npm ci`; `GRIDIRON_DB_PATH` at a scratch sqlite;
`runMigrations()` (266 tables); nflverse free `stats_player_week_<season>.csv`
loaded into `players` and `player_week_usage` (2020-2024 REG, QB/RB/WR/TE/FB,
29,428 player-weeks, 1,140 players); then `replaySeasonWeekly()` and
`pairedBootstrapDiff()` run **unmodified**. ~6s/season.

**Auditor ruling 2026-09-22 08:36Z: ADOPTED as the required evidence line for any
constant or head proposal, replacing proxy metrics. Two binding conditions.**

**CONDITION A — ORIGINAL WORDING RESTORED 2026-09-22 (the 09:28Z amendment is
WITHDRAWN). Directions and monotonic orderings only, NEVER magnitudes.** The rig
reads the volume-k win 3-5x smaller than the repo's record (rig 0.074-0.149 vs
repo ~0.35-0.46) and that gap is still unexplained.

The 09:28Z amendment permitted magnitudes on an "absence-fixed" rig, on the
grounds that `add-absences.mjs` (11,250 synthetic rows from free
`weekly_rosters`) reproduced the repo's magnitude. **Unit 12 showed that was
wrong.** The required level check is what caught it: adding those rows moved the
rig's absolute 2024 level from 4.757 to 4.514, i.e. FURTHER from the repo's
4.921, not closer. The augmentation made the rig diverge; a magnitude that
matches while the level diverges is a coincidence, not a calibration. The
absence rows also make an absent player look played-with-actual-zero, which
production never does (`weekly-backtest.js:177` is `if (!played) continue`; the
repo's own availability metric is `decision_including_dnp` / `_decision_rows`).

**So: no magnitude claim from this rig, fixed or unfixed.** The level check
stays as a standing requirement on any rig extension.

**CONDITION B — THE BLINDNESS CHECK, the rig's most dangerous property.**
`nfl_snaps`, `nfl_injuries`, `nfl_qbr_weekly`, `nfl_depth` are **empty**, and a
player ruled Out has **no `player_week_usage` row at all** (verified: of 980 Out
rows in 2023, 288 map to a skill player, zero have a usage row). A change touching
any of that **produces no effect on the rig and THE RIG REPORTS "NO EFFECT", NOT
"CANNOT TELL"** — a machine for silently killing feature work in the areas
production data is richest. **Every rig submission must state which of the four
empty tables the change under test touches.** If any, the rig cannot rule and must
say so. A submission without that line is incomplete.

**Why it was accepted:** it reproduces a known-true result in BOTH directions
before being trusted on an unknown one — the repo's recorded volume-k win (held
out, both seasons, Spearman up) and the repo's recorded efficiency-k rejection.
That is the calibration standard; demand it of any successor instrument.

**Extending it:** loading a new table changes what is in the database under a
calibration established without it. **Acceptance test for any extension: #18's own
volume-k validation, re-run on both seasons, result unchanged OR moved measurably
CLOSER to the repo's recorded figure with the mechanism named.** ("Unchanged" alone
was the auditor's first wording and was wrong — it would have rejected the absence
fix, which moved the numbers by 4× in the right direction. A move away, or an
unexplained move, fails.)
Snap counts extend it legitimately (completed-game facts). Injury designations do
NOT — nflverse publishes snapshots, not as-of history, so an injury grade on the
rig uses final designations and is a LOOK-AHEAD UPPER BOUND: **it can kill a unit,
never promote one.**

**Label rule:** every rig number carries "rig, not production" in the same
sentence as the number — not a header, not a footnote.

See [[gridiron-k-yards-per-34-stands]], [[gridiron-auditor-thread-standing-2026-09-22]].
