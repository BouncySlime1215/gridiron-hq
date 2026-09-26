---
name: gridiron-state-1246-2026-09-22
description: "17:04Z-17:08Z eleventh batch: #113 MERGED bf359c68; Auditor R46 — control NOT promoted, information component fails, 62% of the gap is level → new Fantasy plan unit to price a level correction on the incumbent, sign convention rule; #106 green but held per R35; Wiring map's ci.yml correction (calls scripts directly, no duplication) with its follow-up branch; Fantasy plan acks the named-marker ruling"
metadata:
  type: project
  modified: 2026-09-22T17:08:00.000Z
---
- **#113 MERGED bf359c687e19659ce2f0cfc07eaefb64fb4b64ef** (Chat sync). Nick told. Chat sync's unit closed; asked to pick its next Phase A unit.
- **Auditor R46 17:04Z — R25/R36 verdict:** **control NOT promoted; the information component FAILS** (2022 significant reversal for shipped; house standard `shrinkage-fit.js:44-45`). **62% of the 0.0728 gap is LEVEL** (a calibration constant) → **NEW UNIT for Fantasy plan: price a level correction on the incumbent** (`weekly-ensemble.js:69-77` bias −0.26/−0.17/−0.31/−0.58/−0.32), queued **after** the R40 flag and the production() unit. The 2022 anchor re-check gates the record only; the pooled figure need not reproduce exactly. **SIGN CONVENTION RULE:** state predicted−actual vs actual−predicted before any signed-error number leaves a run. Rider: reviving control requires configuration B first.
- **#106** CI green on 1a70355 (run 35757515894); stays unmerged per R35 until the R40 flag shape lands.
- **Wiring map CORRECTION:** `ci.yml` does NOT call `npm run check`; it calls each script directly, and `ci.yml:70` is check:wiring's only CI invocation. Adding check:wiring to `check` costs 15s locally and zero on CI; **nothing for Scheduler to remove** (coordinator's earlier 'state the duplication' withdrawn). Recorded in [[gridiron-check-script-omits-wiring-gate]]. Follow-up branch from eb19f475: RED 17a6051 / GREEN e33c6cb, evidence `docs/tdd/check-script-covers-ci.tdd.md` (the test reads ci.yml `run:` lines and expands `check` transitively).
- **Fantasy plan** acks the R45 named-marker ruling for production().
Prev [[gridiron-state-1245-2026-09-22]]. Next [[gridiron-state-1247-2026-09-22]].
