---
name: gridiron-release-train-2026-09-19
description: The proven merge order for the 2026-09-19 pull request pile, what the end-to-end merge found that no single PR could show, and the rule for what may join a proved train.
metadata:
  type: project
---

Full plan, kept current: `docs/RELEASE-TRAIN-2026-09-19.md`, branch
`claude/release-train-2yv3x6`, PR **#35** (draft). Read it before re-deriving
any of this. **Nothing was merged or deployed**; every proof was built on a
scratch branch from `main` and thrown away.

## The order (26 PRs)

Base stack, strictly linear, each the next one's base: **#7 → #9 → #10 → #11 →
#12**. Merging #12 lands all five; everything else depends on #12. Then **#8,
#24**, the scheduler chain **#17 → #19 → #20 → #28 → #29 → #31 → #32 → #33**
(linear), **#21 → #27 → #30** (linear), then **#25, #26, #23, #22, #18, #37,
#15, #14**.

Only three constraints are real: #17 before #14, #25 before #22, and #26 before
the chat sync (a post-deploy step). **#37 before #15** because it decides what
deploy step 10 writes. Everything else is forced by git stacking or free.

## Proved four times, because the branches kept moving

A proof describes exact SHAs; a moved branch needs a re-run. Final state:
**22 merges, zero conflicts, zero hand-applied fixes, 2,950 tests, 2,909
passed, 0 failed, 41 skipped**, with `npm ci`, typecheck, lint, build and
start:smoke all exit 0.

The first run found two breaks that no individual PR could show, both PRs in
each pair green alone. Both are now fixed in their own source branches:

1. **#17 and #14 each invented `GET /api/health`.** Git merged them cleanly into
   a file registering it twice; #14's unconditional 200 would have given Fly a
   liveness check that passes on a wedged database. #14 deleted its route and
   took #17's extracted `healthHandler()` (`d7c9beb`).
2. **#14's `assertLeagueMember` 403'd #26's route in seven tests**, in either
   merge order — a fixture problem. #26 fixed it (`f12bedd`).

The single-registration tripwire went to the **top of the scheduler stack**, not
into #14: a test written by the change that deletes the route can never fail,
where one standing in the tree before the collision arrives is red until the
route is gone. That reasoning beat this thread's.

## The rule for joining a proved train

**A pull request joins only if it changes what the deploy does.** #37 (gate v2)
qualified: without it `fit-availability.mjs` runs v1 on the machine and Nick's
approved decision has no effect. **#34's O2 half and #36 (wiring map) did not** —
inert or tooling, and each would force a full re-prove for no user-visible gain.

## Excluded

- **#6** — the 375-commit betting PR the base stack was split out of.
- **#34** — real fantasy work on #6's branch. Its gate half was cherry-picked out
  as **#37**; the O2 half waits for the next train, with its consumer.
- **#36** — the wiring map, tooling that arrived after the sequence was proved.

## Claims checked and corrected (several were this thread's own)

- **The fit does not reach the projection engine.** `player-week-engine.js:190`
  sits behind `redistributeVolume`, which defaults false and which nothing under
  `server/` passes. Six modules import `weeklyAvailability`; five of those reads
  serve a request, one never does.
- **Nothing in the train backfills QBR**, so nothing flips the #15 gate on deploy.
- **#25-before-#22 is per click, not per page load**: `ProposalSlate.tsx` uses
  `api()` not `useApi()` deliberately.
- **Migrations: 63 files, one duplicated number (062), zero duplicated keys.**
  `migrate.js` keys on `mod.name ?? filename`. Two files sharing a *number* is
  cosmetic; two sharing a *name* is silent data loss with no error anywhere.
  That is the check nobody was running. Shipping as is; a timestamp prefix and a
  CI duplicate check are queued as a follow-up.

See [[gridiron-release-train-deploy-facts]],
[[gridiron-scheduler-outage-2026-09-19]], [[gridiron-fantasy-audit-findings]].
