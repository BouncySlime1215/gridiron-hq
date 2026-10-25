---
name: gridiron-bootstrap-clustering-trap
description: pairedBootstrapDiff in Gridiron HQ silently drops to an UNCLUSTERED resample when the groups array length does not exactly equal n, which manufactures significant-looking wins — check groups.length before believing any interval.
metadata:
  type: reference
---

Found 2026-09-20 while grading the efficiency constants, on `origin/main` at
791b131.

`pairedBootstrapDiff(valuesA, valuesB, { groups })`
(`server/services/backtest-significance.js:57-87`) clusters **only** when
`groups.length === n` exactly, where `n = Math.min(valuesA.length,
valuesB.length)`. Otherwise it falls through to the plain resample. The strict
equality is **deliberate** and the comment above it (`:62-79`) explains why a
`>=` guard cannot tell "same units" from "both long enough" — so this is not a
bug to fix, it is a silent mode to check for.

**The consequence:** an unclustered interval on repeated-measures data is too
narrow, so it reports wins that are not there. In the efficiency sweep a
`groups` array that was filled once globally instead of once per metric family
left it empty for four of six metrics and produced a "BEATS SHIPPED" on
`rec_td_rate` that vanished the moment clustering was restored.

**Rule: before quoting any interval from this function, assert
`groups.length === errors.length`.** The function will not tell you.

**And the guard is only half the class.** It protects `groups` sized to the
LONGER array. Sized to the SHORTER one it passes, the clustered path runs, and
the resample pairs strictly by index (`:95`) — so two arms covering different
rows are compared row-for-row and a clean interval is reported on nothing.
Live on main at 791b131 in `offseason-model.js:1149` and its v2 twin
(`:1465-1471`): an arm is pooled only when `fitGbm` succeeds, behind a bare
`catch`, so a throw on a subset of seasons silently shortens it. `gbm = true`
is the default at `:1050` and `:1434`. Reported 2026-09-20 for allocation.

Unrelated shell trap from the same run: `until ! pgrep -f "<script name>"; do
sleep 5; done` never exits — the waiting shell's own command line contains the
script name, so `pgrep` matches the waiter itself. Poll for a sentinel file the
job writes on exit instead.

See [[gridiron-failure-modes]] · [[gridiron-efficiency-constants-swept]].
