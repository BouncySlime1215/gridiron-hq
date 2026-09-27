---
name: espn-adp-double-weight-on-draft-board
description: ESPN ADP carries double weight in computeConsensus and the Draft tab checks presence not freshness, so a stale-season espn_player_market makes last year's ADP the heaviest input to this year's board while reporting healthy.
metadata:
  type: project
  modified: 2026-09-19T22:15:00.000Z
---

Found 2026-09-19 by the feature-audit thread while reviewing the
[[espn-market-caller-decision]]; verified in source on merged main `791b131`.
Another instance of the signature failure mode: healthy-looking and not working.

**The weight.** `computeConsensus()` (`server/routes/aggregates.js:218`) blends
`[[ffcRank, 1], [slRank, 1], [espnRank, 2]]` at `:250`. ESPN carries **double**
weight — the heaviest single input to the board's ordering.

**The join has no season predicate.** `:226` is
`LEFT JOIN espn_player_market em ON em.espn_id = p.espn_id`, reading `em.adp`,
`em.ppr_rank`, `em.injury_status`. `espn_id` is the table's PRIMARY KEY
(`core-and-fantasy.js:595`), so whatever season was written last is what the
board reads, presented as current.

**Live consumers, so this is not theoretical.** `draft-assist.js:413`,
`routes/drafts.js:80` and `:445` — the **Draft tab**, one of the eight surviving
nav tabs. `POST /aggregates/create-board` (`aggregates.js:263`) then freezes the
ordering into `ranking_entries` permanently.

**The health check misses it.** `draft-assist.js:586-593` reports
`sourced / synthetic / unsourced`, and `unsourced` fires only at
`sourcedCount === 0`. A board resting entirely on 2025 rows reports
`sourced: N, unsourced: false`. Presence is checked; freshness is not.

**Also:** `POST /aggregates/refresh-all` (`aggregates.js:275`) calls
`syncPlayersFromESPN()` and never `syncEspnMarket`, so a manual "refresh
everything" never refilled the table either. See
[[espn-player-market-dead-writer]].

**Whether it is live right now is unknown from source** — needs
`SELECT season, COUNT(*), MAX(fetched_at) FROM espn_player_market GROUP BY season`
on the live DB, riding the post-deploy scheduler read. All-2026 means latent;
any older row means it is wrong on the Draft tab today.

**Fix queued** (feature-audit thread, draft PR after the deploy, with the
`tradeWeekContext` change): (1) `computeConsensus()` admits the ESPN source only
when `em.season` is the current NFL season — accepted consequence is the board
falls back to FFC/Sleeper and `market.unsourced` then correctly fires;
(2) `espnMarketFreshness()` (`espn-market.js:76`) also returns `MAX(season)` and
the UI thread renders it in the Draft board's `market` block, which retires one
of its two zero-caller helpers.

**Allocation:** `routes/aggregates.js` was unallocated as of 2026-09-19; the
feature-audit thread takes it with this PR and says so in the PR body, so that
the one-editor-per-server-file rule keeps holding.
