# Verification notes: G17-tests claims 208-216

All files read in full or in the relevant regions with callers/callees traced. Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard. Read-only throughout (no writes, no `npm test`, no db opened except via prior reads already shown in transcript — no data.sqlite touched by me at all in this verification pass; only static file reads and `node --check` on a migration file for syntax, plus inspecting installed node_modules).

## G17-tests#208 — package.json:14, npm test / live db — CONFIRMED (count overstated)

- package.json:14 confirmed verbatim.
- .github/workflows/ci.yml:79-82 confirmed: `SCHEDULER_DISABLED`, `NODE_OPTIONS: '--import ./test/offline-guard.mjs'`, `GRIDIRON_DB_PATH: '${{ runner.temp }}/gridiron-ci-fixture.sqlite'` exist only there.
- server/db/index.js:10 `const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite');` — confirmed: no read-only mode, defaults straight to the live file when the env var is unset.
- server/db/index.js:171-176 (`CREATE TABLE IF NOT EXISTS db_health_checks`) and :177-202 (quick_check / integrity_check + INSERT) confirmed as described.
- I enumerated every one of the 175 `test/*.test.js` files. 41 do not set `GRIDIRON_DB_PATH` in their own header. Of those, tracing imports (direct and one-hop through `server/services/*`), only **14** actually import `server/db/index.js` transitively and would therefore open the live database on a bare `npm test`:
  gridiron-model.test.js, nfl-audit-overview.test.js, nfl-drive-tape.test.js, nfl-team-strength.test.js, td-regression.test.js, teaser-leg-rates.test.js, contextual-coordinator.test.js, league-brain.test.js, nfl-advanced-depth.test.js, pick-reasoning.test.js, player-state.test.js, rookie-evidence.test.js, waiver-brain.test.js, weekly-trends.test.js.
  The other 27 "no-GRIDIRON_DB_PATH" files (scoring.test.js, spread-probabilities.test.js, port-guard.test.js, etc.) are pure-function tests with no db import at all — safe.
- Of those 14, exactly **1** (teaser-leg-rates.test.js:26) sets `GRIDIRON_DB_INTEGRITY_CHECK='off'`; the other 13 do not — this matches the claim's ratio (21/22) closely even though the absolute count (22) is inflated; the real count is 14/13.
- None of the 14 files themselves issue INSERT/UPDATE/DELETE (grep for INSERT INTO/UPDATE/DELETE FROM came up empty), but `server/db/index.js`'s own top-level import code can write: the legacy-schema migration check, `db_health_checks` upsert after `PRAGMA quick_check`/`integrity_check` (only "due" once per `GRIDIRON_DB_INTEGRITY_CHECK_INTERVAL_HOURS`, default 24h), and the one-time `espn_settings`→`leagues` backfill (idempotent after first run). On a live, previously-initialized database most of these are no-ops *except* the periodic integrity check, which — per the file's own comment — "last took 159 seconds on this 9.8 GB file" and does INSERT when due. That is a real, non-hypothetical contention risk against the concurrently-writing T-60 capture server described in this session's hard rules.
- Verdict: the specific numeric claim ("22 spec files") is overstated — the real number is 14 — but the underlying defect (no env guard exists outside CI; a bare `npm test` run locally today would open the live 9.8GB data.sqlite for several spec files, including one that runs a heavy periodic integrity check with a write) is real and verified. Severity P1 is justified by the live-capture-server context stated in this session, even though the blast radius is smaller than claimed.

## G17-tests#209 — test/offline-guard.mjs:23, fetch-only guard — CONFIRMED, and worse than the claim states

- test/offline-guard.mjs read in full (39 lines). Confirmed: only `globalThis.fetch` is wrapped (line 23-24); the fail-open path at lines 28-30 matches the claim's quoted comment exactly.
- Checked whether any *actual* external caller in this codebase uses node:http/https/net directly: only `server/platform/port-guard.js` touches node's networking primitives, and that's local port-availability checking, not a provider call. `server/services/odds-api.js:104` and `server/services/twitterapi-io.js:53` both call the global `fetch(...)`, so the guard does cover the app's own hand-written HTTP clients today.
- However, I traced the pinned dependency `@anthropic-ai/sdk@^0.39.0` (present in package.json:39, actually used from `server/services/claude.js:112-118`, itself reachable from routes mounted in server/index.js — accolades, execution-slate, edge, nfl-betting, betting-hub, dev, analysis, news, tradelab, trades, players, drafts) and confirmed via node_modules that its Node-runtime code path is:
  - `@anthropic-ai/sdk/package.json` exports map: the `"node"` condition resolves `./_shims/auto/*` to `./_shims/auto/*-node.js`.
  - `_shims/auto/runtime-node.js` → re-exports `../node-runtime.js`.
  - `_shims/node-runtime.js:33`: `const nf = __importStar(require("node-fetch"));` — the SDK's actual transport in a plain Node process is the `node-fetch` package, **not** `globalThis.fetch`.
  - `node_modules/node-fetch/lib/index.js:8,11`: `var http = _interopDefault(require('http')); ... var https = _interopDefault(require('https'));` — node-fetch itself is built directly on node's `http`/`https` core modules.
  - This means the Anthropic SDK, as pinned *today*, already bypasses the offline guard's `globalThis.fetch` monkeypatch entirely — this is not a hypothetical "future minor version" risk as the claim frames it, it is the SDK's current, already-installed behavior.
  - Mitigating factor (found during verification, not in the original claim): `callClaude()` in server/services/claude.js:99-118 first calls `getApiKey()` (line 101ish), which reads `process.env.ANTHROPIC_API_KEY` or an `app_settings` row, and throws before ever touching the SDK if no key is configured (claude.js:103). No test file calls `callClaude()` (only two files import claude.js, and only for its import-time `app_settings` table side effect — test/espn-connect.test.js:17, test/espn-draft-sync.test.js:13 — grep confirms no `callClaude(` call in any test file). `npm test` does not load `.env` (only `dev:server` uses `--env-file-if-exists=.env`), so a real key would have to be present in the ambient shell environment for this to fire today. So current practical exposure is low, but the guard's claimed enforcement property ("any fetch to a non-localhost host throws") is demonstrably false for this exact, already-present dependency, matching the letter of the claim precisely and even exceeding it in concreteness.
- Verdict: CONFIRMED, P1 justified (arguably underclaimed, since the SDK bypass is present-tense fact, not a future risk).

## G17-tests#210 — test/nfl-audit-overview.test.js:15, bare-boolean skips — CONFIRMED

- Read the full 77-line file. `run27Exists` at line 15 matches exactly. Used as `{ skip: !run27Exists() }` at lines 22, 36, 48, 58 and the compound form at line 66 — all five locations match the claim exactly.
- Confirmed test/helpers/requires-real-history.js (46 lines, read in full): `realHistoryDisposition()` (lines 41-45) is the project's own established convention for exactly this situation, and its header (lines 1-24) states the "failures/skips have explicit disposition" requirement quoted in the claim.
- Confirmed the specific assertions that go dark on skip: weeks_sealed===70 (line 25), spread_only.bets===153 (line 26), units ≈ -11.855 (line 31), and the run 27 vs 31 byte-identical claim (lines 69-71).
- Nuance not in the claim: node's test runner does report a "skipped" count for these tests by default (it's not entirely invisible in CI/local output), so "silently disarming" is a bit strong — but no *reason* is shown, unlike every other real-history-gated test in this suite, so a developer scanning output has no way to tell "clean checkout, expected" apart from "run 27 got deleted, that's a problem" without reading source. This is a real, if moderate, regression in observability relative to the project's own stated bar.
- Verdict: CONFIRMED. P2 is reasonable (I'd accept P2 or a soft P3; keeping P2 as claimed).

## G17-tests#211 — test/teaser-leg-rates.test.js:189, inverted gate — CONFIRMED

- Read the full 514-line file (headers, gate, and the cited assertions at lines 183-186 area / actual line numbers 189-192 in the "familyRate pools..." test block). Confirmed `assert.equal(all.n, 2894, ...)`, `wins, 2124`, `pushes, 26` verbatim.
- Confirmed gate at lines 37-40: `realHistoryDisposition(rows, ['game_lines'], ..., { min: 5000 })`.
- Confirmed the "must never pass quietly" comment at lines 47-49 verbatim ("Counts (`n`, `wins`, `pushes`) are integers and are asserted EXACTLY: a count that drifts means the population changed, and that must never pass quietly.").
- Confirmed the file already carries a real spread-corruption exclusion: `server/betting/nfl/strategy/teaser-leg-rates.js:89` `EXCLUDED_SEASONS = Object.freeze([2025, 2026])` with a corruption comment at line 91, referenced from the test at lines 232/254/259.
- The logical argument holds: if `game_lines` drops below 5,000 rows (data loss/corruption), the suite SKIPS instead of failing — exactly the scenario the "must never pass quietly" policy claims to guard against; if legitimate new data is backfilled changing `n` from 2894, the test hard-FAILS on an exact-count assertion that is not actually broken. The failure mode really is inverted relative to what would be useful.
- Verdict: CONFIRMED, P2 reasonable.

## G17-tests#212 — test/nfl-preseason-blend.test.js:31, fixture leak into a real db — CONFIRMED (one numeric nit)

- Read the full 200-line file. Line 31 quoted exactly: `const usingFixture = !process.env.GRIDIRON_DB_PATH || !fs.existsSync(process.env.GRIDIRON_DB_PATH);` and line 32 `if (usingFixture) process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');`. Grepped all 175 test files for this `usingFixture` conditional pattern — it is **unique to this file**; every other test file that isolates its db does so unconditionally (`process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite')` with no existence check). So this file is a genuine, singular deviation from the suite's own convention, not a documented/reviewed pattern.
- Confirmed line 36 `runMigrations()`, line 39 `seedTeams(db)`, line 40 `if (!hasRealHistory(rows)) seedLeagueHistory(run);`, and `test.after` at line 43 only removing the temp dir it never used when `usingFixture` is false.
- Read test/helpers/seed-league-history.js in full (134 lines). Confirmed `INSERT OR IGNORE INTO game_lines` at lines 104-111, with real NFL abbreviations from `FIXTURE_TEAMS` (lines 43-52: KC, BAL, BUF, CIN, SF, SEA, DAL, PHI, GB, DET, MIA, NYJ, LAR, ARI, TB, NO) and fabricated spreads/scores.
- Confirmed `game_lines` PRIMARY KEY is `(season, week, team)` at server/db/schema/core-and-fantasy.js:691 (exact quote: `PRIMARY KEY (season, week, team)`), which is why `INSERT OR IGNORE` only skips slots already filled and fills in any gap (a real bye week, a partially-backfilled season/week) with a fabricated row.
- One correction: the claim says "seeds 1,632 fabricated games" — the seeding loop (6 seasons × 17 weeks × 8 pairings) produces 816 *games*, each inserted as 2 team-perspective rows (home + away) into game_lines, i.e. 816 games / 1,632 rows. The claim conflates rows with games; the substance (permanent, real-team-code fabricated data silently merged into a partially-populated real database) is accurate regardless.
- Reachability: requires an operator to have `GRIDIRON_DB_PATH` already pointing at a real, existing (possibly partially populated) sqlite file when running this specific test — not the default `npm test` case (which is safe, `usingFixture` true). But this is a plausible real workflow in this project: several other tests (teaser-leg-rates.test.js, nfl-audit-overview.test.js) are explicitly designed to be pointed at a real historical-data copy via this same env var to exercise "REAL HISTORY" assertions, so a developer plausibly already has `GRIDIRON_DB_PATH` set to a real backup/copy in their shell when running the whole suite.
- Verdict: CONFIRMED, P2 reasonable, with the "games" vs "rows" count corrected to 816 games / 1,632 rows.

## G17-tests#213 — test/legacy-route-security.test.js:24, unauthenticated money-adjacent routers — CONFIRMED

- Read server/index.js in full (156 lines). Confirmed lines 102-103: `app.use('/api/props-tickets', propsTicketsRouter);` and `app.use('/api/decision-inbox', decisionInboxRouter);` — both with no `...legacyAuthenticated`/`...legacyAdmin` spread, unlike lines 78, 88, 91, 97, 98 (players, news, leagues, tradelab, trades) which all do.
- Read server/routes/props-tickets.js in full (57 lines) and server/routes/decision-inbox.js in full (190 lines): neither contains `requireAuth`, `legacyAuthenticated`, `req.auth`, or any permission check of any kind — confirmed by full read, not just grep.
- Read test/legacy-route-security.test.js in full (85 lines): it mounts exactly 6 routers (leagues, news, players, tradelab, trades, dev — lines 15-20, 24-29) with auth wired the same way as server/index.js, and asserts 401s for anonymous callers. It says nothing about props-tickets or decision-inbox, so a regression removing auth from an already-authenticated router, or the absence of auth on these two, is outside its coverage.
- Confirmed test/props-saved-tickets.test.js:20 (`app.use('/api/props-tickets', propsTicketsRouter);`, no auth) and test/decision-inbox.test.js:31 (`app.use('/api/decision-inbox', decisionInboxRouter);`, no auth) mirror production exactly, so neither test suite can ever catch this even if auth were later intended.
- Verdict: CONFIRMED, P2 reasonable given the local-first mitigating factor already noted in the claim (and the cloudflared-tunnel phone-access path from Nick's own memory notes, which does widen the reachable surface beyond localhost).

## G17-tests#214 — test/teaser-season.test.js:32, stale "035 does not parse" comment — CONFIRMED

- Read test/teaser-season.test.js in full relevant header (lines 1-50 shown) confirming the quoted comment verbatim and that only `server/migrations/012_teaser_execution_ledger.js` is applied (lines 27-31).
- Ran `node --check server/migrations/035_alt_spread_capture.js` (static syntax check only, no execution, no db access) — exit code 0. The migration parses cleanly today (2026-09-12); the comment claiming it "does not parse" is stale/false as of this audit.
- Confirmed server/routes/wong.js's actual table usage (grep across the 682-line file) is exactly `nfl_teaser_executions`, `nfl_teaser_price_ledger`, `schedule_games`, `nfl_teaser_execution_legs` — no others.
- Confirmed table origins: `nfl_teaser_executions`/`nfl_teaser_execution_legs` created in migration 012 (server/migrations/012_teaser_execution_ledger.js:11,33); `nfl_teaser_price_ledger` and `schedule_games` are legacy-schema tables (server/db/schema/nfl-n-to-z.js:274, server/db/schema/core-and-fantasy.js:265). So today's shortcut is indeed harmless, matching the claim.
- Confirmed test/wong-routes.test.js:26-29 does the identical thing (only migration 012, same "the full chain... would couple this suite to every other migration in flight" comment).
- Verdict: CONFIRMED, P2 reasonable — a real, if currently-dormant, drift risk plus a factually stale code comment.

## G17-tests#215 — server/services/nfl-teasers.js:2, zero tests on the leg-selection engine — CONFIRMED

- Read the file header/exports (291 lines; 4 exports confirmed: `wongLeg`, `wongHistory`, `teaserEV`, `findTeaserLegs` at lines 97, 114, 160, 244).
- Grepped all of test/ for any import of `nfl-teasers.js` — zero hits. Confirmed test/teaser-leg-rates.test.js imports from `server/betting/nfl/strategy/teaser-leg-rates.js` (a different module) and test coverage exists for `server/services/nfl-teaser-execution.js` and `server/betting/nfl/strategy/teaser-leg-rates.js`, but not this file.
- Confirmed reachability: `server/services/nfl-teasers.js` is imported by `server/routes/betting-hub.js` and `server/routes/execution-slate.js`, both mounted live in server/index.js (lines 108-109) — this is not dead code, it is the module that actually powers the weekly teaser recommendation surface.
- Verdict: CONFIRMED, P2 reasonable (arguably could be argued P1 given it's the "only structurally +EV" strategy per the module's own header comment, but P2 is a defensible call given nothing here is provably broken today, just untested).

## G17-tests#216 — server/services/nfl-user-bets.js:4, zero tests on the user-bet ledger — CONFIRMED

- Read the full 69-line file. Confirmed 5 exports (`addUserBet`, `removeUserBet`, `userBetsFor`, `allUserBets`, `userBetsStanding`), `INSERT INTO nfl_user_bets` at line 15, `DELETE FROM nfl_user_bets` at line 26, and the separation-of-track-records comment at lines 1-5 quoted verbatim.
- Grepped all of test/ for any import — zero hits.
- Confirmed reachability: imported by `server/routes/nfl-market.js`, which is mounted live at server/index.js:105 (`app.use('/api/nfl-market', nflMarketRouter);`).
- Verdict: CONFIRMED, P2 reasonable.

## Summary table

| key | verdict | severity kept | notes |
|---|---|---|---|
| 208 | confirmed | P1 | count overstated (14 files, not 22) but core defect and live-db-contention risk real |
| 209 | confirmed | P1 | claim actually understates it — Anthropic SDK 0.39.0 bypasses the guard today via node-fetch→http/https, not just hypothetically |
| 210 | confirmed | P2 | "silent" slightly strong (skip count is visible, reason is not) |
| 211 | confirmed | P2 | exact as described |
| 212 | confirmed | P2 | "1,632 games" should be "816 games / 1,632 rows"; mechanism otherwise exact |
| 213 | confirmed | P2 | exact as described |
| 214 | confirmed | P2 | verified 035 now parses (node --check exit 0), confirming the comment is stale |
| 215 | confirmed | P2 | exact as described, confirmed reachable via betting-hub.js/execution-slate.js |
| 216 | confirmed | P2 | exact as described, confirmed reachable via nfl-market.js |
