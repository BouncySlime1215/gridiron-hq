# Independent Draft Room Release Review

Review date: 2026-08-23 (America/New_York)

## Publication update

Codex subsequently fixed and verified the draft-geometry validation, completed-draft pick rejection, completed-draft UI lockout, initial-load error state, mock pause-clock behavior, and prevention of local auto-picks in `live_tracking` drafts. The incomplete offline player pool and K/team-DEF representation described below remain open and are assigned to Claude in `CLAUDE_FEEDBACK.md`.

Scope: review only. No application code was changed. I inspected the Draft Room UI, API routes, SQLite schema/seed, build and startup scripts, current database contents, Git history/status, and available test coverage. Per instruction, I did not create picks or mutate a disposable draft after switching to review-only mode.

## 1. Critical problems that could block today's draft

### A. A standard draft can run out of players and mock drafting can stall around pick 101

This is reproducible from the currently seeded local database:

- `ranking_entries`: 100 rows
- `player_metrics`: 0 rows
- fantasy-relevant players: 10 QB, 33 RB, 52 WR, 5 TE, **0 K, 0 DEF**
- A default draft is 12 teams x 16 rounds = 192 picks.

The fallback in `GET /api/drafts/:id` only appends `computeConsensus()` players (`server/routes/drafts.js:209-220`). `computeConsensus()` only returns players having `ffc_adp` or `sleeper_rank` metrics (`server/routes/aggregates.js:199-225`). With the current database's zero `player_metrics` rows, that fallback is empty, leaving only the 100-player seed board.

The CPU pool has the same 100-player base. Its late K/DEF fallback requires `fantasy_relevant = 1` (`server/routes/drafts.js:34-40`), but the seed only marks players appearing in `DEFAULT_BOARD` fantasy-relevant (`server/db/seed/index.js:46-61`), and that board contains no K or DEF (`server/db/seed/players.js:71-98`). The seed also models individual defenders rather than team-defense (`DEF`) player records.

Impact:

- A 10-, 12-, or larger-team draft with normal roster depth can empty the board before completion.
- Mock CPU drafting can return `no players left`, after which the Draft Room's effect repeatedly schedules another CPU attempt without advancing the draft (`client/src/pages/DraftRoom.tsx:62-66`; `server/routes/drafts.js:265-267`).
- The user cannot select a K/DEF from Best Available because none are returned. The position filters also omit K and DEF (`client/src/pages/DraftRoom.tsx:221-224`).

Recommended same-day fix: ensure the server always constructs a complete draftable fallback pool independent of a successful live-data sync. Include all appropriate fantasy-relevant QB/RB/WR/TE/K players and add explicit team DEF draft entities (or deliberately disable DEF roster targeting if this app does not model team defenses). Verify the pool has at least `team_count * rounds` unique players before starting/simulating a draft, and make a `no players left` response stop/reveal a clear error rather than loop.

### B. Draft creation accepts invalid league geometry and the pick endpoint accepts picks after completion

The UI number inputs have no minimum/maximum bounds (`client/src/pages/Drafts.tsx:36-46`), and `POST /api/drafts` validates only that a name exists (`server/routes/drafts.js:177-182`). Values such as zero teams, zero rounds, or a `my_slot` outside `1..team_count` can produce invalid snake calculations or a Draft Room in which the user never gets a turn.

Separately, manual `POST /api/drafts/:id/picks` calculates and inserts the next pick without checking `team_count * rounds` (`server/routes/drafts.js:231-247`). The client hides the normal on-clock banner after completion, but Best Available remains interactive (`client/src/pages/DraftRoom.tsx:216-262`), so an extra click can persist pick 193+ and corrupt the completed board/roster state.

Recommended same-day fix: validate `type`, `team_count`, `rounds`, `my_slot`, `ranking_set_id`, and `pick_seconds` server-side; add matching UI bounds; reject manual picks when the draft is complete; disable all pick actions after completion.

## 2. Problems that are important but not urgent

### A. Critical Draft Room actions do not surface API errors or prevent duplicate clicks

`pick()` and `undo()` await the API without `try/catch`, user-visible error state, or a busy guard (`client/src/pages/DraftRoom.tsx:80-89`). Pick buttons remain enabled during requests. A double click/race can result in one successful pick and one rejected request, with an unhandled promise rejection and ambiguous UI feedback. The server maps every insert error—including an invalid/missing `player_id` foreign-key failure—to `player already drafted` (`server/routes/drafts.js:240-245`).

Recommended fix: add a single mutation-in-progress guard, disable pick/undo/sim buttons while active, show API errors, and distinguish invalid player, duplicate player, and completed draft errors server-side.

### B. Initial Draft Room load errors look like an endless load

`useApi` exposes `loading` and `error`, but Draft Room ignores both and renders `Loading draft…` whenever `draft` is null (`client/src/pages/DraftRoom.tsx:21,102-104`). A missing draft, server error, or failed API request therefore appears to load forever.

Recommended fix: render a clear error/retry state before the null-draft loading fallback.

### C. Auto-pick timer closure/dependency is fragile

The zero-second effect calls `pick()` but only depends on `secondsLeft` and `myTurn` (`client/src/pages/DraftRoom.tsx:91-93`), omitting `rec`, `draftOver`, `id`, and the function reference. It will usually work because the timer ticks cause rerenders, but this should be made explicit and guarded against repeated submission while a pick is in flight.

### D. No automated tests cover the release-critical Draft Room flow

There are no test/spec files for the client or Draft Room API. The only file matching test terminology is `server/services/backtest.js`, which is model backtesting rather than an application test suite. `package.json` has no `test` or `typecheck` script (`package.json:9-17`).

Recommended fix after today's draft: add API integration tests using an isolated temporary SQLite database, plus a focused UI test for load, mark-taken/draft, roster update, undo, reload persistence, CPU turn progression, and completed-draft lockout.

## 3. Build and test results

- Git state at the beginning of the review: clean; no staged or unstaged application changes. (This may change while Claude Code continues working in the main checkout.)
- Install: `npm ci` passed; 258 packages installed.
- Production build: `npm run build` passed with Vite 6.4.3; 79 modules transformed; output generated under `client/dist`.
- Startup: direct production server start passed after local-port permission was granted. It logged `Gridiron HQ listening on http://localhost:5197` and served from the built client configuration.
- Seed/database initialization: passed; current database contains 32 teams and 416 player rows.
- Read-only API smoke data: `/api/teams` returned 32 teams and `/api/players` returned 416 players.
- Automated tests: none are configured, so no test suite could be run.
- Full draft lifecycle test: not completed in this review. A meaningful create/pick/undo/reload/CPU/completion test writes draft state to SQLite, and the user explicitly asked for no modifications while Claude is working. This must be run with a disposable database or temporary DB-path override before release.
- `npm start` launcher itself was inspected but not invoked because it opens a GUI browser. Its underlying server path was started successfully. The launcher polls `/api/teams` and opens port 5177 (`scripts/start.mjs:24-43`).

## 4. Exact files that likely need changes

Same-day critical fixes:

- `server/routes/drafts.js`
  - Build a sufficiently large, deterministic fallback pool.
  - Handle K/DEF strategy consistently.
  - Validate draft creation fields.
  - Reject manual picks after the configured final pick.
  - Return a terminal/error state when the pool is exhausted.
- `server/db/seed/index.js`
  - Mark the intended draftable late-round players as fantasy-relevant, or otherwise seed a complete fallback pool.
- `server/db/seed/players.js`
  - Extend the board beyond 100 players and decide how team DEF entries are represented.
- `client/src/pages/Drafts.tsx`
  - Add valid bounds and client-side validation for team count, rounds, and pick slot.
- `client/src/pages/DraftRoom.tsx`
  - Disable picking after completion.
  - Stop CPU retry behavior on pool exhaustion and show a blocking message.
  - Include K/DEF filters if those positions are supported.

Important follow-up fixes:

- `client/src/pages/DraftRoom.tsx` (mutation busy/error state and initial-load error state)
- `server/routes/drafts.js` (precise validation/error responses)
- `package.json` plus new isolated API/UI test files (test and typecheck scripts)
- `server/db/index.js` or a DB configuration module (allow a temporary database path for safe integration tests)

## Required verification after Claude finishes

1. Review Claude's final diff and ensure it addresses the pool-exhaustion/K/DEF decision without undoing the persistence and no-flash improvements.
2. Run `npm ci` and `npm run build` from the final tree.
3. Start the production server through `npm start` or the same underlying launcher path.
4. Against a disposable database, create a 12-team, 16-round mock from a non-edge slot (for example slot 7).
5. Verify initial CPU picks stop exactly at the user's turn; make a user pick; confirm snake slots around the round 1/2 boundary.
6. Reload the Draft Room and restart the server; confirm all picks and the user's roster persist.
7. Undo one CPU pick and one user pick as applicable; verify the board, available list, and roster all recover correctly.
8. Simulate to pick 192 and verify the draft completes with 192 unique players, including the intended K/DEF behavior.
9. Confirm pick 193 is rejected and all Draft buttons are disabled after completion.
10. Create a live tracker and mark several other teams' players taken, then make the user's pick; verify team-slot assignment and roster ownership.
