# INT-163-1: A-03 scoring follow-ups

Unit: INT-163-1 (work queue row, after #163 merged). Not statistical — no
model, projection, trade-valuation, lineup or inventory number changes, no
pre-registration required. All four items are code-hygiene/coverage
follow-ups on `server/services/scoring.js` and its callers.

## Audit (extend-or-build)

- `scoring.js` already correctly documents statId 44 as "receiving 2pt, not a
  reception id" (scoring.js:31, fixed in #163). Only `test/scoring.test.js`
  still called it "rushing" in its comments/messages (lines 7, 26).
- `scoringFor`'s non-enumerable `espn` report (scoring.js:64-79) already
  carried `source`, `reason`, `points`, `unscored`, `unmapped`. Nothing
  reported whether the payload carries slot-specific `pointsOverrides` at
  all — extend, not build: same report object, two new fields.
- `test/scoring-call-sites.test.js` already covers
  buildProjections/simulateSeason/tradeImpact/buildPlayerWeekEngine. Grepped
  every remaining `scoringFor(` call site
  (`grep -n "scoringFor(" server/services/*.js server/routes/*.js
  scripts/*.mjs`): `trade-engine.js:296` (assetUniverse, already covered) and
  two more with no test — `trade-engine.js:1421` (myPlayoffOdds's horizon
  `simulateSeason` call) and `scripts/weekly-construction-grade.mjs:350`
  (consumerParity). Extend the existing style, new file (own call sites, own
  fixtures) rather than growing the existing one.
- `scheduler.js`'s `refreshLeagueRosters` (server/services/scheduler.js:335)
  built a `results` array carrying each league's sync `detail` and then
  returned only `{ leagues: results.length, failed: ... }` (was line 353) —
  extend the existing function, no new table/producer.

## RED / GREEN

1. **Stale comment** — `e04e189d` "fix: correct stale statId 44 comment in
   scoring.test.js". Doc-only; no RED/GREEN pair (no behaviour, no failing
   assertion possible). Also carries the RED tests for item 2 (see below) —
   both landed together since the whole file changed as one edit; the tests
   here are what's RED, not the comment fix.

2. **hasOverrides/overrideSlots**
   - RED: `e04e189d` test/scoring.test.js — 4 new tests
     (`INT-163-1: ...hasOverrides...`). Confirmed RED by checking out
     `origin/main`'s `server/services/scoring.js` against this test file:
     `pass 11 / fail 4`. Failing assertion:
     `AssertionError [ERR_ASSERTION]: expected undefined to strictly equal false`
     (scoringFor(lg).espn.hasOverrides on a league with no overrides).
   - GREEN: `b25633b3` "feat: report hasOverrides/overrideSlots from
     scoringFor". `test/scoring.test.js`: `pass 15 / fail 0`.
   - No behaviour change to scored weights: `espn` stays a non-enumerable
     property (`withReport`, scoring.js:60-63), so
     `JSON.stringify(scoringFor(lg))` — what every memoising caller keys on —
     is unaffected. Verified: `test/scoring.test.js`'s existing
     "falling back to the ppr bucket ... still serialises as the bucket"
     test (unchanged) still passes.

3. **Unguarded call-site tests**
   - RED: `c6acf2c8` test/scoring-call-site-followups.test.js —
     `pass 1 / fail 1`. The myPlayoffOdds test already passed against
     unfixed code (no defect there); the consumerParity test failed:
     `TypeError [ERR_ASSERTION]: expected 'function', got 'undefined'`
     (`consumerParity` was not exported from
     `scripts/weekly-construction-grade.mjs`).
   - GREEN: `051136a2` "feat: export consumerParity/SYNTHETIC_PPR_LEAGUE for
     direct testing". `pass 2 / fail 0`.
   - **Mutation liveness proof** (run locally, reverted before commit — not
     in the shipped diff):
     - Designed mutant 1: `trade-engine.js:1421`
       `scoring: scoringFor(lg)` -> `scoring: scoringFor({})`. Result: the
       myPlayoffOdds test failed
       (`rush_yd must come from this league's own statId 24 ... 0.1 !== 0.3`).
       Mutant killed.
     - Designed mutant 2: `weekly-construction-grade.mjs`'s
       `SYNTHETIC_PPR_LEAGUE` `id: 0` -> `id: 99`. Result: the consumerParity
       test failed (`99 !== 0`). Mutant killed.
     - Not-applied control: both tests pass, unmodified, on the commit
       actually shipped (`c6acf2c8`/`051136a2` above).

4. **Scheduler drops the scoring summary**
   - RED: `4adfc2fe` test/league-roster-schedule.test.js — `pass 3 / fail 1`.
     Failing assertion:
     `AssertionError: refreshLeagueRosters must return the per-league
     results, not only counts` (expected true, got false).
     Known-nonzero control: the fixture league pays statId 209 (outside
     scoring.js's public ESPN id list), and the test asserts
     `mine.scoring.unmapped` deep-equals `[{ statId: 209, points: 1 }]`, not
     merely that `results` exists — an empty array would otherwise satisfy a
     weaker "results exists" check for the wrong reason.
   - GREEN: `fd7ecb30` "fix: return the scoring summary from
     refreshLeagueRosters". `pass 4 / fail 0`.
   - No behaviour change to `leagues`/`failed`: both pre-existing tests on
     those two fields (`league-roster-schedule.test.js`,
     `scheduler-retry-and-honesty.test.js`) still pass unmodified.

## What this does NOT cover

- The Leagues page (client/src/pages/Leagues.tsx:22-24 `scoringNote`) does
  not print `hasOverrides`/`overrideSlots`; the fields reach the manual sync
  response, the scheduled `league_rosters` sync_log detail and
  `GET /api/leagues/:id/scoring` (see round 2), which is the reader rule.
- `results` in `refreshLeagueRosters`'s return carries `scoring: null` for
  Sleeper leagues and for the skip-during-live-draft case, because
  `syncSleeperLeague` does not compute a scoring summary at all (only ESPN
  leagues have a `scoringFor`-derived summary today). Not a regression: it
  was equally absent before this change, just harder to see since the whole
  per-league detail was dropped.
- No test exercises `refreshLeagueRosters`'s Sleeper branch's `scoring: null`
  explicitly; only ESPN is asserted with a real (non-null) summary.

## Nick's five questions

1. **Well built?** Yes for all four: each has a RED test against the
   unfixed tree (or a mutation kill for the call-site coverage that had no
   defect) and passes GREEN.
2. **Stats or made up?** Neither — no model number, no statistical claim.
   Pure code correctness/coverage.
3. **How we know:** targeted `node --test` runs, shown above with pass/fail
   counts and the exact failing assertion text.
4. **Pointed anywhere else on the platform?** `hasOverrides`/`overrideSlots`
   are not yet read by any route/page (see "does NOT cover" above) — a
   defined-but-unread field, not wired further in this unit.
5. **How it unifies:** all four items work inside the single existing
   `scoringFor` producer (server/services/scoring.js:81) and its two known
   readers (`espn-scoring-report.js`, `weekly-construction-grade.mjs`); no
   second producer of scoring weights was introduced or found.

## Commands / tree

- Branch: `claude/local-int-163-1-scoring-followups`
- Worktree: `/Users/nick_matta/gridiron-local/wt/INT-163-1`
- `git write-tree` after merging `origin/main` (57a9ca1c): `9369190ddb60fdfc527a3ccb9f0229ca3c81e47d`
- Targeted tests (each run standalone, `GRIDIRON_DB_PATH=$(mktemp -u)
  SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test
  --test-reporter=tap <file>`):
  - `test/scoring.test.js`: 15/15 pass
  - `test/scoring-call-sites.test.js`: 4/4 pass (pre-existing, unmodified — regression check)
  - `test/scoring-call-site-followups.test.js`: 2/2 pass (new)
  - `test/league-roster-schedule.test.js`: 4/4 pass
  - `test/scheduler-retry-and-honesty.test.js`: 7/7 pass (pre-existing, unmodified — regression check)
- `npm run check` (typecheck/lint/wiring/build/smoke) was **not** run here per
  the builder's CPU/lean-reading instructions ("Do NOT run npm run check,
  npm test, or builds; the Gate phase does that once"); it must run before
  merge.

## Round 2 (skeptic fixes)

Tree: branch head after these commits; targeted command as above
(`GRIDIRON_DB_PATH=$(mktemp -u) SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`).

1. Surviving mutant, scoring.js overrideSlot loop filtered to `slot`.
   Test added to `test/scoring.test.js` (overrideSlots test): payload with
   overrides on slots 6 and 16, resolved with `{slot:16}`, `{slot:6}` and
   `{slot:2}`, must still report `[6,16]` / `hasOverrides: true`.
   Passes on the real code (15/0); with the skeptic's mutant sed'd in,
   `pass 14 / fail 1` (test 13), then reverted.
2. Surviving mutant, trade-engine.js:1421 `scoringFor(lg)` -> `scoringFor(lg, { slot: 16 })`.
   Fixture statId 24 now carries `pointsOverrides: {16: 0.9}`; the test still
   asserts `rush_yd === 0.3`. Passes on real code (2/0); with the mutant,
   `pass 1 / fail 1`, then reverted. The header claim is now true.
3. Orphan fields. `scoringSummary()` and `espnScoringReport()`
   (server/services/espn-scoring-report.js) now forward `hasOverrides` and
   `overrideSlots`. Readers: `GET /api/leagues/:id/scoring`
   (server/routes/leagues.js:271), the manual sync response
   (server/routes/leagues.js:171 via `syncEspnLeague`), and the scheduled
   `league_rosters` job whose `results[].scoring` is written to
   `sync_log.last_detail` by `record()` (server/services/scheduler.js:82-96).
   - RED `212cce43` (tests only): `test/league-scoring-report.test.js`
     `pass 4 / fail 2` (route test :113 and sync test :168, `expected: true`,
     actual undefined).
   - GREEN `682f8d62`: `pass 6 / fail 0`. `git write-tree` = `83bd718b101f735573aa897402fd230a949da120`.
   - Regression, same tree: scoring 15/0, scoring-call-site-followups 2/0,
     league-roster-schedule 4/0, scoring-call-sites 4/0,
     scheduler-retry-and-honesty 7/0.
