# Adversarial verification of reader G17-tests (9 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (READ-ONLY)

## G17-tests#208 (package.json:14, P1) — npm test env / live-db contention

Verified in full. package.json:14 `"test": "node --experimental-test-module-mocks --test --test-concurrency=1 test/*.test.js"` sets no env vars. Only `.github/workflows/ci.yml:79-82` sets `SCHEDULER_DISABLED`, `NODE_OPTIONS=--import ./test/offline-guard.mjs`, `GRIDIRON_DB_PATH`.

`server/db/index.js:10` — `const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite')` — confirms fallback to the real, live database. Line 13 opens a plain read-write `DatabaseSync`. Lines 171-176 create `db_health_checks`; lines 177-202 run `PRAGMA quick_check`/`integrity_check` and INSERT into `db_health_checks` unless `GRIDIRON_DB_INTEGRITY_CHECK=off`.

I wrote a static import-graph tracer (`/tmp/trace_imports.mjs`) to find every `test/*.test.js` file that (a) never sets `process.env.GRIDIRON_DB_PATH` before its first import, and (b) transitively imports `server/db/index.js`. Cross-referencing against a manual line-order check (env-assignment line vs. first `server/`-import line) for every one of the 175 spec files, the exact list of violators is:

1. always-valid-significance.test.js
2. betting-fantasy-link.test.js
3. contextual-coordinator.test.js
4. execution-slate-reasoning.test.js
5. gridiron-model.test.js
6. league-brain.test.js
7. nfl-advanced-depth.test.js
8. nfl-audit-overview.test.js (deliberately, by its own header comment, lines 1-8: "against the real dev database, read-only")
9. nfl-drive-tape.test.js
10. nfl-execution-staking-policy.test.js
11. nfl-execution-stress.test.js
12. nfl-family-contribution.test.js
13. nfl-replay-opener-disclosure.test.js
14. nfl-team-strength.test.js
15. paired-bootstrap-clustering.test.js
16. pick-reasoning.test.js
17. player-state.test.js
18. rookie-evidence.test.js
19. td-regression.test.js
20. waiver-brain.test.js
21. weekly-trends.test.js
22. teaser-leg-rates.test.js (sets `GRIDIRON_DB_INTEGRITY_CHECK='off'` at line 24 but never `GRIDIRON_DB_PATH`)

**Exactly 22.** And of those, teaser-leg-rates.test.js is the only one that sets `GRIDIRON_DB_INTEGRITY_CHECK='off'` — its own header (lines 17-19) explicitly documents *why*: "It is a PRAGMA quick_check that last took 159 seconds on this 9.8 GB file, it writes a row when it runs." This is the exact source of the claim's "159 seconds" figure — a real comment in the repo, not a fabrication. So "21 of the 22 files do not set GRIDIRON_DB_INTEGRITY_CHECK='off'" is also exactly right.

This is a rigorously precise claim — the reader clearly did the same import-graph tracing. The only overstatement is the opening sentence's generality ("the database override never load locally") which, read alone, could sound like it applies to all tests; in fact ~150 of 175 files set their own `GRIDIRON_DB_PATH` override in their own header (confirmed by grep) and are safe. But the claim's own scoping clause ("22 spec files...") is correct, so this is not a misrepresentation once the whole claim is read.

Real-world impact: running `npm test` (or `npm run check`, package.json:19) locally with no exported env vars — exactly what a developer does by default — will, for these 22 files, open the live `server/data.sqlite` (the same file the T-60 capture server, PID 56651, is actively writing to) with a plain read-write connection, and for 21 of them, run a `PRAGMA quick_check` plus a write to `db_health_checks`. This is a genuine, verified operational hazard matching the hard-rule warning about not disturbing the live capture server: WAL-mode single-writer contention, `busy_timeout=15000`, and a 159-second scan against a live 9.8GB file. This is CONFIRMED, not refuted. P1 stands.

## G17-tests#209 (test/offline-guard.mjs:23, P1) — fetch-only guard bypass

Read the full 39-line file. Confirmed: only `globalThis.fetch` is wrapped (lines 23-24); no wrapping of `node:http`, `node:https`, or `net.connect`. Lines 28-31 fail-open on an unparseable input, exactly as quoted.

However, checked whether this is *exploitable today*: searched all non-test files under `server/` and `scripts/` for `node:http`/`node:https` usage — **zero matches**. Checked every paid-provider client in the repo:
- `server/services/odds-api.js:104` — `fetch(...)`
- `server/services/twitterapi-io.js:53` — `fetch(...)`
- `server/services/claude.js:112-118` — `new Anthropic({...})` with no custom `fetch` option, so it uses the SDK's default resolution, which is `globalThis.fetch` (Node ≥18 native fetch/undici) — i.e., exactly what offline-guard.mjs intercepts.

So every current network-reaching code path in this codebase goes through `fetch`, and the guard **does** catch all of them today. The "any client using node:http/https... bypasses it entirely" framing is true as a defense-in-depth gap, but the claim's own severity argument ("an SDK that changes transport in a minor version" bypasses it) is speculative/future-looking, not a demonstrated current leak. Per the impact lens (does this change money staked / a decision / data integrity / a number Nick reads, right now) — no. Nothing in the current codebase can currently leak past this guard. The secondary "fail-open on unparseable input" (lines 28-31) is also not practically reachable: Node's `fetch()` throws on a genuinely relative/unparseable URL before this code path would matter, since there's no document base URL in Node to resolve it against.

**Refuted as P1; downgraded to P3** — real code-quality/defense-in-depth observation, but not a live risk given everything in this repo already goes through `fetch`.

## G17-tests#210 (test/nfl-audit-overview.test.js:15, P2) — bare-boolean skip

Read the full 77-line file. Confirmed exactly: `run27Exists()` (line 15) is used as `{ skip: !run27Exists() }` at lines 22, 36, 48, 58, 66 — a bare boolean, no message. Compared against `test/helpers/requires-real-history.js` (full 46 lines read): `realHistoryDisposition()` returns `false` or an explanatory sentence — the "explicit disposition" convention the rest of the suite (5 other files, confirmed via grep for `requires-real-history`) all follow. `nfl-audit-overview.test.js` does not use this helper at all and is the only file with this bare-boolean pattern for real-history gating. The cited ground-truth numbers (weeks_sealed=70, spread_only.bets=153, units≈-11.855, byte-identical 27-vs-31) are exactly as quoted, lines 25-31 and 68-71 in the file. CONFIRMED, not refuted. P2 reasonable (not P1: this is a coverage-silence defect, not an active wrong number).

## G17-tests#211 (test/teaser-leg-rates.test.js:189, P2) — teaser regression lock inverted failure mode

Read the file's first ~260 lines in detail. Confirmed the exact gating: `NEEDS_HISTORY = realHistoryDisposition(rows, ['game_lines'], ..., { min: 5000 })` (lines ~37-40). The `assert.equal(all.n, 2894...)` etc. block (quoted lines) is gated `{ skip: NEEDS_HISTORY }`. `hasRows()` (in the helper) does `COUNT(*) >= min`, so a `game_lines` table with, say, 3,000 rows (a plausible partial-corruption/partial-delete scenario, distinct from a genuinely empty clean-checkout) makes `NEEDS_HISTORY` truthy → the whole regression-lock block **skips** rather than fails. The file's own docstring (lines 9-19) independently confirms this is "the only structurally +EV bet" measurement and is deliberately run against real data. This is a real, verified design gap: the guard is built for the "zero data on a clean checkout" case, not the "partially corrupted/deleted data" case the assertion exists to catch. CONFIRMED, not refuted. P2 reasonable.

## G17-tests#212 (test/nfl-preseason-blend.test.js:31, P2) — fabricated games seeded into a real/partial DB

Read the full 200-line test file and the full 134-line `test/helpers/seed-league-history.js`. Confirmed line-for-line:
- Line 31: `const usingFixture = !process.env.GRIDIRON_DB_PATH || !fs.existsSync(process.env.GRIDIRON_DB_PATH);`
- Line 32: only creates a *new* temp fixture path if no existing file is already pointed to — i.e., if `GRIDIRON_DB_PATH` is already set to an existing file (real or partial), that file is used *as-is*.
- Line 36: `runMigrations()` runs against whatever DB that is.
- Line 40: `if (!hasRealHistory(rows)) seedLeagueHistory(run);` — seeds fabricated data unless the "real history" thresholds (`minSeasons=8, minGames=3000` per line 41, or the helper's own defaults `minSeasons=5, minGames=2000`) are already met.
- `seed-league-history.js:104-111`: `INSERT OR IGNORE INTO game_lines (season,week,team,opponent,home,...)` under real team abbreviations (`FIXTURE_TEAMS`, lines 43-52: KC, BAL, BUF, CIN, SF, SEA, DAL, PHI, GB, DET, MIA, NYJ, LAR, ARI, TB, NO).
- `server/db/schema/core-and-fantasy.js:691` — `PRIMARY KEY (season, week, team)` — confirmed exactly as cited, which is why `INSERT OR IGNORE` silently no-ops on any slot that already has real data but fills in any slot that doesn't (a bye week, or an unsynced week in a mid-backfill DB).
- Line 43: `test.after(() => { db.close(); fs.rmSync(temp, ...); })` — only ever removes the `temp` directory this file created for its *own* fixture case; when `usingFixture` is false (an externally-provided `GRIDIRON_DB_PATH` was reused), nothing seeded is ever cleaned up.

This is a real, exactly-verified defect. The trigger is narrower than #208 (requires a developer to have `GRIDIRON_DB_PATH` already exported to an existing file when running this specific test — a plausible but not default scenario), but the consequence when triggered (permanent silent contamination of `game_lines`, which feeds CLV/backtests/teaser measurement) is severe. CONFIRMED, not refuted. P2 reasonable given the narrower trigger condition.

## G17-tests#213 (test/legacy-route-security.test.js:24, P2) — unauthenticated money-adjacent routers

Read the full 85-line test file and the full `server/index.js` (156 lines), `server/routes/props-tickets.js` (57 lines, full), `server/routes/decision-inbox.js` (190 lines, full).

Confirmed exactly:
- `server/index.js:102-103`: `app.use('/api/props-tickets', propsTicketsRouter); app.use('/api/decision-inbox', decisionInboxRouter);` — no `...legacyAuthenticated`/`...legacyAdmin` spread, unlike lines 78, 88, 91, 97, 98, 94.
- `server/routes/props-tickets.js` — GET/POST/DELETE, zero auth/permission checks anywhere in the file. This is "Saved MLB prop slips" — user's actual saved bets.
- `server/routes/decision-inbox.js` — GET/POST/POST-resolve, zero auth checks; writes betting/fantasy recommendations.
- `test/legacy-route-security.test.js:24-29` mounts exactly 6 routers (leagues, news, players, tradelab, trades, dev) with the auth wrappers and tests 401/403 behavior; it never touches props-tickets or decision-inbox, so it structurally cannot catch this gap or an authenticated router losing its middleware in a future refactor.

Additional check beyond the claim: `server/index.js:137` — `app.listen(PORT, '127.0.0.1', ...)` — the server only binds loopback, so remote reachability requires the `cloudflared` tunnel (`scripts/tunnel.mjs`, read in full). That script's own comment says "Nobody can sign in through it without a pairing code minted on this Mac" — but that pairing gate is only in front of `/api/auth` (obtaining a session); it does not add auth to routes that already have none. So when the tunnel is active (memory: "Gridiron phone access" — a real, used feature), `/api/props-tickets` and `/api/decision-inbox` are reachable over the public internet with no auth at all, which is a materially real exposure of money-adjacent data, not merely local-loopback theoretical. CONFIRMED, not refuted; the claim's own "Mitigating" caveat undersells it slightly but doesn't misstate anything. P2 reasonable (arguable case for P1 given the tunnel is real infrastructure Nick actually uses, but I did not find evidence the tunnel is active by default or during the current Week-1 capture, so P2 stands).

## G17-tests#214 (test/teaser-season.test.js:32, P2) — stale "035 does not parse" comment

Ran `node --check server/migrations/035_alt_spread_capture.js` → exit code 0 (parses cleanly). The comment at `test/teaser-season.test.js` (quoted line, part of the block just above the constant `ledgerMigration` import) says "at the time of writing 035 is mid-flight and does not parse" — verified false today. Confirmed the fixture only applies `012_teaser_execution_ledger.js` (read lines 1-50 of the file in full) and that `test/wong-routes.test.js:26-29` follows the identical shortcut (spot-checked). The claim is explicit that this is currently harmless (wong.js only touches legacy+012 tables) and is a forward-looking maintenance-debt risk, exactly as it says. CONFIRMED, not refuted, P2 as rated (the claim itself scopes it as non-urgent today).

## G17-tests#215 (server/services/nfl-teasers.js:2, P2) — recommendation engine has "zero tests"

Read the full 291-line file: 4 exports confirmed (`wongLeg` line 97, `wongHistory` line 114, `teaserEV` line 160, `findTeaserLegs` line 244). Grepped all of `test/` for `nfl-teasers` — zero direct imports, confirmed.

Nuance the claim doesn't mention: `server/services/nfl-teaser-execution.js:15` imports `{ teaserEV, wongHistory, wongLeg }` from `nfl-teasers.js`, and `nfl-teaser-execution.js` **is** tested (`test/nfl-teaser-execution.test.js`, confirmed by file listing). So 3 of the 4 exports (`wongLeg`, `wongHistory`, `teaserEV`) get *indirect* exercise through that dependent module's test suite — a regression in their output could plausibly be caught there if the execution-ledger tests assert on values that flow through them (not fully verified line-by-line, out of scope here). The 4th export, `findTeaserLegs` — the one actually described in the claim's impact as "the module that selects which legs to actually recommend this week" — is used only by `server/routes/betting-hub.js:21` and `server/routes/execution-slate.js` does not import it; grepped `test/` for `betting-hub` and `findTeaserLegs` — no test exercises either the route or the function directly (confirmed).

So the claim's literal "zero test imports" for the whole file is accurate (no test file imports `nfl-teasers.js` by name), but its implied "a bug there produces wrong bets with every surrounding test green" is strongest specifically for `findTeaserLegs`, which is genuinely, fully untested; the other three exports have some indirect safety net via `nfl-teaser-execution.test.js`. This is a real, still-standing finding — the actual leg-selection/recommendation function for the project's one flagged +EV strategy has no test coverage — just slightly narrower than "the whole module has zero coverage of any kind." CONFIRMED (with a scoping correction), not refuted. P2 as rated.

## G17-tests#216 (server/services/nfl-user-bets.js:4, P2) — user bet ledger has zero tests

Read the full 69-line file (matches `wc -l`). Confirmed 5 exports: `addUserBet`, `removeUserBet`, `userBetsFor`, `allUserBets`, `userBetsStanding`. Confirmed `INSERT INTO nfl_user_bets` (line 15-18) and `DELETE FROM nfl_user_bets` (line 26). Grepped all of `test/` for `nfl-user-bets` — zero matches, confirmed. The file's own header (lines 1-6, quoted in the claim) states the separation-of-track-records invariant this module exists to enforce ("kept in a separate table so a user's own action never contaminates the model's own graded track record") — and nothing in the test suite verifies either the grading math (`gradeBet`, lines 32-44 — push/cover/win logic) or the table separation itself. This is Nick's own literal bet ledger with zero automated verification. CONFIRMED, not refuted. P2 as rated (arguably a case for P1 given "money staked" is exactly the impact-lens trigger, but no *active* bug was found — only an absent safety net — so P2 is defensible).

## Summary table

| key | reader severity | verdict | corrected severity |
|---|---|---|---|
| #208 | P1 | CONFIRMED (numbers exactly verified: 22 files, 21 without integrity-check-off) | P1 |
| #209 | P1 | REFUTED (no current code path bypasses fetch; guard catches every real network call in this repo today) | P3 |
| #210 | P2 | CONFIRMED | P2 |
| #211 | P2 | CONFIRMED | P2 |
| #212 | P2 | CONFIRMED (schema PK line exactly verified) | P2 |
| #213 | P2 | CONFIRMED (tunnel exposure makes this more real, not less) | P2 |
| #214 | P2 | CONFIRMED (`node --check` proves the comment is stale) | P2 |
| #215 | P2 | CONFIRMED with a scoping correction (3/4 exports get indirect coverage; `findTeaserLegs` is the truly uncovered one) | P2 |
| #216 | P2 | CONFIRMED | P2 |
