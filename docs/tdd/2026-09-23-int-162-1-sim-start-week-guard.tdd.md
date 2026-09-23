# INT-162-1 — B-01 hardening: source guard + stale-payload from_week guard (RED only)

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

## GREEN

Not in this unit. Acceptance for INT-162-1 is "RED tests for both"; the fix
(reorder `simStartWeek`'s checks so the stale-payload branch runs before the
explicit-week branch, and stop the three call sites above from computing
`fromWeek` themselves) is left to the paired GREEN unit. Recorded here so
that unit does not re-audit: the fix is a two-line reorder in
`simStartWeek` (season-sim.js:184-189) plus dropping the `fromWeek`
key/shorthand at the three call sites named above (they can rely on
`simulateSeason`/`tradeImpact`'s own internal `simStartWeek` call once the
reorder lands).

## Mutation notes (for the GREEN unit, recorded now while the call sites are fresh)

- Unit mutant: swap the two `if` branches in `simStartWeek` back (current
  order) — RED test 1 above is exactly that kill.
- Call-site mutant: reintroduce `fromWeek: simStartWeek(lg, req.query.from_week)`
  at `model.js:455` after it's removed — RED test 2 (source guard) is the kill.
- Designed survivor (documented, not fixed in this unit): a fourth call site
  added later that passes `fromWeek` but always derives it from
  `simStartWeek(lg)` with no client input would still fail the source guard
  (it is a blunt "no `fromWeek` key at all" rule, not "no *client* `fromWeek`").
  That is intentional per the row's own wording ("no caller ... passes
  fromWeek") — flagging it so the GREEN unit doesn't try to special-case it.
- Not-applied control: `simStartWeek(lg, 5)` on the *current*-season league
  (`lg` id 601) — asserted to still return `5` in RED test 1 itself, i.e. the
  guard does not fire when nothing is wrong.

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

- No GREEN in this unit (see above) — ships nothing runtime-visible yet;
  this is test-only.
- The source guard is regex-based over call-argument text, not an AST parse.
  It narrows to the `(lg, { ... })` argument object of each match before
  testing for `fromWeek`, so it will not flag an unrelated `fromWeek`
  elsewhere in a file, but it also would not catch a call site that passes
  the week through a second, differently-named parameter that later gets
  renamed to `fromWeek` inside the callee — the guard is only as good as the
  literal argument key name.
- Not a statistical unit: no model number, no pre-registration, no holdout
  ledger entry needed.

## Nick's five questions

1. **Well built?** The two RED tests are built to the row's own wording; the
   source guard has a known-nonzero control (offenders found today) and a
   known-good control (current-season league still honors an explicit
   week); the stale-payload test has both a positive and a not-applied
   control in the same test.
2. **Stats or made up?** Neither test is a statistical claim — both are
   direct code-behavior assertions (grep-based static check, unit-tested
   function). No stats, no holdout look needed.
3. **How we know:** direct run, `test/b-01-real-record-odds.test.js`,
   `# pass 8 # fail 2`, quoted above with commands.
4. **Pointed anywhere else on the platform?** No — this is
   `simStartWeek`/`simulateSeason`/`tradeImpact` only, the same surface B-01
   already covers in this file.
5. **How it unifies:** extends B-01's own test file rather than adding a new
   one; documents the GREEN fix inline so the next unit does not re-audit
   the three call sites.

Defect fixed / gap covered: none yet (RED only) — `server/services/season-sim.js:184-189`
(`simStartWeek` check order) and `server/routes/model.js:455-459,471-476`,
`server/services/trade-engine.js:1420-1421` (redundant `fromWeek` producers),
on `ad3bb9f6`.
Incumbent: `simStartWeek` as committed by B-01 (`20a5c49`, per
`docs/tdd/2026-09-22-b-01-real-record-odds.tdd.md`) — correct for the
`|| 1`-default case B-01 fixed, not for an explicit stale-payload override.
Does NOT cover: the implementation fix (GREEN, separate unit); any
call site outside `server/` (none exist — `tradeImpact`/`simulateSeason` are
only imported under `server/`, confirmed by `grep -rl` in the audit above).
What would make it wrong: if a legitimate caller needs to pass an
already-resolved `fromWeek` for a reason the source guard doesn't know about
(e.g. a batch/backfill script needing a fixed historical week) — none found
under `server/` today, but the GREEN unit should re-grep before assuming the
list above is exhaustive.
