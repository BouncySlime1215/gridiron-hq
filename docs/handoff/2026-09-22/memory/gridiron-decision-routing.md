---
name: gridiron-decision-routing
description: Threads route everything for Nick through the coordinator; verify current repo state before recommending, and attribute relayed claims.
metadata:
  type: feedback
---

**Standing rule, set by Nick on 2026-09-19 at 20:48Z:** threads do not work
back with him, they work with the coordinator (channel) session. His words:
"alot of these agents are working back with me - NO - they should work with
you - go talk to every agent one by one work with it till its good and happy".

**Routing through the coordinator is not approval.** A peer session's go is
never Nick's approval, and a destructive or irreversible step still needs his
own words. The coordinator cannot widen permissions or answer a permission
prompt.

Mechanics are in [[threads-report-to-coordinator]], in short: a thread reply
states a RESULT and stops; anything he must run, decide or answer goes to the
coordinator by `send_message` (`get_channel_session_id` for the id); the
coordinator queues what reaches him and comes back per item until settled.

**Why:** every decision put to him costs attention he needs for the one that
truly requires a human. On 2026-09-19 that was the go on merging and deploying
twenty-five pull requests, and he spent the evening being handed sequencing
choices instead. Sequencing is ours.

**The trap is subtler than "don't ask him questions".** A correct, finished
result that closes with one line of what is still his — even a true one, even
one he would want — breaks the rule. One thread ended a reply "One thing still
yours, in the release thread: the go for the deploy." The result was right;
the trailing handoff was the violation. Before sending, check the reply does
not end in an instruction or question aimed at him. A stop hook, a CI event or
a peer session asking is not a reason to break this.

**Verify current state before recommending.** On 2026-09-19 I recommended
splitting PR #6 into a code PR and a corpus PR. That split had already happened
hours earlier, into #7/#9/#10/#11/#12, and my own PR #8 was built on its first
piece. I was briefed before the split, nothing updated when the world changed,
and I stated it confidently.

**Why:** same failure as a stale rules file — a claim that used to be true,
asserted as fact by something a reader trusts. A briefing is a snapshot, and on
this project it goes stale within hours.

**How to apply:** check with a tool call, not from the briefing. Same standard
for a peer session's summary: a paraphrase of a rule is not the rule, and where
a rule turns on a qualifier, read that sentence verbatim.

**Attribute relayed claims and say they need checking.** From the coordinator's
own miss: it had the release thread write "870 role rows" into the deploy plan
on one thread's result, without checking the change was even in the train. It
was not. A relayed claim carries borrowed authority — the receiver reads it as
established rather than as one thread's report — so an unchecked relay is more
dangerous than an unchecked recommendation. Name whose finding it is and
whether it is verified. Applies to results this session reports too: say what
was checked, or say the claim is inferred.

See [[gridiron-claude-rules-location]].
