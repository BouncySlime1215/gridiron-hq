---
name: reading-a-claim-without-its-attachment
description: Four 2026-09-20 errors where a claim was read but not the thing it was attached to — the line, the import, the timestamp, the merge base.
metadata:
  type: feedback
---

Sibling of [[verify-the-consumer-not-the-producer]]. That one is about
stopping one step short of the consumer. This one is about reading the
*claim* and not the *attachment* it rides on. Four instances, 2026-09-20,
Gridiron HQ.

1. **The Decision Inbox premise stated from memory.** The claim that the
   inbox had two publishers and no reader was repeated without re-reading the
   mount. It happened to be true; it was not true *because anyone checked it
   that turn*.
2. **"`waiverUpgrades`' only call is at :191 so it falls with the route."**
   The call site was read. The `import` at `routes/trades.js:35` was not. A
   symbol outlives the call that names it as long as an import binds it, so
   the deletion was wrong and the branch stayed held until #41 carried
   ef3164e onto main.
3. **"Ok go" read as lifting the GitHub freeze.** The post it supposedly
   answered is timestamped **29 seconds after it**. The words were read; the
   timestamp attached to them was not. See
   [[gridiron-authorisation-rule]] and [[verify-the-go-before-acting]].
4. **Mine: a merge-base mechanism invented to support a correct instinct.**
   I wrote that fast-forwarding `trade-week` "silently changes what #60 and
   #69 show as their diff, and emails their author." False. `git merge-base`
   is `aca74f9` for #69 (fd3d6cc), #60 (24ad65b) and #64 (7eb5118) both
   before and after the move; none of those heads contains eb55f1d. A PR's
   three-dot diff is computed from the merge base, and moving a base branch
   to a commit the head does not contain leaves the merge base where it was.

**Why:** in each case the visible artefact — a sentence, a call, a message,
an instinct — was read carefully, and the thing it hangs from was assumed.
The care spent on the visible half is exactly what makes the assumed half
persuasive.

**How to apply:**
- Deleting a symbol: read every `import` of it, not only every call. The
  import is the attachment.
- A message that authorises something: read the timestamp and the message it
  answers before acting. Ordering is part of the content.
- Restating a premise from an earlier turn: re-read it, or say it is being
  restated from memory. Those are different claims.
- Before moving any branch another thread stands on, run `git merge-base`
  on each affected head before and after, and quote both.

**Amendment, and the important half of this entry.** On (4) the *instinct*
was right and needed no justification: do not move ground another thread is
standing on without asking. The error was manufacturing a mechanism to
support it. Asking was already correct on its own. The lesson someone takes
away from this must not be "ask less" — it is "ask, and do not decorate the
ask with a mechanism you have not measured."
