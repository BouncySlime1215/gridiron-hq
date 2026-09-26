---
name: gridiron-offense-pct-not-contaminated-2026-09-22
description: nfl_snaps.offense_pct=0 measured and cleared of feed-zero contamination — no fix applied, unlike the two PR #87 columns
metadata:
  type: project
  modified: 2026-09-22T08:54:20.861Z
---

Auditor's Plan 02 gate asked whether `nfl_snaps.offense_pct` (averaged in
`teamHistory()`, `nfl-weekly-feature-store.js:130`, same function PR #87
fixed two other columns in) has the same feed-zero contamination as
`defenders_in_box`/`defense_box`/`number_of_pass_rushers`. Measured
`snap_counts_<season>.csv` vs `stats_player_week_<season>.csv` (nflverse,
2022-2025, 27,341 SKILL-position rows) for offense_pct=0 co-occurring with
real recorded usage that week (a contradiction, since 0% offensive snaps
can't coexist with a real attempt/carry/target/reception).

**Result: not contaminated.** Only 4 contradiction rows found (0.015%),
vs PR #87's ~20% contamination rate for the two feeds it fixed. offense_pct
is legitimately 0 for ~6% of SKILL rows/season (inactive/ST-only weeks) —
a real, useful signal, not a sentinel. **Decision: no fix, NULLIF would be
actively wrong here** (would strip real zero-snap weeks and inflate the
metric for exactly the low-usage players it's meant to flag).

Full evidence: `docs/tdd/offense-pct-zero-not-contaminated.tdd.md`, commit
`eaed26e` on branch `claude/project-thread-5f9c3y-offense-pct-audit`.

**Why this matters:** confirms the feed-zero pattern from PR #87
([[gridiron-feed-zero-participation-confirmed-2026-09-22]]) is NOT a
blanket rule — every column co-occurring with a known-contaminated feed
still needs its own independent measurement before treatment. Don't
pattern-match "looks like the same shape" onto a NULLIF fix without
checking.

**How to apply:** if `defense_pct`/`st_pct` (siblings of offense_pct in
`nfl_snaps`) come up later, they are UNMEASURED — do not assume they're
clean just because offense_pct was.
