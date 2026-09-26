---
name: gridiron-spread-scale-refit
description: SPREAD_SCALE (1.63, lineup-posture.js) must be re-fitted after the availability fit lands; needs live rows via a VACUUM INTO copy; the value edit is the UI thread's.
metadata:
  type: project
  modified: 2026-09-19T22:45:59.935Z
---

Found 2026-09-19 22:42Z by the fantasy plan thread (O3/O4). The constant's own author wrote in the code: "If the availability model is recalibrated, re-run the script — part of this 1.63 is the noise that discount adds to the edge." The availability fit in the deploy chain IS that recalibration; nothing enforces the re-fit (no test fails when the fit moves underneath it).

**Order, after the deploy and after the availability fit lands:** take a copy of the live DB with `VACUUM INTO` (never `cp`: WAL, a plain copy loses the log); run `scripts/fit-posture-calibration.mjs` against the copy; if 1.63 moves, hand the value to the UI thread (lineup-posture.js is theirs; served through posture's `sd_model` string). Running before the availability fit lands fits the old noise.

It cannot run in a fresh clone: `weeklyWeightSetById` (server/services/weekly-weight-store.js:64) throws "weekly ensemble fit 1 is not stored in this database" from `buildDataset` (scripts/fit-posture-calibration.mjs:140). The blocker is live rows, not code.

Also from that audit (clean corpus, 20,310 team-seasons): median within-team spread 23.9 points, CV 0.201, matching posture's ESPN cross-check (SD 24.1, CV 0.20 on 62 team-seasons). The [WO O3/O6] "one shared variance model" item is not well posed: posture calibrates an error spread, the simulator a level; stratifying by league size is not supported (10-team 25.2 vs 8-team 26.4, not 20.2 vs 26.0). The O4 corpus had joke-scoring Sleeper leagues (max team-week 10,150,072.8); O4's fitted k is unaffected (per-league z-scores). Not refiltered after the gate ran, by design (tdd §7.7).

See [[gridiron-post-deploy-chain]], [[gridiron-step8-decision]].
