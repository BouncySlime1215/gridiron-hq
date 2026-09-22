# S-18: hand-fed fantasy tables say which absence they are

Unit S-18 (structure map register 2, data holes H6, H10 and the `correlation_estimates` row).
Branch `claude/local-s-18-hand-fed-tables-empty-state`, cut from origin/main `d6d7bd5a`.

- Audit: `bfbf5f00` docs: S-18 audit and extend-or-build for the three hand-fed fantasy tables
- RED: `8f26dfb2` test: hand-fed tables must name their absence on the reader (S-18 RED)
- GREEN: `71b728c1` fix: hand-fed fantasy tables name their absence on the reader (S-18 GREEN)
- Round 2, after two skeptic reviews of `eb8b0072` (§0):
  - RED 2: `edcaa018` test: one rule per hand-fed table, orphan stance field, and the skeptics' surviving mutants (S-18 RED 2)
  - GREEN 2: `5db13863` fix: one rule per hand-fed table, read from the served-table entry; no orphan stance field (S-18 GREEN 2)
  - `9cbe0965` refactor: drop the available gate in untouchableStance; only a read record carries roster_history (S-18)
  - `41ef5658` test: the served-table registry's entry wins over the hand-fed fallback (S-18)
- PR: not opened (the task says push only). Test files: `test/hand-fed-table-states.test.js`
  (10 cases) and `test/hand-fed-registry-wins.test.js` (3 cases).

## 0. Round 2: what the skeptics found and what changed

Two independent reviews of `eb8b0072` found blocking issues. All of them were right; no
finding is disputed below. Every number in this section is from tree `41ef5658` unless it
says otherwise, and from a new local copy (`sqlite3 … ".backup"` at 2026-09-22T21:03:42Z,
cookies nulled; **local copy, not production**).

### Test liveness: five surviving mutants, now killed

| Skeptic id | Mutant | Why it survived on `eb8b0072` | Case that kills it now (first failing assertion on `41ef5658`) |
|---|---|---|---|
| U1 | credibility cache key keeps only the state | case 2 only wrote state-flipping rows | case 3: "a snapshot write that leaves the state fresh still changes ownership; the cache has to see it" (Sam's one declaration moves 0 → 1 on a fresh → fresh write) |
| C3 | `assetPrint` filters out `correlation_estimates` | case 6's refit went through `assetUniverse`, not `assetPrint` | case 8: "findTrades keys its cache on this fingerprint; lineupSpread prices every deal with the refit correlations" (`tradeIdeasFingerprint` before/after the in-place refit) |
| C2 | `findTrades` returns `model_context` without `hand_fed` | no test called `findTrades` | case 8: "model_context on the find-trades body carries the state" |
| C1 | `counterparty-pricing.js:368` passes credibility with `roster_history` nulled | case 4 built the credibility by hand | case 6: "counterparty-pricing hands untouchableStance the credibility it read; the caveat has to survive that hop" (`counterpartyLayer(70).get('3').stance.note`, the value `/brain/managers` serves as `word_note`) |
| U2 | caveat silent for `stale` | case 4 checked only fresh and empty | case 5: "stale history is the one way a stopped collector reaches Nick; it has to be named" (stale and table_absent cases added) |

The credibility cache key also changed (below), and cases for its other two parts were
added: an in-place `markGone`-style UPDATE (`on_roster = 0`, `changed_at` bumped, no row
count or state change) and a season rollover (`NFL_SEASON` 2026 → 2027, no write).

### Structure: the orphan field

`untouchableStance()` returned `roster_history` and nothing outside tests read it. Fixed
with the skeptic's option (a): the field is gone from `untouchableStance`'s return and from
`declarationCredibility`'s no-corpus return (bluff-detector.js:190); the note clause stays and
is the served surface (`word_note`, routes/trades.js:485). `declarationCredibility`'s field on
the corpus branch (:263) stays, because `untouchableStance` reads it for the note (:288).

```
git grep -n roster_history 41ef5658 -- server client/src scripts
  -> bluff-detector.js:168,169,172 (doc comment), :263 (set), :285 (comment), :288 (the one read), :318 (comment)
# control, same command shape: git grep -n word_note 41ef5658 -- server client/src | wc -l -> 8
```

Local copy: `counterpartyLayer` over all 5 leagues profiles 46 managers; 3 stances carry a
note; **0 stances carry a `roster_history` field** (was 10 of 10 identified managers per the
skeptic's probe on `eb8b0072`); 0 notes carry the caveat, because the roster history is now
`fresh` on the copy (below).

The sweep then showed the `available === true` gate in `untouchableStance` was redundant
(mutant M5 survived all 10 cases on `5db13863`: the no-corpus return no longer carries the
field), so `9cbe0965` removed it.

### Structure: one rule per table

S-18's first cut defined a private current-data rule for each table (8-day windows for
roster snapshots and correlations). Open PRs #96 / #104 define different rules for the same
two tables in `source-registry.js`. On the same input they disagreed.

Fix: one entry per table, `HAND_FED_ENTRIES` in data-freshness.js:288, read through
`servedTableEntry()` (:331), which returns the registry's entry when `servedTables()` exports
one and the fallback otherwise. The roster-snapshot and correlation entries are copied
verbatim from #104 @ `e3a86764` (source-registry.js:436-447, :505-517). **The loser is S-18's
8-day windows** (both hand-set guesses). The coverage rule is also data-freshness.js's own
contract for a fit store (data-freshness.js:176 on `d6d7bd5a`: "The VERDICT for a fit store is
still coverage, never a timestamp"). `trending_players` has no entry on #96 or #104
(`git show a24692d3:server/services/source-registry.js | grep -c trending_players` → 0, same
on `e3a86764`), so its 2-day window stays, in the same list, as the one guess.
`servedTableState()` (:345) reports `unknown`, not `stale`, when a rule binds a season or week
the caller did not supply; the roster reader supplies the season from `currentNflWeek()`,
the producer the Data Health route uses (routes/data-freshness.js:29).

Probe (scratchpad `s18-probe2/probe-rules.mjs` and `probe-old.mjs`, same local copy, scenario B
inside a rolled-back transaction: every correlation fitted 10 days ago and every 2026 snapshot
changed 10 days ago):

| Tree | Scenario | roster: reader / panel | correlations: reader / panel | trending: reader / panel |
|---|---|---|---|---|
| `eb8b0072` + #104's source-registry.js (control) | A (as is) | fresh / fresh | fresh / fresh | not probed |
| same | **B** | **stale / fresh** | **stale / fresh** | not probed |
| `41ef5658` | A | fresh / fresh | fresh / fresh | empty / empty |
| `41ef5658` | B | fresh / fresh | fresh / fresh | empty / empty |
| `41ef5658` + #104's source-registry.js | A and B | fresh / fresh, entry from `servedTables()`, #104 evaluator fresh | fresh / fresh, entry from `servedTables()`, #104 evaluator fresh | empty / empty, entry from the fallback |

The control row reproduces the skeptic's disagreement, so the probe can see one; after the
fix there is none, with or without #104. `test/hand-fed-registry-wins.test.js` pins the
"registry wins" branch with a mocked `servedTables()` whose rules disagree with the fallback
on the same rows (mutant D1, "fallback always answers", is killed by it).

### What the local copy shows now

- `league_roster_snapshots`: **2,266 rows**, all season 2026, written 2026-09-22T20:50:40Z.
  `sync_log` `roster_snapshots`: last_run_at 2026-09-22T20:50:40.066Z, ok, 2,266 writes,
  10 fetches. A second refresh loop, PID 49407, started Tue Sep 22 16:48:05 2026 (local) from
  the main clone (`lsof -d cwd`), next to the old one, PID 75522 (started Sep 17), which is
  still running. `declarationCredibility().roster_history` → `{ state: 'fresh', rows: 2266,
  last_write: null }` (last_write is null because #104's entry has `updated_col: null`).
- `correlationBasis()` → `{ state: 'fresh', rows: 20, last_write: '2026-09-17 18:57:42', fallback: null }`.
- `trending_players` → `{ state: 'empty', rows: 0 }`.
- The consumer: `findTrades(league 1)`, the body of `GET /api/trades/:leagueId/find`
  (scratchpad `s18-probe2/measure2.mjs --find`, tree `41ef5658`): `model_context.hand_fed` =
  trending `{ empty, 0 }`, correlations `{ fresh, 20, last_write '2026-09-17 18:57:42' }`;
  4 deals, 25.8 s at load average ~11-14.

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
  (bluff-detector.js; **round 2: the `untouchableStance` field was an orphan and is gone, §0**); `assetUniverse().context.hand_fed` (trade-engine.js), which reaches
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

## 2. RED

`8f26dfb2` on top of origin/main `d6d7bd5a`. Command (tree `d6d7bd5a` + the test file):

```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite \
  node --experimental-test-module-mocks --test --test-reporter=tap test/hand-fed-table-states.test.js
# tests 7, pass 0, fail 7, exit 1
```

Each case failed at an assertion about the missing piece, not at setup:

| # | Case | Failing assertion |
|---|---|---|
| 1 | tableState names the absence | `freshness.tableState is not a function` |
| 2 | credibility read carries its table state | `assert.deepEqual(pick(empty.roster_history), { table: 'league_roster_snapshots', state: 'empty', rows: 0 })`, actual `undefined` |
| 3 | no corpus: state still travels | `assert.equal(r.roster_history?.table, 'league_roster_snapshots')`, actual `undefined` |
| 4 | stance says "current rosters only" | `assert.equal(held.roster_history?.state, 'fresh')`, actual `undefined`. The fixture line before it (`held.stance === 'respect'`) passed. |
| 5 | correlation basis | `correlation.correlationBasis is not a function` |
| 6 | universe context names both inputs | `assert.ok(h0, 'the served context (model_context on /api/trades/:leagueId/find) carries hand_fed')` |
| 7 | findTrades keys on the correlation store | `names.includes('correlation_estimates')`, actual `false` |

## 3. GREEN: what it does

`71b728c1`. Four files, +179 / -15.

- **`server/services/data-freshness.js`**: `tableFreshness` gains `present` (:201). New
  `tableState(entry)` (:261) returns `{ table, state, rows, last_write, rule }`, where
  `state` is `table_absent | empty | stale | fresh | unknown`. The Data Health route's
  `status` vocabulary is unchanged.
- **`server/services/bluff-detector.js`**: `declarationCredibility()` returns
  `roster_history` in both branches (:192, :265). The cache key now includes the roster
  history's state, row count and newest stamp. Before, a snapshot write changed whose
  players count but was served the cached read. `untouchableStance()` returns
  `roster_history` (:313) when the record was actually read (:287). Its `note` (served as
  `word_note`, routes/trades.js:485, shown in `ManagerRead.tsx:204`) gains one clause when
  the history is not fresh: "ownership checked against current rosters only
  (league_roster_snapshots is empty), so a declared player he has since traded away is not
  counted".
- **`server/services/correlation.js`**: `correlationBasis()` (:152) returns the store's
  state plus `fallback: { team: 0.05, opp: 0.02 }` when the table holds nothing, else null.
- **`server/services/trade-engine.js`**: `assetUniverse().context.hand_fed` (:517) carries
  `trending_players` and `correlation_estimates` states. Routes serve it as
  `model_context`: `GET /api/trades/:leagueId/find` (routes/trades.js:708 → trade-engine.js:1853),
  routes/trades.js:843 and league-brain.js:302. `ASSET_INPUT_TABLES` stamps
  `trending_players.fetched_at`, because a re-sync upserts in place and the row count never
  moved. It also adds `correlation_estimates`, because `lineupSpread` reads it inside
  `findTrades`, whose cache keys on this list, and a refit was served stale spreads. The
  cache key carries the hand-fed states (:290), because a table going stale with time
  moves no row and no stamp.

Staleness windows are **hand-set, not fitted (guess)**: trending 2 days (Sleeper looks
back 24 h), roster snapshots 8 days and correlations 8 days (one NFL week plus a day).
`last_write` travels with every state, so a reader can judge for itself.
**Round 2: the two 8-day windows are gone; both tables now use the registry's coverage
rules (§0). The trending window is the one guess left.**

Targeted runs after GREEN, one at a time, each on its own temp DB (tree `71b728c1`):

```
test/hand-fed-table-states.test.js              pass 7  fail 0
test/bluff-detector.test.js                     pass 3  fail 0
test/manager-data-pipeline.test.js              pass 27 fail 0
test/valuation-map.test.js                      pass 47 fail 0
test/wiring-absent-states.test.js               pass 6  fail 0
test/data-freshness*.test.js (6 files)          pass 45 fail 0
test/asset-cache-stamps.test.js                 pass 5  fail 0
test/asset-universe-fingerprint.test.js         pass 5  fail 0
test/ceiling-lineup-recency.test.js             pass 6  fail 0
test/draft-lookahead-variance.test.js           pass 12 fail 0
test/decision-leftovers-home-away.test.js       pass 5  fail 0
test/nflverse-attribution.test.js               pass 4  fail 0
```

`npm run check` was not run here. The task reserves it for the Gate phase (8-core Mac;
load average was 19-23 during this unit).

## 4. The numbers (local copy, not production)

Tree `71b728c1`. DB: `.local-db/data.sqlite` (the copy from §1, cookies nulled). Chat:
a `.backup` copy of the Mac corpus in the scratchpad, read-only. No names printed.

**Before any writer ran** (`node s18-measure.mjs before --universe`):

| Reader | Field | Value |
|---|---|---|
| `declarationCredibility()` | `available` / managers | true / 2 |
| | `roster_history` | `{ state: 'empty', rows: 0, last_write: null }` |
| `correlationBasis()` | | `{ state: 'fresh', rows: 20, last_write: '2026-09-17 18:57:42', fallback: null }` |
| `assetUniverse(league 1).context.hand_fed` | `trending_players` | `{ state: 'empty', rows: 0 }`, and 0 of 8,640 assets have a non-null `trend_kind` |
| | `correlation_estimates` | `{ state: 'fresh', rows: 20 }` |
| `findTrades(league 1).model_context.hand_fed` (the `/find` route's body) | both | same as the row above; 3 deals, 73 s under load |

**Roster snapshots: the scheduled writer, run once on the copy**
(`node s18-measure.mjs after-collect --collect`, which runs `collectRosterSnapshots({ network: false })`,
the refresh loop's step without its ESPN pass):

- status `ok`, **756 writes in 466 ms, 0 fetches**: 5 leagues, scoring period 3, source
  `live`. Per league 129 / 163 / 130 / 172 / 162 rows (8, 10, 8, 10, 10 teams).
- `sync_log` `roster_snapshots`: `ok`, runs 1.
- `declarationCredibility().roster_history` → `{ state: 'fresh', rows: 756, last_write: '2026-09-22T20:38:03.369Z' }`.
- Not measured: whether any declaration's verdict moves. The live pass writes the same
  current roster the fallback already used. Only the network pass (completed periods from
  ESPN boxscores, with league cookies) adds history, and it was not run: no cookies were
  used anywhere in this unit.

**Correlations: the writer on an empty store** (`node s18-corr.mjs`: a fresh migrated DB
seeded with the copy's 8,640 `players` and 42,624 `player_week_usage` rows):

- before: `{ state: 'empty', rows: 0, fallback: { team: 0.05, opp: 0.02 } }`. The QB-WR
  same-team correlation actually used was **0.05**.
- `fitCorrelations()`: **20 archetypes in 1,272 ms**, local compute, no network.
- after: `{ state: 'fresh', rows: 20, fallback: null }`. QB-WR same-team **0.1764**.
- An empty store understates the main stack correlation by about 3.5×. That figure is the
  ratio of the two numbers above. Its effect on a spread or a title odd was not measured.

## 5. Mutation sweep

### Round 2 (tree `41ef5658`)

Harness: the scratchpad's `s18-mutate2.py`. One mutant at a time, both S-18 test files,
restore with `git checkout`; the tree was clean afterwards (`tree_clean_after: true`).
**26 of 26 intended mutants killed** (15 unit, 11 call-site), the designed survivor survived
and the not-applied control was reported not-applied.

| Id | Kind | Mutant | Result |
|---|---|---|---|
| U1 | unit | credibility key keeps only the state (skeptic U1) | killed (case 3, fresh → fresh write) |
| U1b | unit | key sees the row count, not `changed_at` | killed (case 3, in-place UPDATE) |
| U1c | unit | key drops the state | killed (case 3, season rollover) |
| M3 | unit | the pre-S-18 key, chat only | killed (case 3) |
| U2 | unit | caveat silent for stale (skeptic U2) | killed (case 5) |
| M4 | unit | caveat silent for empty and table_absent | killed (case 5) |
| U3 | unit | table_absent worded as empty | killed (case 5) |
| M6 | unit | no-corpus return grows `roster_history` back | killed (case 4) |
| M14 | unit | `untouchableStance` returns the orphan field again | killed (case 5) |
| C4 | call-site | roster reader supplies no season | killed (cases 3, 6) |
| C5 | call-site | roster reader supplies last season | killed (cases 3, 6) |
| C1 | call-site | `counterparty-pricing.js:368` nulls `roster_history` (skeptic C1) | killed (case 6) |
| M1 | unit | `tableState` folds table_absent into empty | killed (case 1) |
| M2 | unit | `present` never set | killed (both files) |
| D1 | unit | registry ignored, the fallback always answers | killed (registry-wins cases 1-2) |
| D2 | unit | an unsupplied bound value reads stale, not unknown | killed (case 2) |
| D3 | unit | correlation rule back to the 8-day window (the loser) | killed (case 10) |
| D4 | unit | roster rule back to the 8-day window (the loser) | killed (cases 2, 10) |
| M7 | unit | `correlationBasis().fallback` always null | killed (case 7) |
| C6 | call-site | `correlationBasis` reads the trending entry | killed (case 7, registry-wins case 3) |
| C2 | call-site | `findTrades` body drops `hand_fed` (skeptic C2) | killed (case 8) |
| C3 | call-site | `assetPrint` blind to `correlation_estimates` (skeptic C3) | killed (case 8) |
| M8 | call-site | context reads the wrong store for correlations | killed (case 8) |
| M9 | call-site | `correlation_estimates` out of `ASSET_INPUT_TABLES` | killed (cases 8, 9) |
| M10 | call-site | trending back to a row count only | killed (case 9) |
| M11 | call-site | universe context loses `hand_fed` | killed (case 8) |
| M12 | **designed survivor** | hand-fed state dropped from `assetInputsKey` | **survived** (reason below, unchanged) |
| NA | **not-applied control** | the removed `TRENDING_STORE` text | **not-applied** |

On `5db13863`, before the refactor, M5 (drop the `available === true` gate) **survived** all
10 cases; the gate was redundant and `9cbe0965` removed it.

### Round 1 (tree `71b728c1`, superseded)

Harness: the scratchpad's `s18-mutate.py`. It applies one mutant, runs the test file,
records the result and restores with `git checkout`. Tree `71b728c1`; the tree was clean
afterwards.

| Id | Kind | Mutant | Expected | Result |
|---|---|---|---|---|
| M1 | unit | `tableState` folds `table_absent` into `status` | killed | killed (case 1) |
| M2 | unit | `base.present = true` removed | killed | killed (cases 1, 2, 3, 5, 6) |
| M3 | unit | credibility cache key without roster history (the pre-S-18 key) | killed | killed (case 2; case 3 fails because case 2 stopped before ageing the row) |
| M4 | unit | caveat silent unless stale | killed | killed (case 4) |
| M5 | call-site | stance takes `roster_history` from an unread record (drops the `available === true` gate) | killed | killed (case 4) |
| M6 | call-site | no-corpus branch drops `roster_history` | killed | killed (case 3) |
| M7 | unit | `correlationBasis().fallback` always null | killed | killed (case 5; case 6 fails because case 5 stopped before inserting its row) |
| M8 | call-site | context reads the trending store for `correlation_estimates` | killed | killed (case 6) |
| M9 | call-site | `correlation_estimates` out of `ASSET_INPUT_TABLES` (the pre-S-18 list) | killed | killed (cases 6, 7) |
| M10 | call-site | trending back to a row count only (the pre-S-18 entry) | killed | killed (case 7) |
| M11 | call-site | `hand_fed` removed from the served context | killed | killed (case 6) |
| M12 | **designed survivor** | hand-fed state dropped from `assetInputsKey` | survived | **survived** |
| M13 | **not-applied control** | target text that does not exist | not-applied | **not-applied** (0 matches, reported as such) |

Why M12 survives: every state flip in the tests comes from a write (an insert or a stamp
update), and the stamps in `ASSET_INPUT_TABLES` already see those. The key matters only
for a clock-driven flip, where a table ages past its window with no write. A test cannot
produce that without moving SQLite's `now`. The line stays because the failure it guards
against (a cached context that says `fresh` for a week-old table) is real and has no
other guard.

Cases 3 and 6 depend on rows written by cases 2 and 5, so an early failure cascades (M3,
M7). Each mutant was still killed by the case written for it.

## 6. Holdout looks and statistical discipline

- Holdout looks: **none**. No model number is produced or changed, 2025 was not read, and
  `docs/evidence/HOLDOUT-LEDGER.md` does not exist on origin/main.
- Pre-registration, forward holdout, MDE and decision win rate: **not applicable**. This
  unit adds states and cache keys, not a number that feeds a start/sit, waiver or trade
  call. The one price-relevant effect is the bluff caveat, which changes a sentence, not a
  valuation.

## 7. Known defects and what this does not cover

- **Roster history: a collector that stops mid-season now reads `fresh`.** The registry's
  rule asks only whether this season has a snapshot. S-18's 8-day window caught a stall and
  lost (§0). Follow-up for the data thread (o3wt2p, owner of #96 / #104): #104's comment at
  source-registry.js:288 says `league_roster_snapshots` has "no timestamp column at all", but
  migration 058 creates `first_seen_at` and `changed_at` NOT NULL
  (server/migrations/058_league_roster_snapshots.js:48-49). A recency rule, or
  `updated_col: 'changed_at'` so `last_write` is not null, is possible if they want it.
- **Two refresh loops are running on this Mac** (PIDs 75522 from Sep 17 and 49407 from
  Sep 22 16:48 local, both from the main clone). The new one ran the roster step. Whether the
  old one should be stopped is Nick's call; this unit did not touch either process.
- **`routes/trades.js` `/brain/managers` serves only `word_stance` and `word_note`** (:485),
  so the roster-history state reaches that page as the note's clause, not as a field. The
  follow-up is a `roster_history` field beside `transactions` / `chat` in that payload
  (F-07 / A-07 / B-01 hold the file).
- **`trending_players` is not in the served-table registry.** Its rule lives in
  HAND_FED_ENTRIES alone, and the Data Health panel does not list it. Follow-up: the data
  thread adds it to `servedTables()` (then the registry wins automatically) or it goes on
  the D25 kill list, since nothing reads `trend_kind` / `trend_count`.
- **Season sim and the Ceiling tab still fall back to DEFAULTS without saying so**
  (`season-sim.js:244`, `ceiling-lineup.js:215`, held by S-05 / S-06). Follow-up: each reads
  `correlationBasis()` and serves it beside its odds or ceiling.
- **`GET /api/tradelab/trending` still answers `[]` for an empty table**
  (routes/tradelab.js:259, S-11's file). No client calls it.
- **Scheduling not done.** Correlations: `fitCorrelations` is free and takes 1.3 s; it
  belongs on the NFL-week calendar after the weekly usage ingest (B-17 owns `scheduler.js`
  jobs). Trending: waits for a consumer (MS-05) or the D25 kill list.
- **Table-level, not league-level.** A league with no snapshots while another league has
  them reads `fresh`. `ownedPlayersByChatName` still falls back per manager.
- **The trending state's clock-only flip has no test** (M12, the designed survivor).
- **Edits outside the coordinator's trade-engine ranges** (~200-235, ~319): the import at
  :78-79, the cache key at :281 and one line in the context literal at :508.
  data-freshness.js and correlation.js are unallocated and got additive edits.
- A pre-existing `catch { continue; }` in `ownedPlayersByChatName` silently skips a league
  whose payload does not parse. Not changed here.

## 8. Nick's five questions

1. **Well built?** One verdict function (`tableFreshness`) and one entry per table
   (`servedTableEntry`: the registry's when it exports one). Three readers carry the state
   on outputs they already return; no new table, no route edit, no new field without a
   reader. 13 cases over two files; 26 of 26 intended mutants killed, one designed survivor,
   one not-applied control. 19 neighbouring test files pass (§9).
2. **Stats or made up?** No statistics. States are read from the tables. The roster and
   correlation rules are the registry's coverage rules; the trending 2-day window is
   hand-set, a guess, and the code says so.
3. **How we know.** Tests (RED `8f26dfb2` / `edcaa018`, GREEN `71b728c1` / `5db13863`), the
   sweep, and runs on a local copy: the reader and the panel agree in both probe scenarios,
   and the pre-fix tree disagrees on scenario B (§0). No backtest: there is no model.
4. **Pointed anywhere else?** `model_context.hand_fed` on `/api/trades/:leagueId/find`
   (trade-engine.js:1844, now tested), routes/trades.js:843 and league-brain.js:302;
   `word_note` on `/brain/managers` and the ManagerRead tooltip (the `counterpartyLayer`
   hop is now tested). The `findTrades` and asset-universe caches refresh on a correlation
   refit and on a trending re-sync.
5. **How it unifies.** One rule per table: the readers and the Data Health panel evaluate
   the same entry with the same function, so they cannot disagree on the same input (§0
   probe). On main today the panel lists only `player_week_usage` (`servedTables()` is not
   exported); when #96 lands, the panel lists roster snapshots and correlations from the
   entries these readers already use, and the fallback copies become dead weight to delete.
   Trending waits for a registry entry (§7).

## 9. Targeted runs, round 2

One at a time, each on its own `mktemp` DB, `SCHEDULER_DISABLED=1`, tree `5db13863`
(`41ef5658` only adds the registry-wins file and removes the redundant gate; both S-18
files were re-run there):

```
test/hand-fed-table-states.test.js      10 pass 0 fail   (41ef5658)
test/hand-fed-registry-wins.test.js      3 pass 0 fail   (41ef5658)
test/bluff-detector.test.js              3 / 0
test/manager-data-pipeline.test.js      27 / 0
test/valuation-map.test.js              47 / 0
test/wiring-absent-states.test.js        6 / 0
test/data-freshness*.test.js (6 files)  45 / 0
test/asset-cache-stamps.test.js          5 / 0
test/asset-universe-fingerprint.test.js  5 / 0
test/ceiling-lineup-recency.test.js      6 / 0
test/draft-lookahead-variance.test.js   12 / 0
test/decision-leftovers-home-away.test.js 5 / 0
test/nflverse-attribution.test.js        4 / 0
test/trade-manager-read.test.js         20 / 0
test/find-trades.test.js                 3 / 0
test/manager-signals-api.test.js        27 / 0
```

RED 2 (`edcaa018`: tree `eb8b0072` plus the new test file): 10 tests, 4 pass, 6 fail, exit 1.
Failing assertions: case 2 `freshness.servedTableEntry is not a function`; case 3 "the rule
asks for a snapshot of the season being played; a new season with none is stale, with no
write" (`'fresh' !== 'stale'`); case 4 `'roster_history' in r` true, expected false; case 5
`'roster_history' in held` true, expected false; case 6 note without the caveat (the 8-day
rule called the 2025-only rows fresh); case 10 `servedTableEntry is not a function`.

`npm run check` was not run; the task reserves it for the Gate phase.
