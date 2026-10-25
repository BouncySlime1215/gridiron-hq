---
name: gridiron-scheduler-stack-state
description: State of the scheduler PR stack (#56/#59/#61/#63 plus #49/#52) on 2026-09-20, and the local-check rule that replaces CI while Actions minutes are spent.
metadata:
  type: project
  modified: 2026-09-22T16:28:22.465Z
---

**`64f3ef2` is PUSHED** (01:55Z, after `npm run check` passed whole: typecheck,
lint, 2980 tests / 0 fail / 41 skipped, build, start:smoke). No longer at risk.

**CI IS OFF UNTIL OCTOBER 1** — Actions minutes spent, workflow 357164314
`disabled_manually`. Never re-enable, re-run or dispatch. Every push preceded
by `npm run check` in full with the numbers stated; red or missing checks are
not a PR's content. [[gridiron-actions-limit-2026-09-20]]

That commit carried the early-arm watchdog guard, fourteen more defect
injections in `docs/tdd/boot-restart-cycle.tdd.md` (33 rules, 31 with an
injection run and failed), and four `PR #62` references corrected to **#63**.
Suite at that commit: **2980 / 0 fail, 41 skipped**.

Per-branch heads and what each one is: [[gridiron-o3wt2p-branch-ledger]] --
which also records that `-mainthread-holds` is PR #77's OWN head and must never
be deleted as empty.

## The stack itself
`#56 -> #59 -> #61 -> #63`, all drafts, **all four bases already `main`**
(retargeted, never rebased, so each branch still contains the ones below it).
One linear chain that fast-forwards onto origin/main 791b131:
`63ca21e -> b5b74b5 -> 7534ff1 -> a986f37 -> 01b7a2f` (+ 64f3ef2 unpushed).
**Nothing for Nick to change by hand** — an earlier morning block said there
was a per-PR base change; there is not.

Also mine and independent, all five carrying their `docs/tdd` evidence
file and re-checked in full: **#39** `7f36f8a`, **#45** `c9ff607`, **#49**
`3aed429`, **#50** `d01df31`, **#52** `dad6e1a`. #49 and #52 both edit
`fly.toml` and were re-probed after those commits: clean in either merge order,
result carries both values. Details: [[gridiron-tdd-evidence-sweep-o3wt2p]].

What each PR is: [[gridiron-boot-restart-loop-fixes]] and
[[gridiron-watchdog-arming-pr56]]. Census: [[gridiron-scheduler-job-census]].

## Merge check re-run 2026-09-20 04:05Z

Full detail (chain through #77/hold-head 8709ec6, server/index.js untouched-past-#56 note, #50 espn-market union-resolution) moved verbatim to [[gridiron-scheduler-stack-state-part2]] to stay under cap.

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; 15:45Z Nick: 'UNLIMITED ACTIONS'.
