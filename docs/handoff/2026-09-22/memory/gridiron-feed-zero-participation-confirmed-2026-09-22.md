---
name: gridiron-feed-zero-participation-confirmed-2026-09-22
description: nflverse's pbp_participation feed sentinel-writes literal 0 for defenders_in_box and number_of_pass_rushers on unmeasured plays, same as FTN — independently confirmed 2026-09-22, fixed in PR #87.
metadata:
  type: project
  modified: 2026-09-22T08:34:38.029Z
---

PR #87 (`claude/project-thread-5f9c3y-feature-store-feed-zero`, Feed audit
thread), draft, pushed, all three call sites fixed as of 2026-09-22 08:33Z.
Not merged — merge needs Nick's own word per the threat-level-10 list in his
2026-09-22T07:45:57Z routing message.

**What's fixed:** `NULLIF(column,0)` on `defenders_in_box`/`c.defense_box` in
`nfl-weekly-feature-store.js:149,158` and its v2 study copy, and on
`p.defenders_in_box`/`p.number_of_pass_rushers` in v2's `participation()`
(`nfl-weekly-feature-store-v2.js:265`). Full evidence, discover/audit/decide
table, and the independent measurement below are in
`docs/tdd/feed-zero-averages.tdd.md` on that branch.

**The independent confirmation, not just R&D's word:** downloaded a fresh
copy of real 2024 `pbp_participation` (45,919 rows — see
[[network-egress-nflverse-releases]] for how, since `api.github.com` is
blocked in this session) and ran the blank-vs-zero count myself: 9,214 rows
have `defenders_in_box=0` AND `number_of_pass_rushers=0` simultaneously, only
14 rows are genuinely NULL for both, 0 rows have one sentinel-zero paired
against a real value on the other column. `defenders_in_box=0` never happens
on a real NFL snap, so that pairing is the feed's own "measured nothing,
write 0 everywhere" signature — same failure mode as FTN's charting feed,
independent data source.

**Still open, flagged not silently dropped, not yet fixed:**
- `pass_rushers` in `teamHistory()` (v1 and v2, NOT `participation()`) needs a
  dropback/play-type gate; `nfl_play_formations` has no such column and
  `nfl_play_by_play` uses a non-joinable key scheme (ESPN `event_id` vs
  nflverse `game_id`). Whoever picks this up next needs that join solved
  first, not just another NULLIF.
- `n_blitzers` has no live reader in either `teamHistory()` file — confirmed
  by grep, not a live bug today, but also not verified against real data the
  way the fixed columns were.
- `p.was_pressure` and other `participation()` columns beyond the two named
  above were not measured — do not assume they're clean by pattern-matching.
- Same-pattern check was not repeated for other nflverse seasons (2022, 2023,
  2025) — the fix doesn't depend on the answer, but the measurement above is
  scoped to 2024 only.

Related: [[gridiron-missing-data-workaround-rule]], [[gridiron-five-questions-rule]].
