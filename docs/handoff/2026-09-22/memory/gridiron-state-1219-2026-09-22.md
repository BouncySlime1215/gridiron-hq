---
name: gridiron-state-1219-2026-09-22
description: "16:38Z Auditor R34-R36: K finding withdrawn, new fit-vs-production rule, target-share accept-don't-ship, R25 prereg needs 2 changes"
metadata:
  type: project
  modified: 2026-09-22T16:41:10.462Z
---
- **R34:** the K.yards_per finding (34→64/70) does **NOT survive** — 34 sits inside both identified sets, ypt [31,232] / ypc [13,294], and the fit was against a **pooled** prior while production serves a **per-position** one (`projections.js:562`). Clarification asked of Explorer: was argmin re-selected per resample? **Identified-set method now mandatory** on any constant. **NEW STANDING RULE:** state what production does with the quantity at the applying line before fitting against it [[gridiron-fit-against-what-production-does-rule]].
- **R35:** target-share prior evidence **ACCEPTED, DO NOT SHIP as default, stays unmerged** [[gridiron-target-share-prior-gate1-answers]]; legacy bias = accidental availability hedge, confirmed. **Now the highest-value unit:** COUPLED GRADE with the Plan 01 availability multiplier (refit on as-of status first, R19.6). −0.0499 vs −0.05 tolerance passes by 0.0001 — must always be shown with the tolerance number, not alone. Open: does production have NULL-share rows (next read).
- **R36:** Fantasy plan's R25 prereg (9a08fc3) **ACKNOWLEDGED with 2 required changes before it runs**: median centring, and multiplicative (not additive) headroom form; add clean 2021/2022 seasons because 2024 is inside control's fit (fit-1 pooled 2023-2025), which also disqualifies 2024 as the production read. Citations must be to main 1a136145.
- **16:38Z-16:39Z coordinator relays** to Fantasy plan (R36 changes), Model evidence audit (R35 coupled-grade priority), Explorer (R34 clarification + K withdrawal), Planner, Evidence Auditor (queue #86/#99/#95/#109/#113).
Prev [[gridiron-state-1218-2026-09-22]].
