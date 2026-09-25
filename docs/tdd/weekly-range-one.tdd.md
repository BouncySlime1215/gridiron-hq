# WEEKLY-RANGE-ONE: one producer for a lineup's weekly range

**Broken:** number health `weekly_range` on league 4 (2026-09-24 snapshot, week 3):
"Title odds simulator says 75.0, Start/Sit posture says 41.5 (33.5 pts apart; limit 10)."
Four samplers answered one lineup-week, with different inputs, methods and percentiles.

**Fix:** `server/services/lineup-week-range.js` is the one producer: p10 / p50 / p90 of the
lineup total over the league world's correlated runs (the title odds' draws). The trade
card and My team (`lineupSpread`), the ceiling lineup, the Start/Sit posture's served
`weekly_range` and the number audit all read it. The per-surface samplers are deleted.

**RED:** `test/weekly-range-one.test.js` on `origin/main` fails: the producer module does
not exist and the four surfaces disagree.

**GREEN:** the same file passes (7 tests): (a) every surface returns identical
p10/p50/p90 for the same lineup-week, a bye starter adds 0, and a trade's
floor/ceiling deltas are the producer's after minus before; (b) the old four values
fail the check and the producer's pass it; (c) source scans fail if another server
module sums a lineup over the world runs, runs its own copula, or turns a mean and
SD into a floor or ceiling.

**Measured** on a copy of the 2026-09-24 snapshot, live env, league 4:
weekly_range broken (floor 75.0 vs 41.5, 33.5 pts) -> ok (floors within 2.1 pts,
ceilings within 2.5). The remaining gap is lineup choice: each page still starts its
own lineup (this week's projection vs the world's pool means).
