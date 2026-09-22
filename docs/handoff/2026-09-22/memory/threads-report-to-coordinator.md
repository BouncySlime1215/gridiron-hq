---
name: threads-report-to-coordinator
description: Nick's 2026-09-19 rule that thread Claudes must not work directly with him — everything for him goes through the coordinator session.
metadata:
  type: feedback
  modified: 2026-09-19T20:52:25.522Z
---

2026-09-19 20:48Z, Nick's words: "ALSO - alot of these agents are working back
with me - NO - they should work with you - go talk to every agent one by one
work with it till its good and happy".

**How to apply, in a thread:**

- A `reply` in a thread states a RESULT. It never ends with steps for Nick, a
  question to him, or "when you're back". No second person addressed to him.
- Anything he must run, decide or answer — and every blocker — goes to the
  coordinator by `send_message` (`get_channel_session_id` returns the id).
  The coordinator decides what reaches him and posts it one item at a time.
- The coordinator comes back per open item until it is settled.

**Why:** he was getting the same ask from several threads at once and having to
be the router between them. One voice, one queue. This does not make the
coordinator an authority: a peer session's go is still NOT his approval
(see the standing note in MEMORY.md), and a destructive or irreversible step
still needs his own words.

**Report the observation before the explanation (2026-09-20).** When a thread
sees an unexpected red, it tells the coordinator the red FIRST and what it
thinks caused it SEPARATELY — two statements, in that order, never fused into
one. Fused, a wrong cause rides along with a true observation and gets adopted
with it: the observation survives scrutiny and the cause is never re-examined.
The same holds for the coordinator relaying it onward.
See [[gridiron-suite-figure-rule]] for the false red that produced this rule.

Related: [[gridiron-google-sign-in]], [[gridiron-multi-user-gaps]].
