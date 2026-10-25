---
name: a-report-is-not-a-shipped-fix
description: A handoff said a replacement field was already pushed; it existed on 0 of 155 branches — verify a claimed field or commit exists before building on it, using a control string in the same scan.
metadata:
  type: feedback
  modified: 2026-09-22T05:28:46.732Z
---

When a handoff says another thread has **already shipped** the thing you need — a field,
a helper, a migration, a commit — check the remote before you build on it. Threads report
work up, coordinators route it, and a *report* can arrive at you as a *fix*.

**Why.** 2026-09-22 ~05:12Z this thread was told the cleanup thread "already shipped
(pushed, `claude/project-thread-2oztzw`) an additive `off_fourth_down_go_rate` field
alongside the untouched original", and to swap `football-context.js:195` onto it. It did
not exist — on that branch or on any of the **155** remote branches. The source was Model
evidence audit's `docs/evidence/2026-09-22/fourth-down-rate-unit-mismatch.md`, which says
in its own second paragraph: *"None of these files is mine to edit (one editor per server
file). This is a report, not a change."* A correct diagnosis had been read as a landed fix
somewhere between the author and me.

**How to apply.**

1. **Scan with a control.** A grep that finds nothing proves nothing until you show the
   same scan finding something known:
   ```
   for b in $(git branch -r | grep -v HEAD); do git grep -l "<wanted>" "$b"; done
   ```
   Run it again with a string you are certain exists (here `off_fourth_down_rate`, which
   hit all 155). Without the control you cannot tell absence from a broken scan, and
   "it's not there" is a claim you will be asked to defend.
2. **Say it plainly and name the likely origin.** The useful report is not "that field
   doesn't exist" but "it doesn't exist, here is the scan, and here is the document I
   think was mistaken for it" — that stops the same handoff being reissued.
3. **Never reference the absent field "so it's ready".** Reading an unpublished column
   returns null and silently drops the feature, which is this project's signature bug
   shape, not a fix. Mark the swap point in a comment and leave the code honest. See
   [[gridiron-failure-modes]].
4. **Do the half you own.** The diagnosis usually survives even when the claimed fix
   doesn't: here the label was still wrong, and relabelling was entirely inside this
   thread's own file, so the false sentence stopped reaching Nick that night while the
   real field stayed someone else's work.

The same shape as [[check-the-authorisation-not-just-the-plan]]: verify what a relayed
claim is actually resting on, not just whether it sounds right.
