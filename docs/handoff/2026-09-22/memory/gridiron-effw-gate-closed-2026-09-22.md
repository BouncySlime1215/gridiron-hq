---
name: gridiron-effw-gate-closed-2026-09-22
description: The effW reproduction gate (PR #106, Auditor unit 17b / Plan 07 §2.3) is CLOSED as of 11:5xZ 2026-09-22 — in-file fitAllK reproduces package #22's mirror within 1.1% on all 5 k values and both MAE-delta CIs.
metadata:
  type: project
  modified: 2026-09-22T11:55:47.959Z
---

**CLOSED.** Rebuilt the Explorer's offline rig from fresh nflverse CSVs
(original CSV dir was gone — a different, now-ended session's scratchpad)
and ran the real in-file `fitAllK`/`buildFitSpecs` (not `effw-test.mjs`'s
mirror) against it. All 5 headline k values (fit ≤2023, scored on 2024)
match package #22 within 0.02-1.1%: ypt WR 35.42 vs 35.5, RB 32.66 vs 32.4,
TE 40.95 vs 40.7, ypc RB 39.54 vs 39.1, ypa QB 66.69 vs 66.7. Both MAE-delta
CIs match: 2024 +0.0000 [-0.0039,0.0039] indistinguishable (spec +0.0010),
2023 +0.0160 [0.0076,0.0238] worse (spec +0.0150). **The mirror in
`effw-test.mjs` was faithful** — Auditor unit 17b's open question is
answered yes, closing [[gridiron-effw-fix-worth-correctness-only-2026-09-22]].

**Harm-removed wording, binding (Plan 07 §2.2): 98.0% (2024) / 63.4% (2023)
— never "~90%", never "harmless".** The 2023 residual is still significant.

**Two Evidence Auditor findings on PR #106 also fixed** (per
`audit-pr106-effw-gate-2026-09-22.md`): the doc's suite figure had been
measured on `origin/effk` (`da5738e`), not this branch — corrected to the
real figure on the tree actually pushed, guard-verified twice (worktree,
two independent runs): **2,989 tests / 2,948 pass / 0 fail / 41 skipped**,
stable both runs. And the "activeKVector() returns null, confirmed by a
live read below" claim had no read behind it — added one: read-only query
on this container's shared `server/data.sqlite` shows `shrinkage_fits` has
exactly 1 row (the Unit-1 volume CRPS-gate run, not an efficiency fit),
`active = 0`. That row's own `note` field says "activated" while the
`active` column is 0 — a live instance of the `fit-shrinkage-weekly.mjs`
note-text bug fixed earlier this session.

Also added Plan 07's RED tests 3 (`activeKVector()` stays null across a
`fitAllK()` call — the structural "no activation side effect" guarantee)
and 4 (a volume-side k, e.g. `target_share`, is pinned unchanged by the
effW fix — mutation-verified: swapping `roleW` for `effW` at that call site
fails it). Test file now has 3 tests, all green.

**Branch state:** `shrinkage-efficiency-weighting` (PR #106), 5 commits off
`main` `654ff93`. `c8939a8`/`f9dcc0a` were pushed before the pause order;
`a14cdf3`/`609fa42`/`1ee94ca` (RED4, RED3, doc rewrite closing the gate) are
**local-only, held per Nick's 11:17Z no-push order** — ready to push the
moment authority is restored. Evidence file:
`docs/tdd/shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md`.

Related: [[gridiron-atomic-verify-guard]] (v4 script used for both guard
runs), [[gridiron-n-is-not-raw-opportunities-2026-09-22]].
