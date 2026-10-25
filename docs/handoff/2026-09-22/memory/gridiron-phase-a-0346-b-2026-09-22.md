---
name: gridiron-phase-a-0346-b-2026-09-22
description: Coach item3 self-corrected design (contingency.js 3-state) + Wiring map's own detection-tooling blind spot, as of the 03:46Z check-in.
metadata:
  type: project
  modified: 2026-09-22T03:49:11.204Z
---

Linked from [[gridiron-state-record-2026-09-22]]. Item text/citation for
item3: [[gridiron-phase-a-start-2026-09-22]].

**Coach — Phase A item3, 03:46Z: SELF-CORRECTED a design mistake.** Cited a
nonexistent file/vocabulary (availability-basis.js, a 4-state enum) from
memory, without verifying. Corrected from the actual source, contingency.js,
to a 3-state design: measured / pooled / none, where 'none' means
score:null, nothing served. Now building the injury_status slice against
the corrected design.

**Coach — separate SECURITY INCIDENT, unchanged since 03:36Z, still
unconfirmed:** see [[coach-env-dump-key-exposure-2026-09-22]] — accidentally
printed live values of GRIDIRON_FLY_TOKEN and GRIDIRON_ANTHROPIC_API_KEY via
an env dump while chasing an unset GRIDIRON_DB_PATH (03:35Z); coordinator
escalated to Nick asking for rotation of both; unconfirmed as of this
writing.

**Wiring map, 03:46Z: found a structural blind spot in its own detection
tooling.** scripts/wiring-map.mjs only tracks tables that appear in CREATE
statements, so a table read but created NOWHERE is invisible — not even
"unclassified," worse than the 7 referenced_but_never_created rows item5
already caught. Approved to build a proper "read-but-never-created" rule
(RED/GREEN, filtering out CTEs/views/builtins/comment-prose false
positives) as its next unit, ~30 min. Housekeeping commit 8717a04
(regenerated stale artifacts, 0 status moves).
