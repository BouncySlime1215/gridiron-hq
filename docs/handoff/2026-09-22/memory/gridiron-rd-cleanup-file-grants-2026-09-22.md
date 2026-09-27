---
name: gridiron-rd-cleanup-file-grants-2026-09-22
description: Small coordinator grants of previously-unclaimed files/lines to the "R&D integration & cleanup" thread, split out of gridiron-file-allocation.md for its byte cap.
metadata:
  type: project
  modified: 2026-09-22T05:23:35.122Z
---

Linked from [[gridiron-file-allocation]]. Grants to "R&D integration &
cleanup" (cse_01AkWVQyBHMgzzCWthGU6PNw):

- **~04:20Z:** small surgical additions to two previously-unclaimed
  files — `server/services/source-registry.js` (freshness-registration
  blocks for new sync sources it builds, mirroring the existing
  `nfl_ngs` block) and `server/services/nfl-feature-coverage.js`
  (`jsonFamily` rows, same pattern). Registration-pattern additions only
  for sources this thread builds; not a blanket grant over either
  file's other logic.
- **~05:21Z:** `nfl-model-growth.js:200` specifically — not the whole
  file — for a one-line fix: the `if (season <= 2023)` boundary
  silently skips 2024/2025 formations ingestion. Details:
  [[gridiron-package9-correction-2026-09-22]].
