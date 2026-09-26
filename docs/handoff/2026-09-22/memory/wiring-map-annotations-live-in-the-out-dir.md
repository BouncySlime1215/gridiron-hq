---
name: wiring-map-annotations-live-in-the-out-dir
description: gridiron-hq's wiring map loads its accept-list from the --out directory, so a scratch run applies no annotations and its finding total is not comparable to docs/wiring — it reads as nondeterminism.
metadata:
  type: project
---

**The trap.** `scripts/wiring-map.mjs` reads its accept-list with
`annotations(path.join(outDir, 'annotations.json'))`. The accept-list lives at
`docs/wiring/annotations.json`, so:

- `node scripts/wiring-map.mjs` (default out) applies annotations.
- `node scripts/wiring-map.mjs --out /tmp/anywhere` applies **none**.

A scratch run therefore reports MORE findings than the committed artifact, and
the difference is whatever is currently accepted.

**What it looks like when you get it wrong.** Comparing a `--out` baseline with
`docs/wiring/wiring-map.json` on 2026-09-22 showed `espn_settings` appearing and
disappearing as `table-never-written` between two runs on an identical tree —
indistinguishable from a nondeterministic checker. It is accepted in
`annotations.json` and never moved. Five consecutive runs gave the same total.

**How to apply.** Compare annotated with annotated, or unannotated with
unannotated, and say which in any figure you quote. To baseline an older commit
without disturbing `docs/wiring`, run it with `--out` AND run the new tree with
`--out` too. Measured that way on 2026-09-22: 2366 → 2389 unannotated,
2365 → 2388 annotated, +23 both ways.

**Related.** [[gridiron-suite-figure-rule]] is the same discipline for test
numbers: a figure nobody can reproduce is not a reading. See also
[[gridiron-failure-modes]].
