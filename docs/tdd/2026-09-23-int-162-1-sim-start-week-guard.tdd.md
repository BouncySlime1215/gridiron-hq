# INT-162-1 — B-01 hardening: source guard + stale-payload from_week guard (RED + GREEN)

Branch `claude/local-int-162-1-sim-start-week-guard`, base `origin/main` at
`ad3bb9f6` (#179 merged).

Unit's acceptance line (WORK-QUEUE.md row INT-162-1): "RED tests for both."
This unit ships the two RED tests only; no implementation change. Both
findings are named below for the GREEN follow-up.

## Audit (on `ad3bb9f6`)

Two gaps left after B-01 (`docs/tdd/2026-09-22-b-01-real-record-odds.tdd.md`):

1. **`simStartWeek` order of checks** (`server/services/season-sim.js:184-189`,
   function starts at :183):
   ```js
   export function simStartWeek(lg, requested = null) {
     const explicit = Number(requested);
     if (Number.isInteger(explicit) && explicit >= 1) return explicit;
     const payloadSeason = Number(lg?.payload_season), season = Number(lg?.season);
     if (payloadSeason && season && payloadSeason !== season) return 1;
     return leagueCurrentWeek(lg);
   }
   ```
   The explicit-week check runs *before* the stale-payload check. A client
   `?from_week=` (GET `/:leagueId/simulate`, `server/routes/model.js:455`) or
   `body.from_week` (POST `/:leagueId/trade-impact`, `server/routes/model.js:476`)
   on a league whose payload is last season's (`payload_season !== season`,
   the pre-draft fallback in `syncEspnLeague`) still overrides week 1 with
   whatever week the client sent — the same "last season's scored weeks
   become this season's standings" defect B-01 fixed, reachable again through
   an explicit week instead of the `|| 1` default B-01 removed.

2. **`fromWeek` has two producers.** `simulateSeason` and `tradeImpact`
   (`server/services/season-sim.js:277-280`, `:452-457`) both already resolve
   their own start week by calling `simStartWeek(lg, requestedWeek)`
   internally. Three call sites under `server/` still compute a week
   themselves and pass it in as `fromWeek`, making them a second producer of
   the same number:
   - `server/routes/model.js:455-459` (`GET /:leagueId/simulate`) — passes
     `fromWeek` (shorthand) into `simulateSeason`.
   - `server/routes/model.js:471-476` (`POST /:leagueId/trade-impact`) —
     passes `fromWeek: simStartWeek(lg, req.body?.from_week)` into
     `tradeImpact`.
   - `server/services/trade-engine.js:1408-1421` (`myPlayoffOdds`) — passes
     `fromWeek: start` into `simulateSeason`, where `start = simStartWeek(lg)`.

   None of these three currently disagree with the internal resolution (they
   all derive their value from `simStartWeek` too), so this is not a live
   numeric bug today. It is the hardening the row asks for: fixing (1) only
   at `simStartWeek`'s single definition guarantees every caller inherits the
   fix, but only if no caller also does its own resolution that could drift
   from it later. `title-odds-trades.js:66` and `trades.js:1155` already pass
   nothing (confirmed no `fromWeek` key there), so they are not offenders.

## RED

`8931e43d` — `test: RED — INT-162-1 sim-start-week source guard + stale-payload from_week`

Both added to `test/b-01-real-record-odds.test.js` (same fixture file B-01
already owns for this surface — extend, not a new file).

Run against the unfixed tree, `test/b-01-real-record-odds.test.js` only:

```
$ SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test \
    --test-reporter=tap test/b-01-real-record-odds.test.js
# tests 10
# pass 8
# fail 2
```

Failing assertion, test 1 (stale-payload guard):
```
not ok 9 - B-01 hardening: simStartWeek ignores a client from_week on a stale (last season's) payload
  a client from_week=5 must not resurrect last season's payload as week 5
  expected: 1
  actual: 5
```
Control in the same test: `simStartWeek(current, 5)` on a current-season
payload still returns `5` — passes, proving the assertion above tests the
stale-payload branch specifically, not "explicit week is ignored" generally.

Failing assertion, test 2 (source guard):
```
not ok 10 - B-01 hardening: source guard — no tradeImpact/simulateSeason caller under server/ passes fromWeek
  caller(s) pass fromWeek directly instead of leaving it to simStartWeek:
  server/routes/model.js: simulateSeason(lg, {…
  server/routes/model.js: tradeImpact(lg, {…
  server/services/trade-engine.js: simulateSeason(lg, {…
```
Control in the same test: `files.length > 50` walking `server/` — confirms
the walk is not vacuously scanning zero files (a known-nonzero case before
trusting the empty-offenders result the test wants).

Known defect in the guard's first draft, fixed before commit: the regex
checked for `fromWeek\s*:` and missed `server/routes/model.js:459`'s
shorthand `{ runs, fromWeek, scoring }` (no colon) — 2 of 3 offenders instead
of 3. Widened to `\bfromWeek\b` (fed by the narrowed call-argument capture
group, so it can't match an unrelated identifier). Both pre- and post-fix
runs are recorded above only for the final (post-fix) version; the draft run
is not re-quoted, only named as a decline-then-fix step per the citation
rule.

The other 8 tests in the file (pre-existing B-01 coverage) still pass
unmodified — no regression from the added tests.

## GREEN (commit `0e31d824`, added after skeptic round 1)

Skeptic round 1 blocked the RED-only branch (2 failing tests would reach
main; merge gate needs RED + GREEN shas) and showed two defects in the RED
design, both accepted:

1. **Guard was call-shape level.** The regex only saw an inline object literal
   as the 2nd argument, so `const simOpts = { fromWeek: start }; simulateSeason(lg, simOpts)`
   (mutant B) and `Object.assign({ fromWeek: start }, ...)` (mutant D) passed.
2. **The planned GREEN would have split the week.** The three "offenders"
   already took their week from `simStartWeek`; dropping `fromWeek` at
   `/simulate` would leave the memo key on the requested week while the body
   ran from the league week, and would orphan `?from_week` / `body.from_week`.

What shipped instead:

- `server/services/season-sim.js` `simStartWeek`: payload/season mismatch is
  checked before the explicit week (docstring updated to say so and to name
  the raw-week contract).
- `server/routes/model.js` GET `/:leagueId/simulate`: passes
  `fromWeek: req.query.from_week` (raw) to `simulateSeason`; the memo key uses
  `simStartWeek(lg, req.query.from_week)` — the same producer on the same
  input simulateSeason resolves internally, so key and body agree.
- `server/routes/model.js` POST `/:leagueId/trade-impact`: passes
  `fromWeek: req.body?.from_week` (raw) to `tradeImpact`.
- `server/services/trade-engine.js` `myPlayoffOdds`: passes no week;
  `simulateSeason` resolves `simStartWeek(lg)`, identical to the `start` still
  used for the cache key. The override stays honoured (route test, below).

Tests (in `test/b-01-real-record-odds.test.js`):

- Kept: `simStartWeek ignores a client from_week on a stale payload` (+ control).
- New runtime test through the real routes: `GET /simulate?from_week=5` and
  `POST /trade-impact {from_week:5}` on a last-season payload return
  `from_week: 1`; control on a current-season payload returns `3` for
  `from_week=3` on both routes, including a memo hit.
- Source guard rewritten token-level: in every `server/**/*.js` module that
  imports `season-sim.js` (except season-sim.js), every `fromWeek` token must
  be exactly `fromWeek: req.(query|body)?.from_week`. Controls: >50 files
  walked, >=2 importers, >=2 allowed raw pass-throughs found. (First draft
  scanned all of `server/` and flagged `server/services/matchups.js:403,407`,
  an unrelated NFL-schedule `scheduleOutlook(…, fromWeek)` parameter; scoped
  to season-sim importers.)

Run on tree `0e31d824`:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/db.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/b-01-real-record-odds.test.js`
→ `# tests 11 # pass 11 # fail 0`.
Same command on the other simulateSeason callers' tests, tree `0e31d824`:
trade-engine-correctness 15/15, league-rules-bracket-sim 4/4,
decision-leftovers-home-away 5/5, model-integrity 89/89.

## Mutation results (tree `0e31d824`, each mutant applied then `git checkout`)

| mutant | change | b-01 file result |
|---|---|---|
| B | trade-engine: `const simOpts = { runs, fromWeek: start, scoring }; simulateSeason(lg, simOpts)` | pass 10 fail 1 (killed) |
| D | trade-engine: `...Object.assign({ fromWeek: start }, {...})` in the options | pass 10 fail 1 (killed) |
| E | model.js trade-impact back to `fromWeek: simStartWeek(lg, req.body?.from_week)` | pass 10 fail 1 (killed) |
| F | simStartWeek: explicit-week check back before the payload check | pass 9 fail 2 (killed: unit + route test) |

Survivor by design: a computed property name (`['from'+'Week']`) would evade
the static guard; the route test still pins the route behaviour.

## Numbers, with commands

- `git -C /Users/nick_matta/gridiron-local/wt/INT-162-1 write-tree` before
  the RED commit: `a0963f8a3497ec9b263c0e55bf6a1bde9adfa3f7`.
- Test file diff: `+65` lines, one file
  (`test/b-01-real-record-odds.test.js`) — `git diff --stat` on the tree
  above.
- No DB copy was needed: both tests use the existing in-memory/tmp sqlite
  fixture the file already sets up (`GRIDIRON_DB_PATH` under
  `os.tmpdir()`), not `~/gridiron-local/data.sqlite`.

## Known defects / not covered

- The source guard is token-level regex, not an AST parse; it covers
  modules that import season-sim.js directly (no barrel re-exports exist
  today). Computed keys evade it (see mutation table).
- Not a statistical unit: no model number, no pre-registration, no holdout
  ledger entry needed.

## Nick's five questions (updated for GREEN)

1. **Well built?** Fix is the reorder plus raw pass-through; four mutants, all killed.
2. **Stats or made up?** No statistical claim; code-behaviour tests only.
3. **How we know:** `# tests 11 # pass 11 # fail 0` on `0e31d824` (command above).
4. **Pointed anywhere else?** Reaches GET /simulate, POST /trade-impact, and
   myPlayoffOdds (Trades page) — all resolve the week in simStartWeek only.
5. **How it unifies:** one producer (simStartWeek); callers hand only the raw
   client week; the memo key uses the same producer on the same input.

Defect fixed: `simStartWeek` check order (season-sim.js); redundant resolved
`fromWeek` at model.js /simulate, /trade-impact and trade-engine.js myPlayoffOdds.
