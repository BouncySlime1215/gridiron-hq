---
name: espn-market-caller-decision
description: The agreed syncEspnMarket caller shape — one league chosen by MAX(season), skipped entirely when that season is not the current NFL season, because routes/aggregates.js reads the table with no season filter.
metadata:
  type: project
  modified: 2026-09-19T22:05:00.000Z
---

Settled 2026-09-19 by the feature-audit thread (owner of the caller decision in
`espn-market.js`) after the scheduler thread proposed it; verified in source on
merged main `791b131`. The scheduler thread registers it in `scheduler.js` /
`source-registry.js`. Closes the orphan in [[espn-player-market-dead-writer]].

**Shape: one league, never a loop.**
1. Pick the league by query at run time — `MAX(season)` over `leagues` — never a
   hard-coded league id.
2. Tie-break to a league holding BOTH `espn_s2` and `swid`: `espn-market.js:31`
   attaches cookies only when both exist, and a private league without them
   throws on the fetch.
3. **Skip the run entirely when that max season is not the current NFL season.**
4. Pass `{ limit: 1000 }`. Default is `limit = 400` (`espn-market.js:18`) and we
   hold ~800 ESPN ids, so the tail is definitionally unfetched. The limit rides
   in the caller, so `espn-market.js` needs no edit.
5. Growth tier, 12h, off-thread. ADP is effectively frozen in-season; the only
   in-season-moving field any consumer reads is `injury_status`, already covered
   by `nfl_injuries` plus the ESPN flag.

**Why the rule keys on SEASON, not on scoring.** The scheduler thread's original
reason was that `season_proj`/`week1_proj` are `appliedTotal` in the fetching
league's scoring. True, but not binding: only `preseason-model.js:336` reads
`season_proj`, and it filters `WHERE m.season = ?` — as does
`manager-archetypes.js:166`. A wrong-season write makes those go **blank, not
wrong**.

The hazard is `routes/aggregates.js:226`: it joins `espn_player_market` on
`espn_id` with **no season filter** and reads `adp`, `ppr_rank` and
`injury_status` — none of them scoring-dependent. `espn_id` is the PRIMARY KEY
(`core-and-fantasy.js:595`), so the upsert overwrites the `season` column too.
A run against a non-2026 league therefore puts last year's ADP and last year's
injury status on the live consensus board with nothing marking it stale.

**Do not fold this together with the 800 -> 1042 item.** That is a different
filter on a different endpoint — `routes/espn.js:42` and `routes/stats.js:29`,
sorted by percent owned. See [[espn-player-endpoint-limits]].

**Two orphans remain after the job lands:** `espnMarketByPlayerId`
(`espn-market.js:69`) and `espnMarketFreshness` (`:76`) have zero callers
repo-wide at `791b131`; every real consumer uses raw SQL.

An instance of [[verify-the-consumer-not-the-producer]]: the producer's scoring
argument was correct and irrelevant; the consumer's missing `WHERE` was the bug.
