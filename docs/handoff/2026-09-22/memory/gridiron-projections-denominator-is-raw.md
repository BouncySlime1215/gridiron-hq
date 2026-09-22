---
name: gridiron-projections-denominator-is-raw
description: projections.js feeds shrink() a RAW in-season opportunity count plus decayed prior seasons — two threads inferred the opposite in opposite directions off one word, 2026-09-22.
metadata:
  type: project
---

**Settled 2026-09-22, read off the file, after two threads got it wrong in
opposite directions within ten minutes.** Anyone reasoning about
`K.yards_per / catch_rate / td_rate` must start here.

**What the code does:**
- `RECENCY = { seasonDecay: 0.35, weekHalfLife: null }` — `projections.js:162`.
- `rowWeight` (`:176-180`) returns the **season weight alone** when
  `weekHalfLife` is null, which it is. There is **no within-season decay**.
- `seasonWeight` (`:169-173`) is `0.35^(through − s)`, so a cutoff-season row is
  `0.35^0 = 1.0`.

**So the in-season denominator is RAW**, exactly as the `:97-99` comments say,
and prior seasons are **added on top** at 0.35 / 0.1225 / 0.042875. Season decay
only ever *adds* evidence. **The shipped `n` is ≥ a raw single-season count,
never smaller**, with equality only for a player with no prior season in the log.

Why `weekHalfLife` is off is documented at `:155-161`: every within-season decay
tried made things worse, and a trailing three-week average loses to
season-to-date, 4.753 vs 4.509. Do not re-propose it.

**The bigger half, and the one that actually blocks bench work.** `observed` is
pooled over the same seasons under the same weights — `:563` is
`a.recYds / a.targets`, `:565` is `a.receptions / a.targets`, and every one of
those is a multi-season season-weighted sum. So the shipped rate is a **pooled
multi-season** rate. Any replication using a **season-to-date** rate is a
**different estimator in `observed` as well as in `n`**, and **no `k` and no
ratio transports between them in either direction.**

**Refuse this step, from anyone:** *"shipped k behaves like k/ρ, so catch_rate 26
at ρ = 2 acts like 13 against an optimum of 104, so the under-shrink is twice as
bad."* It corrects `n` and leaves `observed` uncorrected, and the two moved
together. A larger `n` is *correct* when `observed` rests on more data — that is
what `n` means. The shipped estimator is internally coherent.

**Consequence:** the populated-database grader
(`scripts/grade-efficiency-vs-baseline.mjs`, run 2026-09-20) is not the best test
of these constants, it is the **only** one. See
[[gridiron-efficiency-constants-swept]], the corrections write-up
`docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md` §5-§6,
and [[gridiron-k-yards-per-too-small]].

The `:97-99` comments are **incomplete, not false** — they omit the prior-season
term and the pooled `observed`. Comment fix belongs to **Fantasy plan**
([[gridiron-file-allocation]]); patch and the fifteen `pickK` call sites are in
§9 of the corrections document. Related: `pickK` at `:203` takes `rawN` and
`hardcodedN` separately and all fifteen call sites pass the identical value.
