---
name: gridiron-espn-market-job
description: syncEspnMarket had no caller at all while its table carried double weight on the live draft board; the scheduled job must skip rather than write a wrong-season row.
metadata:
  type: project
  modified: 2026-09-19T22:13:00.000Z
---

`syncEspnMarket` (`server/services/espn-market.js:18`) is the only writer of
`espn_player_market` and had **no caller anywhere** — not a route, not a
script, not the scheduler. `POST /aggregates/refresh-all` does not call it
either (verified: it calls `syncPlayersFromESPN`, news, FFC, Sleeper,
FantasyCalc, dynasty — not this), so even a manual "refresh everything" never
refilled the table.

**Why it mattered more than a stale feed.** `computeConsensus()`
(`aggregates.js:218`, consumed by `draft-assist.js:413` and `routes/drafts.js`)
blends `[[ffcRank, 1], [slRank, 1], [espnRank, 2]]` — **ESPN carries double
weight** on the Draft tab. And `draft-assist.js:586-593` checks presence, not
freshness: `unsourced` fires only at `sourcedCount === 0`, so a board resting
entirely on old ESPN rows reports healthy. `POST /aggregates/create-board`
then freezes that ordering into `ranking_entries` permanently.

**The job (PR #50, draft, `claude/project-thread-o3wt2p-espn-market` at `a331bc8`, opened 22:07Z):** growth tier,
12h, **off-thread** (`kona_player_info` is the largest ESPN payload the app
fetches, 17.6 MB before the filter, and `node:sqlite` is synchronous).

**It picks ONE league by query and SKIPS rather than writing a wrong season.**
`espn_id INTEGER PRIMARY KEY`, so the upsert overwrites the `season` column
too. `preseason-model.js:336` and `manager-archetypes.js:166` filter
`WHERE m.season = ?` and merely go blank, but `aggregates.js:226` joins on
`espn_id` with **no season filter** and reads `adp`, `ppr_rank`,
`injury_status` — none scoring-dependent — so a past-season run puts last
year's ADP and injury status on the live board unmarked. Selection is
`ORDER BY season DESC, (espn_s2 IS NOT NULL AND swid IS NOT NULL) DESC, id ASC`
(cookies because `espn-market.js:31` only attaches them when both are present),
and the caller passes `{ limit: 1000 }` because the default 400 leaves the tail
of ~800 ESPN ids unfetched.

**The skip stops it getting worse; it does not make existing staleness
visible.** Feature-audit owns that fix in `computeConsensus()`: admit the ESPN
source into the blend only when `em.season` is the current season, and extend
`espnMarketFreshness()` to return `MAX(season)`.

Reasoning corrected in review: I first argued from scoring (`appliedTotal` in
the fetching league's rules). True but not binding, since every reader of
`season_proj` filters by season. The season is the hazard, not the scoring.
