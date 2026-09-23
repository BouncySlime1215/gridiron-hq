# RL-12-3: one news-attribution producer for the player card and the News page

Unit RL-12-3 (R&D round 12 internal package `r12-internal-player-card-news-ignores-resolved-players.md`).
Branch `claude/local-rl-12-3-player-card-news-attribution`, cut from origin/main `57a9ca1c`.
Not a statistical unit: no model number, no pre-registration, 2025 held-out season not opened
(no HOLDOUT-LEDGER row needed).

## Audit (before the first test): extend or build

Every producer of "which stories are about player X" on origin/main `57a9ca1c`
(`grep -rn 'entities_json\|newsFor' server client/src`):

| Producer | file:line | Rule | Readers |
|---|---|---|---|
| `newsFor(player)` | `server/routes/players.js:27-37` | substring `LIKE` of full name on headline/ai_analysis/fantasy_impact, or the last name token (so "Jr." for Pittman Jr.) when `n.team_id = player.team_id`; `ORDER BY n.date DESC LIMIT 10` (day-only) | `GET /players/:id` (`:82`) -> `PlayerCard.tsx:223` "Recent news", `PlayerDetail.tsx:103` "News mentioning {last}"; `POST /players/:id/analyze` (`:186` -> `:160`) AI Buy/Sell facts |
| News desk attribution | `server/routes/news.js:64-66` | `entities_json.players` (deduped by normalised name) | `GET /news/desk` -> `NewsHub.tsx:84` player links, "My Players" tab |
| entity readers | `nfl-news-events.js:132`, `nfl-player-state.js:38`, `nfl-news-signal.js` | `entities_json.players` | news signal / player state (model side, not a display list) |

Table and writers: `news_items.entities_json`, written by `upsertNormalizedNewsItem`
(`server/news/store.js:33`, via `extractEntities` `server/news/normalize.js:37`),
`insertArticles` (`server/routes/espn.js:197`) and `backfillNewsEntities` (`server/routes/espn.js:214`).

Two producers disagree on the same input (the R&D package measured 124/428 resolved stories missing
from the card and 35/369 card rows not resolved to the player). Decision: **build** one producer in
`server/news/player-news.js` (`attributeStory` for "which players is this story about", `playerNews`
for "which stories are about this player", the second defined by the first), and make both the card
(`/players/:id`, `/analyze`) and the News desk read it. The ingest resolver stays the writer; no
migration, no new column (read-time attribution only).
