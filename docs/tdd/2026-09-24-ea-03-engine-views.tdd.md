# EA-03 (cloud unit EA-04): snapshots, views, status and the client hook

Unit: the **EA-03 row** of ENGINE-SPECS.md ("snapshot + views + status + client hook",
amends UI-ENG-6, folds HEALTH-01b), launched as cloud unit **EA-04**. The EA-04 *row* in
ENGINE-SPECS.md is "outcomes as events + the grader"; that is not built here. See §6.
Base: PR #242 head `75785e2` (EA-02 daemon, on the EA-00 spine). Not statistical: it fits
nothing and serves no new number, so there is no pre-registration and no holdout look.

## 1. Audit: extend or build

| Question | Where | Result |
|---|---|---|
| Who publishes snapshots? | `daemon/snapshots.js`, `daemon/tick.js:228-241` (EA-02) | Already there: one per league, only when every producer of that league's DAG finished the tick; a failed league keeps its previous snapshot. Reused unchanged. |
| A reader for rows at a cut? | `state.js:298` `getState` | Has `version`, `maxId`, `includeFailed`: enough for §4.6 resolution. Reused unchanged. |
| Typed status logic | `routes/engine.js` `statusOf` (EA-00) | Moved into `services/engine/status.js` `rowStatus` so `/state` and `/view` share one definition. `/state` behaviour unchanged (spine RED (8) still passes). |
| Freshness | `fields.js` `freshAt` | Reused: freshness from `engine_runs`, memoised per (producer, league) per view call. |
| Client fetch / test pattern | `client/src/api.ts` `api`, `test/start-sit-gate-panel.test.js` | `api` is the only transport; TSX compiled with the repo's TypeScript and rendered with `react-dom/server`. |
| `DesignSystem.tsx` `Provenance` / `Confidence` | `client/src/components/DesignSystem.tsx` | Not in this tree. `EngineValue` prints `producer@version` itself. |

## 2. RED / GREEN

Command: `node --experimental-test-module-mocks --test test/engine-views.test.js test/engine-client.test.js`
(with the `npm test` env: temp DB, `SCHEDULER_DISABLED=1`, the offline guard).

- **RED** `c4df288` "test: RED - engine snapshot, views, status and client hook": 15 of 15 fail,
  each on its missing piece (`server/services/engine/views.js does not exist`,
  `client/src/engine/useEngineView.ts does not exist`, ...).
- **GREEN**: 15 of 15 pass. Changes to the tests after RED, all listed:
  1. RED (8) grepped the source text for `daemon/`, which matched the module's own comment
     "imports nothing from engine/daemon/". The test was wrong (it meant imports): it now
     greps `from '...daemon/`.
  2. Mutation sweep additions (§3): M2, M4 and M11 survived the first sweep. Added: a
     snapshot recording `fx-proj@1` after `@2` wrote still serves `@1`; a same-version row
     written after the cut is invisible; a snapshot with no NFL week types the week rows
     `unknown` ("snapshot N has no season"). The last one found a real bug: `/view` threw
     (500) on a weekless snapshot, which EA-02 says happens once every game is final. Fixed
     in `views.js`; RED (6) then publishes one more league-91 snapshot so RED (7)'s "newest
     snapshot" is a normal one.

| RED | Test | What it pins |
|---|---|---|
| (1) | `engine-views` RED (1) | `week` and `league_week` at one snapshot id: the shared `nfl.week` row is byte-identical; `week` enumerates the week's games at the cut |
| (2) | RED (2) | an older snapshot serves its own version (`fx-proj@1`), its own cut, and its own `fallback_set`; a fallback put in force later does not leak back |
| (3) | RED (3) | HEALTH-01b: failed newest row → declared fallback (`fallback_used`, reason names the failed check); no fallback → `last_good` "last good, 60 min old"; neither → `unknown`; no failed value or failed health is ever in a view |
| (4) | RED (4) | a row 2 h old with max_age 1 h is `stale` (age 120 min); after a run 5 min before the next snapshot that wrote nothing, the same row reads `ok`, `fresh_at` = the run |
| (5) | RED (5) | every row carries status, reason, value, fallback_used, producer@version, as_of, health, reason_chain, fresh_at, state_id; the status set is exactly the 8 typed words |
| (6) | RED (6) | `pinSnapshot` (Coach): two views read at one id although a newer one was published between them; a new pin takes the newest |
| (7) | RED (7) | routes: `/snapshot` shape and typed absence, `/view` needs `snapshot_id`, refuses another league's snapshot and non-members (403), 404 on an unknown view; `/status` heartbeat 50 min → `stale`, fallbacks per producer, Jev `unknown`; `/request/:id` status, 404 for another user's request |
| (8) | RED (8) | grep: only `client/src/engine/useEngineView.ts` names an engine route on the client; no route/view/status module imports the daemon |
| C1-C3 | `engine-client` | mocked fetch: two views = one `/snapshot` call and one id; a new id moves every view; three status reads = one `/status` request |
| C4 | C4 | `EngineValue`: 8 statuses render 8 different texts, each with its own `data-engine-status`; unknown is "not computed yet (reason)", never 0 or a dash; an unrecognised status (`failed`) never shows its value |
| C5 | C5 | `ReasonChain`: every contribution with its signed delta, as stored |
| C6 | C6 | UI-ENG-6 strip: heartbeat 50 min old → red, "50 min ago"; "fx.points fallen back to fx.points_base (reason)"; Jev unknown → "Jev not live", never "$0.00"; live $0 → "$0.00" |
| C7 | C7 | UI-RED 1: none of the five files calls `fetch(` or `useApi(`; only the hook calls `api(` |

## 3. Mutation sweep

Each mutant applied alone, the file's test run, the file restored. 12 of 12 caught after
the §2 additions (M2, M4, M11 survived the first sweep).

| # | Mutant | Caught by |
|---|---|---|
| M1 | serve the failed row (skip the HEALTH-01b branch) | RED (3) |
| M2 | ignore the snapshot's version set | RED (2) |
| M3 | ignore the snapshot's fallback set | RED (2) |
| M4 | ignore the id cut | RED (2) |
| M5 | freshness from the row only, not `engine_runs` | RED (4) |
| M6 | read today's `engine_fallback` instead of the snapshot's set | RED (2) |
| M7 | last good wins over the declared fallback | RED (3) |
| M8 | client: no memo on `/snapshot` | C1 |
| M9 | `EngineValue` shows the value for an unknown status | C4 |
| M10 | strip shows `$` for Jev unknown | C6 |
| M11 | a missing template value read as "null" | RED (6) |
| M12 | `/view` accepts another league's snapshot | RED (7) |

## 4. Benchmark

`resolveView` on a 300-row view (the §3.5 ceiling), synthetic data, Node v22.22.2, this
container; 25 calls each.

| state rows | median ms | p90 ms | first call ms |
|---|---|---|---|
| 6,000 (20 per key), before the per-call memo | 35.4 | 40.5 | 42.2 |
| 60,000 (200 per key), before the per-call memo | 30.7 | 41.2 | 46.9 |
| 6,000 (20 per key), with the memo (head) | **14.9** | 16.5 | 17.9 |
| 60,000 (200 per key), with the memo (head) | **15.9** | 22.0 | 28.8 |

Budget (§3.5): view resolution ≤ 50 ms server. The script is not committed (scratch).

## 5. What is not built

- `POST /api/engine/request` (the page's way to queue a rescore). The EA-03 row lists only
  `GET /request/:id`; the insert belongs with the first request kind (EA-06 `rescore`).
- Mounting. ~~`SnapshotProvider` and `EngineStatusStrip` are not mounted in `App.tsx`.~~
  Done by FIX-257-1 (section 7), behind a default-off flag. `EngineValue` and `ReasonChain`
  are still rendered by no page (EA-07); their accept-list entries say so.
- Views beyond `week` and `league_week`. `my_team`, `start_sit`, `trade_lab`, ... arrive
  with the fields they read (EA-07).

## 6. Unit label

The task named "EA-04" and described the snapshot/view/hook layer. ENGINE-SPECS.md's EA-04
row is the outcome adapters + grader (depends on EA-02 and #174); its EA-03 row is the
layer described. This PR builds the described layer against the EA-03 row's RED list.

## 7. Review fixes (FIX-257-1, FIX-257-2), 2026-09-24

Branch merged with `origin/main` first (merge commit, 182 commits; one conflict in
`docs/wiring/annotations.json`, both sides kept). `npm ci` before every number below.

**FIX-257-1: strip mounted behind a flag, tap opens a per-producer sheet.**
- Flag `GRIDIRON_ENGINE_STRIP`, read only in `server/services/preview-mode.js#engineStripFields`
  (sweep ruling 8): off by default, on for `=1`, on under preview mode with `preview: true`
  and the off-reason. The client learns it the way the number-health card does: the
  feature's own endpoint carries it. `GET /api/engine/status` adds `strip`; the status
  itself is served either way.
- `/status` producer rows gain a typed `health` (`ok | fallback | error | unknown`, worst
  first: `status.js#producerHealth`), `reason` (the failed run's error text, the fields on
  fallback, or "has never run here") and `age_sec`.
- `App.tsx` mounts `<SnapshotProvider key={pathname}><EngineStatusStrip /></SnapshotProvider>`
  right under `DataFreshnessBanner`, keyed by path so the heartbeat age is read once per page.
- The strip renders nothing while loading or when the flag is off; says "engine status
  failed: ..." on a failed read (as the number-health card does); shows a "Preview" label
  when on only because of preview mode. It is one button (`aria-haspopup="dialog"`); a tap
  opens the DesignSystem `Sheet` with one row per producer (`EngineStatusSheet`), and
  DesignSystem `EmptyState` when none are registered.

**FIX-257-2: engine components on the design system.**
- `ReasonChain` draws contributions with `DriverBars`. `DriverBars` gains two optional props
  (`format`, `showTotal`), defaults unchanged: the chain passes a formatter that prints
  deltas as stored (-1.25 stays -1.25, never re-rounded to -1.3) and `showTotal={false}`
  (the client derives no total from engine values). A contribution with no delta is listed
  as text, never drawn as a 0 bar. The residual line is unchanged.
- `EngineValue`'s source line is `Provenance` (source `producer@version`, as-of, version).
  Every typed status (C4's eight kinds) renders as before.

**Tests.** RED commit, then GREEN. Command (the `npm test` environment on three files):
`GRIDIRON_DB_PATH=<tmp>.sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs'
node --experimental-test-module-mocks --test --test-concurrency=1 test/engine-client.test.js
test/engine-views.test.js test/preview-mode.test.js`

| | tests | pass | fail |
|---|---|---|---|
| before (merge commit, pre-RED) | 18 | 18 | 0 |
| RED | 26 | 17 | 9 |
| GREEN | 26 | 26 | 0 |

RED failures, each for the missing behaviour: C5 (row order), C8-C12, RED (9), and both
preview-mode flag tests. New: C8 flag gating, C9 sheet, C10 App mount, C11 DriverBars,
C12 Provenance (test/engine-client.test.js); RED (9) `/status` flag + typed producer rows
(test/engine-views.test.js); the flag and its single-reader grep (test/preview-mode.test.js).

Two test edits, said out loud:
- C5 now reads `starter out +2.5` rather than `+2.5 starter out`: DriverBars puts the label
  before the value. The claim is the same (every contribution with its signed delta, as
  stored); C11 adds that -1.25 is not re-rounded.
- C11's "a null delta is not drawn as 0" regex was wrong in the RED commit (`\+0\b` also
  matched the residual `+0.25`); GREEN narrows it to a bare `+0` / `+0.0`.
C6's fixture gains `strip: { enabled: true }`, since the strip is now flag-gated.

`npm run typecheck` 0, `npm run build` ok, `npm run check:wiring` exit 0. The wiring
accept-list loses 18 entries that silence nothing now (15 EA-02 daemon modules that main's
map now counts as wired, plus the hook, provider and strip, mounted here); EngineValue's
and ReasonChain's entries are reworded (rendered by no page until EA-07).

**UI-RED 6 screenshots** (`docs/evidence/ea-04/`, script `capture.mjs` beside them):
headless Chromium over CDP against the local server from this worktree (built client,
scratch database, `SCHEDULER_DISABLED=1`, preview mode on so the flag is on), page `/news`,
ESPN connect modal dismissed. `/api/engine/status` is answered per state by request
interception (fixture payloads, no real names); `-real` is the server's own answer.
- `ea-04-strip-<state>.png` and `ea-04-sheet-<state>.png` for normal, empty, thin
  (stale heartbeat, one producer failed, one on fallback, one never run), mobile (375 px),
  dark, real; `ea-04-strip-error.png` only (a failed read has no sheet to open).
- `scrollWidth` = viewport width in every shot (375 at 375 px: no horizontal scroll).
- Dark: the app has no dark theme (no `dark:` classes anywhere in `client/src`), so the
  `prefers-color-scheme: dark` shots are identical to normal. Not fixed here: a dark theme
  is app-wide work, not this unit's.
