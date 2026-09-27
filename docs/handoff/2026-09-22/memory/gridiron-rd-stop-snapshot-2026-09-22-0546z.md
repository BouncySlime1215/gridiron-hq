---
name: gridiron-rd-stop-snapshot-2026-09-22-0546z
description: Data & techniques R&D thread's stop snapshot at Nick's 05:46Z halt — what is verified, what is in flight, what resumes first.
metadata:
  type: project
---

Stop order relayed by the coordinator session at 2026-09-22 05:46Z, attributed
to Nick: halt all work, no more pushes or checks, push authority reverts to his
explicit word only, superseding the 2x-check delegation, resume after his 2am
reset. **Complied immediately.**

**CAVEAT RESOLVED.** The order first reached me as a cross-session message
carrying no quoted words, and I complied at once because stopping is the
restrictive direction. The coordinator then supplied Nick's verbatim message,
sent to it 05:46:15Z:

> usage is at 91%, stop all work right now. no more pushes, no more checks,
> hold every thread. pick it back up after the 2am reset. my 1:04 push rule
> still stands — nothing pushes without my explicit word.

So the halt IS his own word, and the reason is **usage at 91%**, not a fault.
His 01:04 push rule stands: nothing pushes without his explicit word. The
2x-check push delegation is superseded.

Standing principle either way, per
[[check-the-authorisation-not-just-the-plan]]: a permissive action on resume
needs his actual words attached, not a summary of them.

**Nothing of mine was pending a push.** This thread has made no commits, no
branches, no PRs and no repo edits at any point. All output is project files,
scratch and memory. So the halt cost nothing in flight.

## VERIFIED and durable (safe to build on)
- Package #10, the TE null: pressure allowed does not predict TE target share.
  [[gridiron-te-pressure-null-2026-09-22]].
- TE target share drifting 0.2115 → 0.2449 across 2022-2025. Routed to the
  `projections.js` owner; NOT actioned here.
- `throughWeek` has two opposite conventions in the repo; fantasy projection
  path audited and clean. [[gridiron-throughweek-two-conventions]].
- BDB Air Yards Efficiency Index rejected as circular.
  [[gridiron-bdb-ayei-rejected]].
- The v2 version-bump outage and its 684/32 stale-row open item.
  [[gridiron-v2-outage-version-bump]]. Queued for Nick's live-DB session.
- `/mnt/project-files` is flat and shared; generic filenames clobber.
  [[publish-under-a-package-specific-name]].

## RESUMED 07:10Z on Nick's own word (timeline, 07:07:59Z)
"stop. my back up order at 3:03 am supersedes the stop order... resume
everything under plan v2 right now". The hold ran 05:46Z to 07:10Z. Note it
authorises resuming WORK; it says nothing about pushes, so the 01:04 push rule
still stands.

## IN FLIGHT AT THE STOP — now VERIFIED, see [[zero-is-not-missing-in-participation]]
The integration thread's corrections were re-measured here on 2024 and all
reproduce exactly: two separate pass-rusher columns (286 participation / 298
FTN, differing on 29 of 45,905 rows), box zeros 9,219 against FTN's 9,475
differing on 287, and their means 2.0798 / 4.2548 / 4.3101 / 4.8726. Their
"22 on a dropback" means coverage-charted; under a pass-rusher gate it is 5.

## FIRST THING ON RESUME
1. Re-confirm plan v2 before any work, per
   [[gridiron-stop-resume-protocol-2026-09-22]].
2. Verify the two-pass-rusher-columns claim above against both files directly.
3. Four BDB winning notebooks still unread in scratch (not durable):
   bayesian-dynamic-completion-probabilities, strain, bite,
   weighted-assessment-of-defender-effectiveness. Re-pull if scratch is gone;
   Kaggle notebook source is open unauthenticated
   ([[gridiron-kaggle-open-access-2026-09-22]]).

**Still outstanding from Nick, unchanged:** accepting the Kaggle competition
rules for Big Data Bowl 2025 and 2026, the only free route to routes-run
ground truth.
