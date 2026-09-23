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

Not a statistical unit: it produces no model number, fits nothing and ran no
pre-registration. No look at the 2025 held-out season or 2026 forward weeks was
taken (holdout looks: none). Decision grading (rules d/e) does not apply: every
call on a card is made by its producer, which carries its own grade (WV-01 and
WV-02 in their own evidence files; lineupDiff's swap `p_right`).

## RED

`6053848f` — `test: RED — command center must list dead starters, streaming swaps, injury alerts and no-move nudges across leagues (SK-01)`

Against the stub service (every function returns empty): 9 of 9 fail. The
final test file (10 tests, after the assertion changes below) was re-run
against the same RED source: 9 of 9 then-present tests fail. First failing
assertion:

```
not ok 1 - RED fixture: an Out starter, a free streaming defense and an injured starter yield all three items
  + []
  - [ 'dead_starter', 'injury_alert', 'stream' ]
```

Second behaviour, own liveness: test 9 (WV-01 default-off) run against GREEN
`5658ba1b` before the fix `8df0c5b8`:

```
not ok 9 - WV-01 default-off: an all-null suggestion reads "default_off", not "present" and not an empty list
  expected: 'default_off'
  actual: 'present'
```

## GREEN

- `5658ba1b` — `feat: League Hub command center lists this week's dead starters, streaming swaps, injury alerts and no-move nudges across every league (SK-01)`
- `8df0c5b8` — `fix: command center reads WV-01's gated streaming suggestion as switched off, not as no better defense (SK-01)`
- `8eacfc56` — `test: pin that producers never receive the league cookie columns; show card tone stripes over .card's border (SK-01)`

`test/command-center.test.js`: 10 pass, 0 fail (command:
`GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/command-center.test.js`).

## What it does

- `GET /api/command-center` (`server/routes/command-center.js`, mounted in
  `server/index.js` behind `legacyAuthenticated`) returns, for the signed-in
  user's leagues only (`league_memberships`), `items[]` of
  `{league:{id,name}, kind, what, why, action:{label,href}, deadline, deadline_basis, deadline_guess, tone}`
  sorted by deadline (unknown last), plus `leagues[].sources` naming each
  check's state (`present`, `not_merged` + `waiting_on`, `default_off`,
  `error`, `unavailable`, `source_table_absent`, `not_collected`, `stale`,
  `no_team`, `not_synced`) and `empty_reason` (`no_leagues` / `nothing_due`).
- Kinds and their only source:
  - `dead_starter` — lineupDiff's list; why = the bench swap lineupDiff itself
    names (`swaps[].in.week_points`); deadline = his team's kickoff from
    `game_lines`.
  - `injury_alert` — WV-02 `injury_alerts`; why = its first same-team (else
    best free agent) replacement's `projected_ppg`; deadline = `claim_by`
    (zone flagged `guess`, as WV-02 flags it). A player already listed as a
    dead starter is listed once.
  - `stream` — WV-01 `suggestion` when `action` is `swap` or `add`; why =
    WV-01's own sentence with the implied points; deadline = the earlier
    kickoff of the added and dropped defenses.
  - `no_move` — `league_transactions_raw`: my team's `FREEAGENT`, `WAIVER`,
    `TRADE_PROPOSAL`, `TRADE_ACCEPT` rows with status `EXECUTED` or
    `PENDING` in `leagueCurrentWeek(lg)`'s scoring period = 0, only when the
    collection is under 24 h old (hand-set, `MOVES_FRESH_MS`); why cites the
    waiver board's best `immediate` claim (`upgrade`).
- Producers are called with an explicit column list (never
  `leagues.espn_s2`/`swid`); a producer that throws is logged in full and its
  source reads `error` with a plain sentence; the other checks still load.
- League Hub (`client/src/pages/LeagueHub.tsx`) shows
  `client/src/components/CommandCenter.tsx` above its tabs; nav is unchanged
  (8 tabs). Each card: what / why / one button that switches the active
  league and opens Start/Sit (`/lineup`). Checks that could not run are listed
  under the cards as "Not checked, so not shown as clear".

## The numbers (local copy, not production)

DB: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"`
at 05:20 ET 2026-09-23; leagues renamed `League <id>` in the copy for
screenshots. Script: `node live.mjs 1` (calls `commandCenter(1)` twice).

| Tree | Leagues | Items | Sources |
|---|---|---|---|
| `5658ba1b` (this branch) | 5 | 3 `no_move` (leagues 1, 3, 5) | dead_starters present:0 ×5; injury_alerts not_merged ×5; streams not_merged ×5; moves present 0/9/0/6/0 |
| probe: `8df0c5b8` + WV-01 + WV-02 merged (tree `cd1ab20e`) | 5 | 2 `injury_alert` (leagues 1, 3) + 3 `no_move` | injury_alerts present 1/0/1/0/0; streams default_off ×5 |

- Known-nonzero control for the moves count: leagues 2 and 4 count 9 and 6.
  Independent SQL on the same copy (`GROUP BY league_id, scoring_period, type, status`
  for my team) gives week 3: league 2 = 3 pending proposals + 3 executed
  claims + 3 pending claims = 9; league 4 = 1 accepted trade + 5 pending
  proposals = 6. Match.
- Zero dead starters in all five leagues is real on this copy
  (`lineupDiff(...).flagged_starters.length` = 0 each, same script run
  before the change); the fixture test is the known-nonzero case.
- Speed: first call 15.4 s (cold `assetUniverse` memo), 1.3 s warm
  (`coldMs`/`warmMs` in the same run). Per-league timing before the change:
  lineupDiff 38.4 s for the first league cold, 1.2–2.7 s after; waiverBoard
  0.2–0.7 s.

## Mutation sweep (on `8eacfc56`'s tree)

| Mutant | Result |
|---|---|
| M1 dedupe of dead starter vs injury alert removed | killed (#2) |
| M2 unknown deadlines sort first | killed (#4) |
| M3 move status filter dropped | killed (#5, #6) |
| M4 stale-collection check dropped | killed (#5) |
| M5 nudge fires on a stale read | killed (#3) |
| M6 call site: route passes no user id | killed (#6–#10) |
| M7 call site: `l.espn_s2` added to the league select | killed (#6) — survived before `8eacfc56`, which pins that producers never receive cookie columns |
| M8 missing streaming module treated as present | killed (#7) |
| M9 WV-01 gated suggestion read as present | killed (#9) |
| M10 dead-starter card ignores lineupDiff's bench swap | killed (#1) |
| M11 stream deadline = added defense's kickoff only | killed (#1) |
| S1 designed survivor, call site: `waiverBoard(lg, {})` without `myTeamId` | survived: the stubs ignore arguments; waiverBoard defaults to `lg.my_team_id` (`server/services/waiver-wire.js:159`), so the mutant is behaviour-equivalent too |
| C1 not-applied control (pattern absent) | not applied |

## Screenshots (375 px, local server from this worktree, local copy)

`docs/evidence/sk-01/`: `sk-01-375-normal.png` (the RED fixture's items plus a
nudge, served as a fixture payload), `-thin.png` (two checks not on this
build), `-nothing.png` (nothing due), `-error.png` (server error, retry),
`-real.png` (this branch on the local copy). `scrollWidth` = 375 in all five
(no horizontal scroll). One tap on "Open waiver wire in League 3" switched the
active league to League 3 and opened `/lineup` (checked in the browser pane).
Dark mode: the app has no dark theme on `131a7ba0` to screenshot.

## Known defects / not covered

- Speed: UI-STANDARD rule 8 (paint under 1 s from DB results) is not met on a
  cold server (15.4 s first call on the local copy). The route reuses a
  10-minute per-user cache and the page shows a skeleton; the fix is an engine
  job writing results to a table, a separate unit.
- An ESPN `OUT` (not IR, not season-ending) starter is not a dead starter on
  `131a7ba0`: lineupDiff counts only IR and `available === false`
  (`server/services/trade-engine.js:2861`). Until SS-01 lands, only WV-02's
  injury alert (out/doubtful) catches him. Fixed in review round 1 (below):
  once SS-01's `dead-starters.js` is on the build, the command center reads
  SS-01's list through `lineupCall(...).dead_starters.items` and stops calling
  lineupDiff, so Start/Sit and the command center show one list.
- Side effect inherited, not added: `lineupDiff` publishes to the Decision Inbox
  (`decision_recommendations`) for the user's own team; the command center calls
  it for every league, as the My team view already does for the active one.
- "This week" has two producers here: the producers use `tradeWeekContext()`
  (NFL week) and the moves count uses `leagueCurrentWeek(lg)` (ESPN scoring
  period). Both read 3 on the local copy; they can differ in a league whose
  scoring periods do not match NFL weeks.
- Reported to WV-01, not edited: `streaming-board.js` returns
  `unconfirmed_forward: enabled`, which reads true when the board IS enabled.
- `no_move` has no deadline until WV-02's `waiver_run` is on the build.
- Gameday inactives and trade ideas (queue row items) are not in this unit.

## Review round 1 (skeptic findings, fixed at `1fc77167`)

Commands: `GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/command-center.test.js`.
Tree: `73a0622d` (tests) + `1fc77167` (fix).

1. **Empty state stated zeros for checks that never ran.** Now the server
   returns `clear_checks` (`server/services/command-center.js#clearChecks`):
   the checks whose state is `present` in every league. The page
   (`CommandCenter.tsx#clearSentence`) states "0 ..." only for those; if none
   ran everywhere it says so, and the headline reads "Nothing found in the
   checks that ran" instead of "Nothing needs you this week". Tests 13
   (pure: not_merged, default_off, stale, not_synced, no leagues) and 14
   (route: injury alerts and streams not_merged in every league, with a
   known-present control on dead_starters). There is no client test runner in
   this repo, so `clearSentence` itself has no test; it only maps
   `clear_checks` to fixed phrases. `sk-01-375-nothing.png` still shows the old
   sentence (all-present fixture); not re-shot.
2. **Per-user cache and caller-chosen user.** The code was already right; the
   tests did not pin it. Test 15 fetches as nick with `?user=<stranger>`, then
   as nobody and as stranger without clearing the cache.
3. **SS-01 shape and producer.** SS-01 (origin/claude/local-ss-01-dead-starter-guard
   @edffd153) adds `dead_starters: { covered, starters_checked, items }` to
   `lineup-brain.js#lineupCall`, not to lineupDiff (`git diff
   origin/main...origin/claude/local-ss-01-dead-starter-guard --stat`: no
   trade-engine.js). The command center now detects `dead-starters.js`
   (dynamic import, same pattern as WV-01), then calls `lineupCall(lg.id,
   { myTeamId })` and reads `dead_starters.items`; lineupDiff is not called on
   that build. `covered: false` reads `unavailable`, never clear. Tests 11
   (SS-01's payload shape, copied from dead-starters.js#deadStarters at
   @edffd153) and 12 (route: lineupDiff not called, flagged_starters not read,
   SS-01's why and kickoff used).

RED: the 15-test file against `6de067ef`'s service: tests 11, 12, 13, 14 fail
(pass 11, fail 4). Test 15 passes on the old code (it pins behaviour that was
already correct) and is shown live by mutants U1 and C1 below.
GREEN at `1fc77167`: 15 pass, 0 fail.

| Mutant (tree `1fc77167`) | Result |
|---|---|
| U1 cache key `'everyone'` | killed (#15) |
| C1 route `commandCenter(req.query.user ?? req.auth.userId)` | killed (#15) |
| M12 clearChecks `every` -> `some` | killed (#13) |
| M13 SS-01 detection forced off | killed (#12) |
| M14 `covered: false` ignored | killed (#11, #12) |
| M15 `clear_checks` dropped from the response | killed (#14) |

Not run: a merged-tree probe of SK-01 + SS-01 on the local copy (SS-01 is not
on main). The SS-01 payload in the tests is a hand copy of its shape, not a
live call.

## Nick's five questions

1. **Well built?** One route, one service that only reads existing producers,
   15 targeted tests (10 at first review, 5 added in review round 1) with a mutation sweep (11 killed, 1 designed survivor,
   1 not-applied control); every absent input is a named state, not an empty
   list.
2. **Stats or made up?** No new statistic. Every number on a card is a
   producer's: lineupDiff's projections, WV-01's implied points, WV-02's
   replacement projections, the waiver board's upgrade, and a row count from
   `league_transactions_raw`. Hand-set: the 24 h freshness window and the
   10-minute cache; the waiver zone is WV-02's guess, labelled.
3. **How we know:** fixture tests (RED/GREEN above) and a live run on a local
   copy with a known-nonzero control for the moves count; no backtest, because
   it makes no prediction.
4. **Pointed anywhere else?** Reaches the League Hub only (above its tabs). The
   producers it reads keep their own pages (Start/Sit, My team).
5. **How it unifies:** one list across five leagues built from the same
   producers the per-league pages use, so a card and its page show the same
   number; the incumbent per-league producers were found by
   `grep -rln -e command-center -e commandCenter server client/src` (none)
   and the audit table above.

Defect or gap fixed: no cross-league list existed on `131a7ba0` (every fantasy
route is `/:leagueId/...`, `server/routes/trades.js`). Incumbent: per-league
`lineupDiff` / `waiverBoard`, by the grep above. Not covered: gameday
inactives, trade ideas, SS-01's guard. Would make it wrong: a producer whose
output shape changes (the feature detection reads field names), or a
transaction collection older than a day being treated as fresh.
