---
name: gridiron-model-evidence-overnight-2026-09-22-0835
description: Stop/resume snapshot for the Model evidence audit thread at Nick's 08:31Z goodnight (2026-09-22) — what is pushed, what is open, what resumes first.
metadata:
  type: project
---

**Snapshot at Nick's goodnight, 2026-09-22 08:31Z** ("adapt usage overnight,
make sure ur ready to resume when the limits hit"). Coordinator's standing
instruction to this thread: **one message when the snap-share write-up is done,
no progress notes between.** Per the stop/resume rule in
[[gridiron-state-record-2026-09-22]].

**BRANCH:** `claude/project-thread-w0gpjt`, PR **#68**, now **out of draft and
ready for review** (Nick's 08:23Z rule: always answer ready-for-review, do not
leave PRs parked). Merging to main is still his word only.

**PUSHED AND VERIFIED at 413291c2** — two independent `npm run check` runs,
exit 0 both, **2,950 / 2,909 / 0 fail / 41 skipped**, guard captured atomically
either side of each run, `find -newermt` empty. Contents: the efficiency-constants
corrections, the weekly-ceiling withdrawal, and three downstream citation fixes.

**IN FLIGHT AT SNAPSHOT:** commit **ace95792** (snap-volume evidence) committed
locally, double guarded verification running. If the runs agree, push; if a run
is red, the failure is the deliverable, not a fourth attempt.

**OPEN, NOT MINE, FOR NICK IN THE MORNING:**
1. **Rotate `GRIDIRON_FLY_TOKEN`** (deploy-capable — first), then
   **`GRIDIRON_ANTHROPIC_API_KEY`**. I exposed both at ~08:22Z; see
   [[gridiron-never-grep-env-for-values]]. Third incident, still zero rotations
   ever confirmed ([[gridiron-open-risks]]).
2. The efficiency-k calibration point, if he wants it on production data.

**RESUME IN THIS ORDER:**
1. Re-read this file, [[gridiron-never-grep-env-for-values]] and
   [[gridiron-mid-verification-hold-rule]] before doing anything.
2. Confirm ace95792 pushed; if not, re-verify and push.
3. Ask whether either credential was rotated, and record it in
   [[gridiron-open-risks]] — the missing half of that loop is always the
   confirmation, never the detection.
4. Four parked units, all gated, me as **evidence author and grading
   counterpart**, Fantasy plan as **builder**, `projections.js` NOT mine
   ([[gridiron-file-allocation]]): volume-side shrinkage, TE target-share
   drift, snap-share (measurement done — see below), graded injury report.

**FINDINGS THIS SESSION THAT OTHERS NEED:**
- [[gridiron-weekly-ceiling-2026-09-22]] — 98.9% withdrawn; **82.7%**, headroom
  **+0.0668 R2**, within-player share **61.5%**.
- [[gridiron-projections-denominator-is-raw]] — the in-season denominator is
  raw; `observed` is pooled; no k transports between estimators.
- [[gridiron-noisy-estimate-is-not-a-ceiling]] — the trap behind both
  retractions, with three cheap checks that catch it.
- **Snap volume IS partly forecastable** — EWMA at the repo's own alpha 0.4
  recovers **14.1%** (2022-25) and **13.7%** (2018-21) of the ceiling; R&D's
  "forecasting captures none of it" is too strong. Their ceiling reproduces
  independently. The unrecovered six-sevenths is dominated by **absence**, which
  argues for the graded injury-report unit over a better snap smoother.
  **Unit is TARGETS — no points conversion is licensed.** Copy also at
  `/mnt/project-files/snap-volume-is-partly-forecastable-2026-09-22.md`.
- The 4.749/4.773 pipeline is **`replaySeasonWeekly`** via
  `scripts/promote-volume-shrinkage.mjs`, NOT `grade-efficiency-vs-baseline.mjs`
  (which scores rates, not weekly MAE). The weekly-MAE efficiency path reads
  only `player_week_usage` + `players`; `nfl_snaps`, `nfl_injuries` and
  `nfl_depth` are never opened, so R&D's rig may already be the real pipeline
  for the five non-QB metrics.
