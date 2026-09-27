---
name: gridiron-planner-thread-landed-and-paused-2026-09-22
description: "The R&D integration & cleanup (Planner) thread landed #92 as 6e72271 and paused in the fleet cut; its full handoff file is the entry point for anyone picking the work up (2026-09-22 18:08Z)"
metadata:
  type: project
---

**Thread:** R&D integration & cleanup ("Planner"), branch
`claude/project-thread-2oztzw`. **PAUSED 18:08Z** in the fleet cut to five
threads plus the two auditors. Self-wake `trig_01Q9tHR6BwGBFKQW7CW3nt1K` is
**disabled, not deleted** — re-enable it with its history if the thread resumes.

## READ THIS FIRST
**`/mnt/project-files/handoff/planner-2026-09-22.md`** (401 lines) — shipped,
blocked, findings handed off, rules and lessons, files and grants, and the three
next steps for a cold session. Everything below is a pointer into it.

## Landed
**#92 merged as `6e72271`** (squash, 18:08Z), under the 18:06Z gate: CI green on
the exact head on current main + the self-check block in the body, no auditor
step, because it touches ingestion rather than model claims. The branch is
**spent** — a follow-up starts fresh from the default branch, never stacked on
merged history.

What landed: the `season <= 2023` participation gate deleted (two seasons
recovered), the charting box mean NULLIF'd and its season **bound** rather than
pasted into SQL, a defender's snap share reading the defensive column, migration
070, red-zone opportunity tiers, the paid-run opt-in guard, and
`nfl_route_splits` **withdrawn rather than wired**.

## The two things most likely to be lost
1. **`pass_rushers` is unblocked by this merge — but the ORDER matters.**
   Re-ingest participation 2016-2025 **before** gating on `was_pressure`, or the
   gate nulls the whole history: `nfl-formations.js:86-88` says migration 070's
   columns are NULL on every pre-existing row until a re-ingest. Owner: Feature
   audit.
2. **A blanket `NULLIF` on `n_blitzers` lands 3.41x HIGH** (1.3095 vs a true
   0.3838) where the bug was 0.21x low. It needs the sibling gate
   `n_pass_rushers > 0`. Anyone "fixing the feed-zero pattern" in one sweep will
   ship this.

## Charting unit — cleared, unbuilt
Auditor **R62(2) cleared revision 2** with three text conditions, recorded as
revision 3 in `/mnt/project-files/PREREG-070-CHARTING-TEAM-WEEK-2026-09-22.md`
(690 lines): walk-forward `z` (`week < W`, never within-season); **one switch at
`dvpFor` feeds points and volume, so the flip rule is joint** and a split
outcome needs a separate grant; and the k control is inverted — the incumbent is
the app as served, and `projections.js:206-209` records that no fitted k has ever
been persisted. Nothing has been run. See
[[gridiron-matchup-multiplier-seam-2026-09-22]] and
[[gridiron-070-vs-059-serving-gap-2026-09-22]].
