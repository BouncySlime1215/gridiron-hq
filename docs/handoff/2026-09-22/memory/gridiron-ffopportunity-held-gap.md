---
name: gridiron-ffopportunity-held-gap
description: ffOpportunitySeasons treats a season with a single row as complete, so a half-ingested season is never finished; a known gap left deliberately for a follow-up PR after the scheduler stack lands.
metadata:
  type: project
  modified: 2026-09-19T20:05:00.000Z
---

Found 2026-09-19 by the scheduler thread while answering whether
`ffOpportunitySeasons` needed an idempotency guard. It did not — but this
turned up instead, and it is a real gap rather than a tidy-up.

**The defect.** `ffOpportunitySeasons(season)` (`scheduler.js:690`, shipped in
**PR #28**) decides what to fetch like this:

```js
const held = new Set(rows('SELECT DISTINCT season FROM nfl_ffopportunity_weekly')…);
return [...[season - 3, season - 2, season - 1].filter(s => !held.has(s)), season];
```

`SELECT DISTINCT season` is an EXISTENCE check where a COMPLETENESS check was
needed. **A season holding one row counts as held, so it is skipped forever
and never completed.** A season with a handful of rows is exactly what an
OOM-killed sync leaves behind, and this machine had several on 2026-09-19
before the 2 GB resize. It reads as present and is missing.

**The fix, for whoever picks it up:** require a plausible week count for a
prior season (a completed NFL season is about 18 weeks) rather than mere
presence. The current season must stay presence-free, since it legitimately
has few weeks mid-year.

**Deliberately NOT fixed in the stack.** `ffOpportunitySeasons` lives in #28,
so changing it means a commit there plus merging up through four branches and
five more CI runs, while the release thread was proving a merge order. The
consequence of leaving it is a MISSING BACKFILL, never wrong data, and a
missing backfill is recoverable by running it again. Follow-up PR after
[[gridiron-scheduler-ship-plan]] lands. Its description should carry the
"a single row counts as complete" reasoning, because it is not visible in the
diff.

**Visible on deploy day instead**, via a check sent to the release thread:

```sql
SELECT season, COUNT(*) rows, COUNT(DISTINCT week) weeks
FROM nfl_ffopportunity_weekly GROUP BY season ORDER BY season;
```

A completed season showing one or two weeks is the gap. Nothing in the app
exposes per-season counts for this table — not `/api/dev/sources`, not
data-consistency, not `/api/model/status` — so this needs a shell.

**What it does NOT affect.** The opportunity promotion gate. That thread ran
three arms (full history, 2026 deleted, table empty) and all five checks pass
with a byte-identical production vector, so no ffopportunity change in any
amount moves it. Only QBR 2021-2024 does; see the hold in
[[gridiron-open-risks]]. Flagging this gap also led that thread to find the
same shape in its own gate, which replayed seasons without checking coverage.

Related: writes are idempotent twice over — `syncFfOpportunity` upserts via
`ON CONFLICT(season,week,player_gsis_id) DO UPDATE`, and the `held` filter
skips seasons already present — so re-running is always safe.

## FIXED in PR #45 (2026-09-19 21:45Z), branch `claude/project-thread-o3wt2p-ffopp-held`

`ffOpportunitySeasons` now holds a prior season only when it has
`COUNT(DISTINCT week) >= 17`. `DISTINCT week`, not `COUNT(*)`, because the
upsert is keyed on (season, week, player_gsis_id) so one week holds a row per
player. 17 rather than 18 because the regular season was 17 weeks through
2020, and a floor a complete season could fail would re-fetch forever.

The three existing tests inserted ONE week per season and asserted it was
held, so they encoded the bug. Rewritten to ingest full seasons, plus four
new ones; three of the four fail against the old implementation, which was
checked rather than assumed. Suite 2954/2913/0/41.
