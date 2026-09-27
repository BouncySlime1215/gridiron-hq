---
name: gridiron-stop-resume-protocol-2026-09-22
description: The stop/resume safety protocol Nick set 01:26Z 2026-09-22 — small units, branch-only edits, snapshot on every stop, resume re-confirms plan v2. Linked from MEMORY.md "STOP/RESUME SAFETY".
metadata:
  type: project
  modified: 2026-09-22T04:12:46.180Z
---

Nick, 2026-09-22 01:26Z, cmsg_01YAsw8AnFv4ioRMQw8dfPmTBqgHcvtRg3MpKxYaSVKdQz; confirmed by the coordinator.

**Working unit**: small slices, each ending in a local commit + a report + a state-record update. Branches only — main stays untouched by any thread directly.

**On any stop**: every thread produces a snapshot (in flight / verified / next) within minutes of the stop order — the actual state at that moment, not a summary written later from memory.

**On resume**: the coordinator re-reads the latest snapshot first, re-confirms plan v2 is still the governing plan, and continues from there. It never restarts a thread from scratch, and never treats a stop as a chance to reorder or skip Phase 0 items.

Live per-thread record (rewritten each cycle): [[gridiron-state-record-2026-09-22]]. Frozen snapshot taken at the 01:01Z stop (kept as history, never rewritten): [[gridiron-stop-ledger-2026-09-22]].
