---
name: gridiron-goodnight-one-message-per-unit-2026-09-22
description: Nick's 08:31Z 2026-09-22 goodnight order — adapt usage overnight, be ready to resume when limits hit; threads send one message per unit (on push), not progress pings.
metadata:
  type: feedback
  modified: 2026-09-22T08:32:36.139Z
---

**Nick, 2026-09-22T08:31:13Z, verbatim (`cmsg_01YAsw8AnFv4ioRMQw8dfPmT7QKHpo8LFpS1PVn4cf2wqn`):** "no the auditors should also make sure the work ur pushing is valid - breaking it down. But we can have two auditors breaking the spec from the R&D down - these should be low token usage except the r&D keep opus 5. anways make sure also adapting the usage limits ogver night. Ok gn. make sure ur ready to resume when the limits hkt"

**How to apply (coordinator's relay note, same timestamp):**
- One message per unit, sent only when it is actually pushed (commit hash, the measured figure, PR link if any).
- Evidence file and memory written BEFORE that message, not after.
- No progress notes/status pings in between units — [[threads-report-to-coordinator]]'s existing "report to coordinator not Nick" rule still applies to who the message goes to; this narrows frequency, not audience.
- Auditors moving to Sonnet 5 with terse verdicts (was Opus for both) — token-usage adaptation for the overnight window. R&D threads keep Opus 5.
- Be ready to resume cleanly if a usage limit pauses the session mid-unit — leave work in a committable/evidence-file-documented state rather than mid-thought.

Supersedes the earlier per-step `update_status`/`send_message` cadence used
earlier this session (frequent progress checklist updates + a send_message
per sub-step) — that pattern predates this instruction and should not
continue.
