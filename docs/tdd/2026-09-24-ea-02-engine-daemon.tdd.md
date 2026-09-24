# EA-02: the engine daemon

Unit EA-02 (ENGINE-SPECS.md EA-02 row; ENGINE-ARCHITECTURE.md §0-5, §9.1-9.2, §11).
Base: PR #216 head `0a9b2455` (the EA-00 spine). Not statistical: it fits nothing, reads
no 2025 data and serves no number, so there is no pre-registration and no holdout look.

## 1. Audit: extend or build

| Question | Where | Result |
|---|---|---|
| Is there a daemon, a tick, cursors, snapshots? | `server/services/engine/` on `0a9b2455` | Tables only (075: `engine_runs`, `engine_cursors`, `engine_snapshots`, `engine_requests`, `engine_fallback`). No process writes them except `scripts/engine-backfill.mjs` (one run row). **Build.** |
| Adapters to reuse | `backfill.js:102` `ADAPTERS` | Reused unchanged; the daemon adds a cursor per stream around them (`daemon/cursors.js`). |
| Which source tables carry a usable watermark? | DDL: `collect-league-transactions.mjs:21`, `058_league_roster_snapshots.js`, `core-and-fantasy.js:154/484/682`, `067_outcome_ledgers.js`, `manager-signals.js:44`, `mlb-model-misc.js:655` | transactions `last_seen_at` (status changes are in-place updates); lineups `changed_at`; news `id`; lines `fetched_at`; injuries none (`modified_at` empty 2025-26) → `season*100+week`, latest week re-read; trade_outcomes `id` + `resolved_at`; signals `computed_at`; sync_log `last_run_at`. Unstamped updates (opening lines, news edits) → daily full sweep. |
| Is there a lock primitive? | `grep -rn O_EXCL server scripts` | None. New `server/services/process-lock.js`, shared with the refresh loop, outside `services/engine/` (the refresh job must not import engine code). |
| Current-week logic to mirror | `trade-engine.js:180`, `league-week.js:12`, `game-cutoff.js:19`, `gamescript.js:389` | `calendar`, `league`, `gamescript` producers; parity tests against `gameCutoff` and the `gameScriptFor` arithmetic. |

One number, one producer: the three producers write new fields (`nfl.week`, `game.cutoff`,
`league.week`, `game.script`) that nothing serves yet; the legacy functions keep serving,
unchanged. No page, route or served number changes.

## 2. RED / GREEN

Command: `GRIDIRON_DB_PATH=$(mktemp -u)/x.sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test test/engine-daemon.test.js`

- **RED** (commit `test: RED - engine daemon EA-02`, implementation stashed): 17 of 17 fail,
  each on its own missing piece (`daemon/tick.js does not exist`, `daemon/lock.js does not
  exist`, the refresh loop exits 0 without a lock, `timed out waiting for the first tick`).
- **GREEN**: 17 of 17 pass (≈3 s). Three runs in a row: 17/17, 17/17, 16/17 — the one failure
  was RED (5) asserting the ORDER in which two hook children finished within one tick, which
  is not determined. The test was wrong, not the code: it now compares the results as a
  multiset. No other assertion changed after RED, except a 20 s timeout on RED (13) so a
  regression fails instead of hanging (see mutant M10).

| RED | Test | What it pins |
|---|---|---|
| (1) | `RED (1)` ×2 | second lock refused "already running pid N"; dead pid taken over; a second daemon process exits 3 |
| (2) | `RED (2)` | a second pass over the same rows appends 0; cursors per stream; first pass `reconstructed`; the heartbeat never becomes coverage |
| (3), (4) | `RED (3), (4)` | 1 new transaction → 1 event, 1 call per learner; a throwing and a hanging learner are recorded in the heartbeat detail, the tick goes on |
| (5) | `RED (5)` | nightly once per local day after 03:00 ET; weekly once per final NFL week; nothing in a tick that lost the lock |
| (6)/(14) | grep | nothing under `server/index.js`/`server/routes/` imports `engine/daemon/`; the refresh job imports no engine code |
| (7) | `RED (7)` ×2 | stop mid-tick finishes the current source only, later cursors untouched; SIGTERM → exit 0, lock removed |
| (8) | `RED (8)` | the injury example: runs exactly `fx_avail`, `fx_sim` league 81 and 82; exactly two snapshots |
| (9) | `RED (9)` | a cycle refuses ("declaration cycle: a -> b -> c -> a"); so does an input no producer writes |
| (10) | `RED (10)` | unchanged inputs: 0 state rows, 0 events, 0 snapshots, no heavy run |
| (11) | `RED (11)` | a failed league keeps its previous snapshot and cursor; the next tick reruns it |
| (12) | `RED (12)` | a second refresh loop exits 3 |
| (13) | `RED (13)` | a hook child past its lease is SIGKILLed, the tick returns, the run row says "lease expired" |
| (15) | `RED (15)` | the supervisor restarts a SIGKILLed daemon, which takes over its stale lock |
| — | producers | `game.cutoff` = `gameCutoff` on 3 games; `game.script` = `gameScriptFor` pass/rush multipliers; `nfl.week` status/current; `league.week`; a second tick writes 0 rows |

## 3. Mutation sweep (each applied alone, whole file run)

| # | Mutant | Caught by |
|---|---|---|
| M1 | every league always dirty | (10) (8) (11); that run also failed (15), not reproduced since |
| M2 | publish a snapshot with nothing moved | (10) (8) (11) |
| M3 | publish for a league whose DAG failed | (11) |
| M4 | advance a heavy cursor on failure | (11) |
| M5 | fire hooks without the lock | (5) |
| M6 | every global row touches every league | (8) (11) |
| M7 | the daemon's own heartbeat read as coverage | (10) (8) (3), (4) (7) |
| M8 | a learner's error aborts the tick | (3), (4) |
| M9 | nightly twice a day | (5) |
| M10 | no SIGKILL past the lease | (13) (hung before the timeout was added; fails since) |
| M11 | never take over a stale lock | (1) (5) (15) |

## 4. Measured

`node scripts/engine-daemon-bench.mjs --ticks 5` (synthetic volume, Node v22.22.2, this
container): 8,145 events (5 leagues × 12 teams × 16 players × 3 periods, 4 seasons of lines,
1,500 injury lines, 500 transactions), 534 state rows.

| | ms |
|---|---|
| first tick (backfill pass + first writes) | 1,131 (producers 456) |
| steady tick, nothing changed, median of 5 | 348 whole tick; **cheap producers 171** (max 210): calendar 94, league 29, gamescript 62; 0 rows, 0 snapshots |
| one injury changed | 350 whole tick; 1 event; 0 snapshots (none of the three producers reads injuries) |

Not measured: the real local DB (42,922 events). This is a public-repo cloud session with no
copy of it; the numbers above are the synthetic volume only.

## 5. What this does not do

- No served number moves: no route or page reads the new fields or snapshots (EA-03 adds
  `/snapshot`, `/view`, `/status`).
- `league.rules` / `league.deadline` are not declared: no `league.settings` events exist
  until EA-04.
- The launcher runs the supervisor only with `GRIDIRON_START_ALL=1`; Docker/Fly are
  untouched (a deploy change is Nick's call). `start-all.mjs` starts the refresh loop only
  with `--refresh`, because `refresh.sh` blanks paid keys and this would not.
- Budgets are checked after a synchronous run returns: an overrunning producer is refused
  publication, not pre-empted.
