---
name: skill-offense-pct-zeros-are-real
description: The nfl_snaps offense_pct feed-zero contamination is defenders only; on skill rows a zero is a real measurement, so NULLIF there is an overcorrection.
metadata:
  type: project
---

The "11,027 contaminated zeros" figure in `nfl_snaps.offense_pct` is a
**whole-roster** number and is **defenders**. Filter to QB/RB/WR/TE and the
contamination is gone:

| | 2024 REG | 2023 REG |
|---|---:|---:|
| skill rows in `snap_counts` | 6,868 | 6,852 |
| literal `offense_pct = 0` | 400 | 366 |
| ...that recorded a target/carry/attempt | **0** | **2** |
| blank rather than zero | 0 | 0 |

A skill row's zero means he dressed and took no offensive snap — a **real
measurement**. Correct treatment is **leave it alone**, not `NULLIF`.

**Why:** the contamination reflex is right for a roster-wide read
(`who-plays.js`, `nfl-availability.js:188-194`) and wrong for a skill-position
term, and applying it there would silently convert "played none" into
"unmeasured".

**How to apply:** before calling a feed zero contamination, filter to the
population the consumer actually reads. Test it non-circularly — `offense_pct` is
derived from `offense_snaps`, so checking one against the other returns 0 by
construction; join against the weekly stat line instead.

Evidence: `/mnt/project-files/snap-share-lags-2026-09-22.mjs` / `.out`.
