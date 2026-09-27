---
name: gridiron-memory-md-single-writer
description: MEMORY.md is single-writer as of 2026-09-22 13:27Z — the auditor sends the coordinator exact replacement text for its line instead of writing the file, because read-then-write raced a concurrent pointer update twice.
metadata:
  type: feedback
---
**MEMORY.md IS SINGLE-WRITER AS OF 2026-09-22 13:27Z. The auditor does not write
it directly.** Send the coordinator the exact replacement text for the auditor
line and it applies it through the one memory writer. Reason: read-then-write
from this session raced a concurrent pointer update TWICE (12:17Z pushed the file
over its 12,000 B limit; a 12:37:32Z write from a copy predating the 12:36Z
pointer update reverted line 39). Re-reading immediately before writing does NOT
fix this — the window is the write itself, so the only fix is one writer. The
auditor's OWN files stay the auditor's: gridiron-audit-unit-1-verdict,
gridiron-live-read-2026-09-22, gridiron-no-promoted-fit-has-ever-run,
gridiron-monte-carlo-band-is-common-mode, gridiron-promotion-preflight-read.

**Why:** two sessions doing read-then-write on one file lose whichever write
lands second; the loser's copy silently reverts the winner's edit, and nobody
sees it until a third party diffs the file.

**How to apply:** for any MEMORY.md change, send the coordinator the exact
replacement text for the line you own and let it apply the edit. Re-reading
immediately before writing is NOT a fix — the race window is the write itself.
Files owned by exactly one session stay writable by that session.
