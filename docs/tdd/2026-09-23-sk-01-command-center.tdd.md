# SK-01 — weekly command center across every league (B10 Diligence Engine)

Branch `claude/local-sk-01-command-center`, base `origin/main` at `131a7ba0`.

## Audit (on `131a7ba0`) — extend or build

Question: is there already one list, across leagues, of what needs doing this week?

| Concept | Existing producer on `131a7ba0` | State |
|---|---|---|
| Dead starters | `lineupDiff()` `server/services/trade-engine.js:2814`, field `flagged_starters` (`:2904`): a started player on IR (slot or ESPN `INJURY_RESERVE`) or flagged out for the season (`available === false`) | on main, one league per call; reached by `GET /api/trades/:leagueId/lineup-diff` (`server/routes/trades.js:700`) and the League Hub My team view (`client/src/pages/MyTeam.tsx:56`) |
| Dead-starter guard SS-01 | none (no branch on origin: `git branch -r \| grep -i ss-01` empty) | not built |
| Streaming swap WV-01 | `streamingBoard()` `server/services/streaming-board.js` on `origin/claude/local-wv-01-streaming-board` (PR #176, open) | not on main |
| Injury alerts WV-02 | `waiverBoard().injury_alerts` `server/services/waiver-wire.js` on `origin/claude/local-wv-02-injury-replacement-alert` (PR #178, open) | not on main |
| Waiver claims this week | `waiverBoard().immediate` `server/services/waiver-wire.js:152` | on main |
| Transactions this week | table `league_transactions_raw`, writer `scripts/collect-league-transactions.mjs:34` (the `upsert` prepared statement; table created by hand at `:21`, no migration); freshness accessor `transactionsCollected()` `server/services/manager-signals.js:579` | on main, off-server collector |
| Kickoff time | table `game_lines` via `linesFor()` `server/services/gamescript.js:416` + `nflKickoffDate()` `server/services/date-util.js:48` (the pair WV-01 uses) | on main |
| League week | `leagueCurrentWeek()` `server/services/league-week.js:12` | on main |
| A cross-league list | none: `grep -rln -e command-center -e commandCenter server client/src` returns nothing; every fantasy route is `/:leagueId/...` | gap |

Decision: **build** the aggregate (`server/services/command-center.js`,
`GET /api/command-center`) and **reuse** every producer above; no number in
the command center is computed by it. It adds no table and no column.

Feature detection (these units are not merged on `131a7ba0`):
- streaming: the service imports `./streaming-board.js` dynamically; a
  `ERR_MODULE_NOT_FOUND` for that file sets the source to `not_merged`
  ("waiting on WV-01, PR #176"). Any other import error throws.
- injury alerts: `waiverBoard()` output carries an `injury_alerts` array, or
  the source is `not_merged` ("waiting on WV-02, PR #178").
- dead starters: `lineupDiff()` output field `dead_starters` (SS-01) is read
  when present, else `flagged_starters`. **Guess:** SS-01 has no branch, so
  the field name `dead_starters` is a guess; the producer actually used is
  named on every response (`sources.dead_starters.producer`).
- waiver-run deadline: `waiver-wire.js#nextWaiverRun` (WV-02) when exported,
  else the first injury alert's `claim_by`, else unknown.
