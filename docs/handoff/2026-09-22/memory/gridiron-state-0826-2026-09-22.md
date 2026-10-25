---
name: gridiron-state-0826-2026-09-22
description: "Coordinator state 08:26Z 2026-09-22: Auditor unit 7 verdict (k=34 stays), effW defect → Fantasy plan, ci.yml disabled so #95 has no CI, swallow-scan ninth site"
metadata:
  type: project
  modified: 2026-09-22T08:22:20.316Z
---

Continues [[gridiron-state-0822-2026-09-22]].

- **Auditor unit 7 (k=34) verdict:** 50-70 does NOT replace 34; #11 withdrawal accepted. Blocker: proxy has zero calibration points vs repo weekly MAE and disagrees in sign at the large-k region. Record /mnt/project-files/audit-unit-7-yards-per-k-final-gate-2026-09-22.md. Unblocks: fix effW + re-run fitter; one real-metric calibration point; direct 50-vs-70 contrast family-adjusted. Gate-1 set for synthetic player_week_usage (third proxy, label in same sentence, validation section, both directions).
- **effW defect (shrinkage-fit.js:323, efficiencyWeightFor dead; efficiencyObservations hardcodes weight: opp) → Fantasy plan**, ahead of its Unit 2. Fix is PRODUCT effW*opp, RED test on spec weights, re-run fitter, no constant moves without Auditor ruling. Reach: fitAllK → promote-weekly-ensemble.mjs:53, fit-shrinkage-weekly.mjs:25, fit-shrinkage.mjs:25.
- **ci.yml workflow is disabled_manually** (id 357164314; 351 runs, none since 2026-09-20; #95 has 0 check runs). No PR tonight gets CI; local guarded run is the whole gate. 08:26Z told Nick: option 1 merge #95 on local figure (3ef535b, 3009/0 fail) recommended; option 2 `gh workflow enable ci.yml` is his settings change. Merge still his word.
- **Swallow-scan: ninth site** counterparty-pricing.js:922 (interpolated table, cache fingerprint returns stable 'absent') → Trade Brain. Gate for swallow-scan.mjs: nesting-aware lookback test case, no fixed cap (max span 122). Record /mnt/project-files/audit-gate-trade-brain-swallow-scan-2026-09-22.md. Concatenated reads remain an uncovered blind spot.
