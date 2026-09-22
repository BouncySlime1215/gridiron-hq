# S-18: hand-fed fantasy tables say which absence they are

Unit S-18 (structure map register 2, data holes H6, H10 and the `correlation_estimates` row).
Branch `claude/local-s-18-hand-fed-tables-empty-state`, cut from origin/main `d6d7bd5a`.

RED and GREEN are filled in below once they exist.

## 1. Audit (written before the first test)

All numbers in this section come from origin/main `d6d7bd5a` and a local copy of
`~/gridiron-local/data.sqlite`, made with `sqlite3 … ".backup"` at 2026-09-22 ~20:18Z.
Label: **local copy, not production.** The copy's `leagues.espn_s2` / `swid` were set to
NULL before anything ran against it, so no script run here could read a cookie.

### The three tables, their readers and their writers

| Table | Reader that reaches Nick | Writer (file:line) | How the writer runs | Local rows |
|---|---|---|---|---|
| `league_roster_snapshots` | `ownedPlayersByChatName`, `server/services/bluff-detector.js:83`, feeding `declarationCredibility` :149 and `untouchableStance` :241 | `writePeriod`, `scripts/collect-roster-snapshots.mjs:109` (INSERT :113, UPDATE :116) | the local refresh loop only: step `rosterSnapshots`, `scripts/refresh-live-data.mjs:119`, called at :269. No server job. | **0** |
| `trending_players` | `buildAssetUniverse`, `server/services/trade-engine.js:319`, served per asset as `trend_kind` / `trend_count` (:442) | route handler `POST /api/tradelab/trending/sync`, `server/routes/tradelab.js:238` (INSERT :248) | no job; one caller, `scripts/bootstrap-data.mjs:106` (one-time bootstrap) | **0** |
| `correlation_estimates` | `table()` → `pairCorrelation`, `server/services/correlation.js:118-138`, used by `lineupSpread` (trade-engine.js:787), `season-sim.js:244`, `ceiling-lineup.js:215`, `draft-lookahead.js:212` | `fitCorrelations`, `server/services/correlation.js:42` (INSERT :98) | only `POST /api/model/sync`, `server/routes/model.js:516`, from the unrouted Model.tsx and `scripts/bootstrap-data.mjs` | **20**, all `fitted_at` 2026-09-17 18:57:42 |

Commands (tree: local copy):

```
sqlite3 .local-db/data.sqlite "SELECT COUNT(*) FROM league_roster_snapshots"   -> 0
sqlite3 .local-db/data.sqlite "SELECT COUNT(*) FROM trending_players"          -> 0
sqlite3 .local-db/data.sqlite "SELECT COUNT(*), MAX(fitted_at) FROM correlation_estimates" -> 20 | 2026-09-17 18:57:42
# known-nonzero controls on the same copy, same session
sqlite3 .local-db/data.sqlite "SELECT COUNT(*) FROM players"                   -> 8640
sqlite3 .local-db/data.sqlite "SELECT COUNT(*) FROM league_member_identity"    -> 10
```

All three tables exist on the copy (`sqlite_master` count 1 each), so today's local
state is `empty` for two of them, not `table_absent`.

### What each reader does today when its table is empty

- **Roster snapshots.** `ownedPlayersByChatName` falls back to the manager's *current*
  `leagues.payload` roster (bluff-detector.js:88-96). "Ever owned" silently becomes
  "owns now". The bluff read is about a manager who calls a player untouchable and later
  moves him, so this is the case the fallback gets wrong: once he has traded the player
  away, the declaration no longer passes the ownership filter (:110) and disappears. The
  credibility read then leans toward "his word holds", and nothing on the result says it
  was checked against today's rosters only.
- **Trending.** Every asset gets `trend_kind: null, trend_count: null`. "Nothing was
  fetched" and "this player is not trending" produce the same value.
  `grep -rn -E "trend_(kind|count)" server client/src scripts study` finds one hit, the
  assignment at trade-engine.js:442. No code names the field again. Control: the same grep
  for `current_week_ppg` finds `WaiverWire.tsx` and `TradeCard.tsx`. The field still
  reaches JSON and prompts through whole-asset spreads (`waiver-wire.js:180`,
  `lineup-brain.js:448`, `routes/trades.js:1025`).
- **Correlations.** `pairCorrelation` uses `DEFAULTS = { team: 0.05, opp: 0.02 }`
  (correlation.js:125) for every archetype the table does not hold. With the table
  empty, the fitted QB-WR same-team value (0.177 on the copy) becomes 0.05. Every lineup
  spread, stack ceiling and title odd uses it, and nothing says so.

### Why no writer is running here

- `sync_log` has no `roster_snapshots` row
  (`SELECT COUNT(*) FROM sync_log WHERE job='roster_snapshots'` → 0). The collector writes
  that row on every run (`recordRosterSnapshotRun`, collect-roster-snapshots.mjs:269), and
  the loop writes it when the spawn fails (refresh-live-data.mjs:126). Control:
  `league_transactions` has a row, last run 2026-09-22T18:56:17Z, so the refresh loop does
  write to this database.
- The running loop (`ps -o lstart= -p 75522`) started **Thu Sep 17 17:17:29 2026**. The
  step first appears on this repo's history at `75c47b83` (2026-09-19). There are no
  `manager_signals` or `league_chat` rows either, and both steps sit in the same `tick()`.
  **Guess, not measured:** the running loop process is older than those steps, so it has
  never run them. A restart of the loop is Nick's to do: it runs from the main clone,
  which this unit may not touch.

### Extend or build

**Extend.** One producer already gives a table verdict:
`tableFreshness` (`server/services/data-freshness.js:149`), served at `/api/data-freshness`,
with statuses `fresh | stale | empty | unknown`. It folds "not in this database" into
`empty` and tells them apart only in `note`, which is a sentence. The unit's acceptance asks
for that distinction as a field.

- Add one field to `tableFreshness` (`present`) and one export (`tableState`) that maps
  its verdict to `table_absent | empty | stale | fresh | unknown`. No second freshness
  implementation.
- Other readers of table state were checked and left alone:
  `grep -rn -E "table_absent|tableExists" server` finds `routes/trades.js:417,441`
  (archetype read state), `league-chat-sync.js:119` (corpus messages),
  `nfl-feature-coverage.js`, `manager-signals.js` and the NFL registries. Each is private
  to its module and answers "is it there", not "is it current".
- Each reader carries its own table's state on the output it already returns:
  `declarationCredibility().roster_history` and `untouchableStance().roster_history`
  (bluff-detector.js); `assetUniverse().context.hand_fed` (trade-engine.js), which reaches
  routes as `model_context` (trade-engine.js:1818 `/api/trades/:leagueId/find`,
  routes/trades.js:843, league-brain.js:302); and `correlationBasis()` (correlation.js),
  carried in the same `hand_fed` block, because `lineupSpread` reads it on the same
  universe.

### Schedule or say "no data": the decision per table

The acceptance says: where a free writer exists and is cheap, schedule it.

- **`league_roster_snapshots`: already scheduled in the repo** (refresh-live-data.mjs:269).
  The live pass needs no network: it reads the stored payload. §4 shows it filling the copy.
  What is missing is the running loop picking it up, which is an ops restart for Nick
  (above). The named state is added anyway, because production has no refresh loop and the
  loop can stop again.
- **`trending_players`: not scheduled here.** The writer is free (Sleeper's public trending
  endpoint, 2 requests), but it lives inside a route handler. Scheduling it needs a service
  function, plus a job in `scheduler.js` or a new refresh-loop step. `scheduler.js` is held
  by F-04, A-23, B-17 and S-04 (WORK-QUEUE §3/§5), and no code reads the field the writer
  fills. Scheduling a writer for a field nothing reads is the "wired data nobody reads"
  failure. Follow-up named in §7.
- **`correlation_estimates`: not scheduled here.** The writer is free and cheap (local
  compute, timed in §4). Scheduling it also needs `scheduler.js`, held as above. Follow-up
  named in §7 (B-17, the NFL-week ops calendar).
