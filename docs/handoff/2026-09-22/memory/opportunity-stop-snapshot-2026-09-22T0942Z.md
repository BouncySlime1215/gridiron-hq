---
name: opportunity-stop-snapshot-2026-09-22T0942Z
description: Player opportunity thread — stopped at Nick's 09:42Z 90%-usage halt with the reach grader verified green and DELIBERATELY UNPUSHED on claude/project-thread-w45mur-inventory-contract at c3994b9.
metadata:
  type: project
---

Written at Nick's stop order, 2026-09-22 09:42:21Z ("usage hit 90%, stop
everything now... no pushes, no new spawns, no more checks... nothing merges,
deploys, or pushes without my explicit word").

**IN FLIGHT: nothing.** The 2x-verify had already finished both runs before the
halt reached me; I killed the wrapper afterwards and confirmed no `npm run
check` or `node --test` survived. Working tree clean, 0 paths.

**THE PUSH DID NOT HAPPEN, AND THAT WAS THE POINT.** Two commits sit local on
`claude/project-thread-w45mur-inventory-contract`:

- `94dfce0` test: RED — the reach-grader rules
- `c3994b9` feat: GREEN — `scripts/reach-grade.mjs`, the CONTRACT.md correction,
  `docs/tdd/reach-grader.tdd.md`

A stop hook asked for the push at ~09:0xZ and was refused then because the
verify had not finished; the 09:42Z order revokes the delegated branch-push
authority outright, so it stays refused now. **Push authority is back to Nick's
own word, every time** — [[check-the-authorisation-not-just-the-plan]].

**VERIFIED, so no re-run is owed when work resumes.** `verify2x-v4.sh c3994b9`,
both runs exit 0, **3,001 tests / 2,960 pass / 0 fail / 41 skipped** on each.
Tree `efed30afe8828bb159e71fa3b7ce5de27e2edb6d` before and after, `git status
--porcelain` 0 paths either side, `node_modules` mtime `1789885760` unchanged,
sweep 25 and 25. Log `/tmp/v4-reachgrade.out` — **container-local, so copy it
out before quoting it after a restart.**

**THE RESULT WORTH KEEPING** (it outlives the branch): across the 319 tracked
files in `server/services/` and `server/modeling/` — **237 `wired`, 51
`wired-betting-only`, 10 `hand-run-script`, 21 `unreached`.** About one file in
six that a first-path trace would have called `wired` is reachable only through
a betting route, so every `wired` total quoted so far overstates the fantasy
product. Reproduce with `node scripts/reach-grade.mjs <file>` once the branch is
pushed. Read the four numbers as an upper bound on `wired`: the grader grades a
file's reach and CONTRACT.md §1's unit is a symbol.

**TWO CORRECTIONS THIS UNIT MADE, both to my own work.**
1. CONTRACT.md's worked example named `role-scenario-engine.js` as
   betting-only. It is `wired`: it reaches `scripts/build-role-scenario-lab.mjs`,
   which `package.json` runs as `build:role-scenario-lab`, and §2's own `wired`
   test counts a `package.json` script as an entry point. The row had been
   traced to the first entry point found — the exact mistake the grade exists to
   catch. Corrected in `c3994b9` with the reason left in place.
2. `server/index.js` is an entry point (`dev:server` runs it) and imports every
   router, mounted or not, so an orphaned route would have graded `wired`
   through the boot import. `dropRouteBootEdges` removes that edge.

**ON RESUME.** Re-read this file. Nothing needs redoing: the commits are
verified on the tree they sit on. The only outstanding action is the push, and
it needs Nick's own words naming it. Worktrees left in place, not pruned:
`/home/user/verify2x-v3` and `/home/user/verify2x-v4-reachgrade`, both detached.

Related: [[gridiron-suite-figure-rule]], [[opportunity-stop-snapshot-2026-09-22T0546Z]],
[[excluding-the-defining-file-changes-the-question]].
