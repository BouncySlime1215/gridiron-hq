# TDD evidence: infra-essentials (WA phase 1, [WA-ess])

Source: the WA brief (items 1-6) and section 00 / Q of `docs/FANTASY-ENGINE-MASTER-PLAN.md`
(weekly roster snapshots, launcher `spawn node ENOENT`, `weekly-learning` retrain, chat
failure logging, `.env.bak-*`). Journeys were derived during this run. The gates were
written before any code or test ran, in
`scratchpad/wa/infra-essentials/GATE.md` (G1-G7); the weekly-retrain rule's gate is also in
the code comment on `coverageCheck`. Experiments ran on a `VACUUM INTO` copy of production
taken 2026-09-18 11:17 EDT. Production `server/data.sqlite` was not written. The web server
on 5177 was not restarted. LLM spend: $0.

Runner (every JS command below):

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      --test-concurrency=1 <file>

Python: `python3 -m unittest discover -s scripts/chat -p 'test_*.py'`.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `scripts/refresh-live-data.mjs` | Importing it ran a whole tick and `process.exit(0)` (found by the RED run: 0 tests reported). No manager-signals step. No sync_log row for the chat step. `nfl_weekly_learning` not in the allowlist, and the server runs with `SCHEDULER_DISABLED=1`, so nothing had run it since a manual run at 2026-09-17 18:59. `league_tx` printed `ok` when every league failed. | **Extend**: import-safe steps, manager signals (staleness-aware), roster snapshots, chat status -> sync_log, weekly learning on the allowlist, honest `league_tx` label. |
| Roster history | `leagues.payload` is overwritten every hourly sync; nothing kept lineups. ESPN still serves a completed period's final lineups (probe: league 4, period 1). | **Build new**: migration 058 + `scripts/collect-roster-snapshots.mjs`. |
| `scripts/launcher.mjs` | The logged `spawn node ENOENT` came from a bare `node`; the repo copy already used `process.execPath`, but: an unhandled child `error` crashed the service; the app it starts inherited launchd's env (no `SCHEDULER_DISABLED`); `client/dist` was never rebuilt; `process.execPath` under launchd is the version-specific Cellar path (`/opt/homebrew/Cellar/node/25.9.0_1/bin/node`), deleted by a brew upgrade; the key was printed into the world-readable launcher log. | **Re-engineer** the start path; the service shape (key, /health, /start, /status) is kept. |
| `scripts/start.mjs` build check | Correct, but private to start.mjs. | **Extract** to `scripts/client-build-check.mjs`, used by both (one source). |
| `weekly-learning.js` | fdf2e2f keeps the early key and restricts fitting and grading to rows where the vector is live (4 tests exist). Still missing: the coverage band [0.78, 0.82] is absolute while the served model's own coverage is 0.775-0.783 (e8174cc). | **Extend**: `coverageCheck` (relative to the champion, player-clustered). |
| `extract_league_chat.py` | 18 `jev_chat_done` rows with `ok = 0` (15 x `"tone" did not select a highest-probability option`, 3 x `"topic"`); the classifier exits 0, the loop logged `ok`. | **Extend** (failure logging only): loud line + status line; still never re-sent. |
| `.env.bak-1789684789` | Key names: all 4 are in `.env` (which also has `ANTHROPIC_WORKSPACE_ID`). | Left on disk for Nick to delete (this agent does not delete files). |

## RED -> GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | 229bffe | roster-snapshots and launcher: module not found (collector, shared check missing). refresh-loop-steps: 0 tests reported, because importing the loop ran a real tick and exited (side effect of that run: one incremental chat extract with 0 new rows and a rollup, the same as a loop tick; no classifier call, $0). weekly-retrain-coverage 5 of 6 fail: a candidate with MAE 0.0000 vs 4.3644 rejected at coverage 0.775, the champion's own. Python 4 of 17 fail (no status line, no warning). |
| GREEN | bdfafda | roster-snapshots 14/14, refresh-loop-steps 16/16, launcher 18/18, weekly-retrain-coverage 6/6, Python 17/17. |
| RED | 40eedfd | launcher 3 of 21 fail: sandbox boot resolved node to the Cellar path; node resolved once at boot. |
| GREEN | c1ab923 | 21/21; sandbox launcher boots with `/opt/homebrew/bin/node`. |
| RED | 6633fe4 | refresh-loop-steps 1 of 17 fails: `nfl_weekly_learning` not on the loop. |
| GREEN | cf6ae18 | 17/17. |
| RED | 9b58238 | refresh-loop-steps 1 of 18 fails: `league_tx ok ... failed 5`. |
| GREEN | bc9cd7d | 18/18. |
| RED | 54f6fa9 | launcher 1 of 22 fails: the service's HTTP layer could only run with the real key. |
| GREEN | e522a84 | 22/22. |
| RED | 644351c | roster-snapshots 2 of 15 fail: no pregame status column (plan 00 item 5, "no history of ESPN pregame statuses"). |
| RED | 91c03e1 | Fixture made to send what ESPN sends (entry-level `injuryStatus` is 'NORMAL' on all 755 rostered entries; the real status is the player's). 2 of 15 fail: the collector read the entry-level field; on the copy 0 of 755 rows had a non-normal status. |
| GREEN | c2e2bad | 15/15; player-level status and `pregame_injury_status` (last capture before the lock, held after kickoff and through the final boxscore). |

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | Migration 058 creates `league_roster_snapshots` + index; down() drops them | `roster-snapshots: G2a` | unit | PASS |
| 2 | Live capture: slot, starter flag, this period's projection and actual (never a season total or last season), our player id | `roster-snapshots: G2 live capture` | integration | PASS |
| 3 | Same payload twice: 0 writes, every row identical | `G2b` | integration | PASS |
| 4 | Slot change updates one row; dropped player kept with on_roster 0; add inserted | `G2c` | integration | PASS |
| 5 | Pre-draft fallback payload never captured | `G2d` | integration | PASS |
| 5b | ESPN status is the player's; the status carried into kickoff is kept after the lock and through the final boxscore; a player first seen locked has none | `G2 pregame status` | integration | PASS |
| 6 | Completed period finalized once from the boxscore; starters sum to ESPN's score; next tick fetches nothing | `G2e` (4 tests) | integration | PASS |
| 7 | Network failure: live kept, sync_log partial with reason, no credential in the log; script exits 1 | `G2f` (2 tests) | integration + e2e | PASS |
| 8 | Loop order: league_tx -> roster_snapshots -> league_chat -> manager_signals | `refresh-loop-steps: G1a/G2h` | unit | PASS |
| 9 | Manager signals: exact hand-off spawn; fresh while inputs unchanged (< 6 h); rerun on change, failure, age, unreadable key; spawn failure -> sync_log | `G1a`-`G1c` (7 tests) | unit | PASS |
| 10 | Inputs key moves with a league sync, a transaction decision, an identity edit, a new classifier label; not with the per-tick last_seen_at re-stamp | `G1b` (2 tests, real DB) | integration | PASS |
| 11 | league_chat -> sync_log: partial while failures outstanding, error on failed run or no status line, ok when clean | `G5c` (5 tests) | unit | PASS |
| 12 | `nfl_weekly_learning` is on the loop, after `nfl_lines`; every allowlisted job exists | `G4` | unit | PASS |
| 13 | `league_tx` logs ERROR when the collector reports failed leagues | `league_tx` | unit | PASS |
| 14 | Node binary always absolute + executable; stable path before the Cellar path; bare/missing NODE_BIN never bare | `launcher: G3a` (5 tests) | unit | PASS |
| 15 | App env has SCHEDULER_DISABLED=1 and node's dir first on PATH; real spawn under launchd's PATH exits 0 | `G3b`, `G3d` | unit + real spawn | PASS |
| 16 | Start: stale -> build then server; fresh -> server; running -> nothing; spawn error reported; one at a time; failed build serves the previous build, or fails cleanly with none; node re-resolved per start | `G3c` (10 tests) | unit | PASS |
| 17 | Import opens no port; service: /health open, the rest needs the key, status shows the start phase, key never logged | `G3e` (3 tests) | unit + real HTTP | PASS |
| 18 | Shared build check: missing / fresh / stale (deep file edit), no marker = stale; start.mjs uses it and parses | `G3c`, `G3e` | unit | PASS |
| 19 | Coverage-equal candidate (0.775) with much better MAE is promoted | `weekly-retrain-coverage: G4b` | integration | PASS |
| 20 | Coverage moved significantly away from 0.80 (below or above) still rejected; inside the band never rejected; no intervals fails | `G4c` (4 tests) | unit + integration | PASS |
| 21 | Simulation at 0.778: old band rejects null 0.545, new rule 0.025, harmful caught 1.00 | `G4d` | simulation | PASS |
| 22 | ok=0 failures reported loudly each run, never re-sent; one status line always, also before a failing exit | `test_extract_league_chat.py: TestClassifierFailures` (4 tests) | unit | PASS |

## Gates on the production copy

| Gate | Result |
|---|---|
| G1d manager signals, real spawn | first call ok (351 ms; builder 212 ms), second call `fresh` (10 ms), a league sync change reruns it; signals per league 192 / 240 / 195 / 406 / 240 (same as the pipeline's report). |
| G2g roster snapshots, real ESPN | Final run (after the status fix, 058 rolled back and re-applied on the copy): 1,508 rows in 701 ms (+2.9 s one-time migration backup of the copy). Period-2 statuses ACTIVE 596, QUESTIONABLE 85, INJURY_RESERVE 16, OUT 5, DAY_TO_DAY 5, none 48 (D/ST, K); pregame status on 659 (the 49 Thursday players were already locked at the first capture). All 46 teams have period-2 live rows and period-1 final rows. Period-1 starters equal ESPN's week-1 score for 46/46 teams, checked against the league payload's own schedule (a different ESPN view). Second run: 0 writes, 0 fetches, 130 ms. |
| G3 launcher | 22/22 tests. Sandbox service on 5198 under `PATH=/usr/bin:/bin`: /health 200, wrong key 403, node `/opt/homebrew/bin/node`, key not in its log, nothing started. `npm run build` under the PATH the app child gets: exit 0 in 2.6 s (into a temp outDir; the live client/dist was not touched). |
| G4 weekly learning | 6/6 + early-carry 4/4. Job run off-server on the copy: week 2 today = capture refused (slate started), 1,183 pending, no retrain, 120 ms. Forced week 3: 1,183 pregame rows in 2.2 s, 400 MB RSS. |
| G5d league chat | Extractor on a copy of the chat DB, no `--classify`: status line `failed_outstanding: 18` (15 tone, 3 topic); the loop line reads `league_chat PARTIAL ... 18 failed classification outstanding (not retried automatically)`, sync_log `partial`. $0. |
| One tick on copies | Offline guard on, no scheduler jobs: `league_tx ERROR` (network blocked, as expected), `roster_snapshots ok 0 writes`, `league_chat PARTIAL`, `manager_signals ok`, 2 s. |
| G6 `.env.bak` | 4/4 key names present in `.env`. |
| G7 regression | weekly-retrain-early-carry 4/4, weekly-early-week-blend 19/19, snapshot-mode-migration 3/3, manager-data-pipeline 23/23, model-integrity 94/94, model-registry-persistence 22/22 (rolls 058 back), migration-027 16/16. Full suite (run while the pregame/status change was in progress; roster-snapshots re-run 15/15 after it): 2,553 tests, 2,511 pass, 3 fail, 39 skipped. The 3 failures are the known prop-CLV tests (#2083-2085, betting, pre-existing, WD). |

## Coverage (`--experimental-test-coverage`, own test file)

| File | Lines | Branches | Uncovered |
|---|---|---|---|
| scripts/collect-roster-snapshots.mjs (before the status change) | 96.1% | 70.2% | describe() output variants, the no-leagues/error summary paths |
| server/migrations/058_league_roster_snapshots.js | 100% | 100% | |
| scripts/refresh-live-data.mjs | 87.4% | 86.2% | `main()` loop (run for real on the copy) |
| scripts/launcher.mjs | 81.4% | 72.7% | `/start` page (would start a real app), `startTunnel` |
| scripts/client-build-check.mjs | 100% | 82.4% | |
| server/services/weekly-learning.js | new code covered; file 55% from this file alone (capture/settle/currentNflWeek are covered by other suites) | | |

## Known gaps and hand-offs

- Nothing here is live until the refresh loop restarts (it runs the 2026-09-17 17:17 code). Restart it
  in the same integration pass as the web server, not before: the manager-signals build rewrites every
  league's signals, and the running server's old counterparty code would read them with the latent
  perception double count (manager-data-pipeline verify). The first tick applies migration 058 (one
  ~700 MB backup), captures period 2 and finalizes period 1 for all 5 leagues from ESPN.
- The launcher service was restarted (`launchctl kickstart -k`) and runs the new code: /health 200,
  node `/opt/homebrew/bin/node`. The web server was not touched.
- Deadline outside this item: nothing ingests finalized weeks (`player_week_usage` week 2) while the
  server scheduler is off; `nfl_model_growth` last ran by hand on 2026-09-17. See the item report.
- A finalized period is read once from ESPN. Stat corrections ESPN applies later in the week
  are not picked up (small; the bench-points metric in WD can re-read a period if it needs to).
- The old launcher printed its key into `~/Library/Logs/gridiron-launcher/launcher.log`
  (world-readable) at every boot up to 2026-09-18; the new one prints only the key file's path.
  Those old lines are still in that log.
- The roster collector reads `leagues.payload`, which `league_rosters` refreshes hourly, so a
  lineup change made less than an hour before a lock can be missed in the live rows; the final
  boxscore read corrects it for completed periods. Pregame statuses carry the same up-to-an-hour lag.
