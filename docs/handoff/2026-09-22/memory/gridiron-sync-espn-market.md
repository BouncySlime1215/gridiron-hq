---
name: gridiron-sync-espn-market
description: The agreed rule for scheduling syncEspnMarket, the sole writer of espn_player_market, and why the league is chosen by season
metadata:
  type: project
  modified: 2026-09-19T22:01:39.976Z
---

**syncEspnMarket** (sole writer of espn_player_market; espn_id is the PRIMARY KEY so the upsert overwrites `season`; readers routes/aggregates.js:226 (NO season filter: a wrong-season run leaves last year's ADP/injury status on the live board), preseason-model.js:336, manager-archetypes.js:166, consensus-weights.js:526). AGREED RULE (feature-audit + scheduler, 21:57Z): scheduler thread's branch `claude/project-thread-o3wt2p-espn-market` registers it growth/12h/off-thread; the caller selects ONE league at run time by MAX(season) as a query (never a hard-coded id), tie-breaks to a league holding both espn_s2 and swid, SKIPS when that season is not the current NFL season, passes { limit: 1000 }. Feature-audit reviews the PR. Separate item: the "800 → 1,042" ESPN limit is routes/espn.js:42 and routes/stats.js:29 (percent-owned filter), not this. espnMarketByPlayerId (:69) and espnMarketFreshness (:76) have zero callers.
