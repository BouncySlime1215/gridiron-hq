# SY-06: the three MLB leftovers #128 missed

2026-09-22. Branch `claude/cloud-sy-06-mlb-leftovers`, off `main` at `d3dca8b`,
with current `main` (`a3e2bf35`) merged in at `f749c778`.
#128 (`bd56319`) removed MLB from the product — routes/mlb.js, eight MLB
services, five scheduled jobs — but its own census was scoped to what those
28 endpoints reached. Three things outside that census stayed live.

**Round 2 (review, same day).** Two reviewers blocked the first round. It had
unmounted the MLB props board and kept its two router files, which passed the
wiring gate only through two accept-list entries in a file SY-06 does not own.
Its evidence file also misquoted one RED count, and its source-text tests let
five named mutants through. Round 2 deletes the two routers, as #128 deleted
routes/mlb.js, and rebuilds the tests and the sweep. See "Review round 2" below.
Everything else in this file is the current state on `eaf35c96` unless a
section says it is round 1.

## Audit: extend, not build

Both test files this unit touches already existed and already carry the
"MLB is gone" contract:

- `test/mlb-removed.test.js` — #128's own sweep test (no MLB job, no
  `/api/mlb` mount, the eleven `mlb_*` tables kept, Middle Linebacker
  survives). Extended in the same style: source text read through the
  file's `read()` helper, in the same assertion voice. Round 2 routes those
  reads through the wiring gate's own scanner and import parser
  (`scan`, `moduleEdges` from `scripts/wiring-map.mjs`) instead of a
  hand-written regex, and adds one test (17).
- `test/decision-inbox.test.js` — already asserted `sport: 'NHL'` is
  rejected (`/invalid sport/`, line 77). Extended with the equivalent
  assertion for `'MLB'`, which the existing test did not cover because
  nothing wired-in ever called `publishRecommendation` with it.

No new test file and no new production file. Round 2 deletes three files:
`server/routes/props.js`, `server/routes/props-tickets.js` and their
dedicated test `test/props-saved-tickets.test.js`. It also removes the two
routers from `test/legacy-route-security.test.js`, whose own app mounted
them. `docs/wiring/annotations.json` is byte-identical to `origin/main`
(`git diff origin/main -- docs/wiring/annotations.json` prints nothing).

## What was found, each confirmed with `git grep` before touching anything

1. **`server/services/odds-api.js`** exported `MLB_SPORT`, `MLB_MARKETS`,
   `mlbEvents`, `mlbEventOdds`. `git grep -n "MLB_MARKETS\|mlbEvents\b
   \|mlbEventOdds\|MLB_SPORT" -- server scripts client/src test` found their
   own definitions and nothing else — #128 deleted routes/mlb.js, their only
   caller.
2. **`server/routes/decision-inbox.js`**'s `VALID_SPORT` still had `'MLB'`.
   `publishRecommendation`'s two wired-in callers (`waiver-brain.js:365`,
   `trade-engine.js:2899`) both always pass `'NFL'`, so this was an accepted
   input with no current writer — but still an input the module would store
   rather than reject.
3. **`server/index.js`** still mounted `/api/props` and `/api/props-tickets`
   (server/routes/props.js, "MLB prop research board", and
   props-tickets.js, "Saved MLB prop slips"). `git grep -n mlb -- server/index.js
   server/routes client/src` plus a direct check of `client/src` for
   `api/props` and `api/props-tickets` found zero client callers of either
   path. Round 1 unmounted them; round 2 deletes both files (see below).

A fourth was found only by running the wiring gate against the fix for (3),
not by the original grep pass: unmounting `props.js` stops anything from
ever writing `props_auto_picks` again (its only writer was
`ensureAutoPicksFor()` at `server/routes/props.js:148`, called by `GET
/auto-picks` at `:172`, on `f749c778`), and `server/routes/betting-hub.js`'s
`mlbStanding()` read that table on every `/api/betting/summary` request —
its own comment says the record "needs the results feed, which the props
route already proxies." Left in place, that is a route silently answering
from a feed that stopped: the exact shape #128's own commit called out when
it took the MLB jobs and router out together rather than leaving one half
standing. `node scripts/wiring-map.mjs --check` turned this from a
judgement call into a measured fact — before the betting-hub fix it reported
`table-hand-fed props_auto_picks`; after, that finding is gone.

## Review round 2: what the reviewers found, and what changed

**Finding 1 (wiring and consumer): two unwired modules behind an
accept-list.** Round 1 added `server/routes/props-tickets.js` and
`server/routes/props.js` to `accepted_orphan_modules` in
`docs/wiring/annotations.json:65-66`. That file belongs to the wiring thread
(WORK-QUEUE F-10), and merge gate v2 section 1.6 says not to add accept-list
entries in files you do not own. Reproduced on the merged tree `f749c778`
(tree `ce5c4286`), in a scratch worktree:

```
$ node scripts/wiring-map.mjs --check            # as round 1 left it
no missing-feed findings                          # exit 0
$ sed -i '' '/"server\/routes\/props-tickets.js",/d; /"server\/routes\/props.js",/d' docs/wiring/annotations.json
$ git diff origin/main -- docs/wiring/annotations.json    # (empty: identical to main)
$ node scripts/wiring-map.mjs --check                       # exit 1
2 blocking finding(s) — something a surface needs that nothing produces, or something built and wired to nothing:
  module-only-tested server/routes/props-tickets.js — imported only by its test (test/legacy-route-security.test.js, test/props-saved-tickets.test.js) — built, verified, never wired in
  module-only-tested server/routes/props.js — imported only by its test (test/legacy-route-security.test.js) — built, verified, never wired in
```

Fix, in GREEN (2): delete both routers and `test/props-saved-tickets.test.js`
(8 tests of a router nothing serves); drop the props lines from
`test/legacy-route-security.test.js` (it mounted both on its own app and
asserted 401, while the real app now answers 404: see Verification); put
`annotations.json` back to `origin/main`; reword the note in `server/index.js`
where the mounts were. No table is touched (test 17 pins it).

**Finding 2 (test liveness): a wrong RED count, and five mutants the tests
let through.** The count is corrected under "The RED failures, verbatim".
The replay below, at the round 1 head `40ffeee0`, uses the same harness and
mutant definitions as the round 2 sweep. It shows the five survivors, plus two
mutants the round 1 tests did kill, as a check that the replay can kill:

```
$ node docs/tdd/sweeps/sy-06-mlb-leftovers-mutations.mjs --rev 40ffeee02487f72e28e6b563bbc04c8317f147a6 \
    --only OA-U3,IX-C2,IX-C3,IX-C4,BH-C1,IX-C1,DI-U1
SY-06 mutation sweep at 40ffeee0 (tree 4c7537620a8a07e7641a85b59a30fadb9b987aeb); tests: test/mlb-removed.test.js, test/decision-inbox.test.js
baseline: exit 0, 16 tests, 0 failing
SURVIVED OA-U3 [unit] the MLB events export under a new name (survived the head-40ffeee0 test)
killed   DI-U1 [unit] 'MLB' back in VALID_SPORT (the exact pre-fix line)  <- a publish with sport MLB is rejected rather than stored, same as any other invalid sport
KILLED BY ANOTHER TEST IX-C1 [call-site] index.js regains the base's two dynamic imports and mounts (a stale merge)  <- the MLB props board and its saved-ticket router are not mounted
SURVIVED IX-C2 [call-site] static import, template-literal mount at /api/props (survived at 40ffeee0)
SURVIVED IX-C3 [call-site] static import, mounted at a new path /api/mlb-props (survived at 40ffeee0)
SURVIVED IX-C4 [call-site] betting-hub.js mounts the board at /api/betting/props (survived at 40ffeee0)
SURVIVED BH-C1 [call-site] a props key on /summary reads props_auto_picks (survived at 40ffeee0)
```

(IX-C1 reads "another test" only because round 1's test 15 had a different
name; it is the test built for it.) The cause is what the reviewer named:
test 15 matched only the exact `import('./routes/props.js')` spelling in
`server/index.js`, narrower than #128's `/routes\/mlb\.js/`, because a broad
pattern would have hit round 1's own comment at `server/index.js:139`. Test 16
had no assertion on `props_auto_picks`, and test 14 named four symbols but
not the MLB sport key. Fix, in RED (3): the pins read code through the wiring
gate's scanner (comments blanked, strings kept), so a comment can no longer
force a narrow pattern:

- test 14 also asserts no live file under `server/` or `scripts/` names
  the Odds API's MLB sport key `'baseball_mlb'`. That covers a renamed export
  and a caller in another file. Known-live control: `'americanfootball_nfl'`
  is found in `odds-api.js`;
- test 15 asserts both router files are gone. It then scans every live file
  under `server/` and `scripts/` for an import of either (static, bare,
  re-export or dynamic, through the gate's own `moduleEdges`, with the
  specifier resolved against the importing file), and matches the two mounts
  in any quote style. Known-live control: `server/index.js` is found
  importing `routes/betting-hub.js`;
- test 16 also asserts `betting-hub.js` names no `props_auto_picks`;
- test 17 (new) asserts `props_auto_picks` (`core-and-fantasy.js`) and
  `saved_prop_tickets` (migration 018) are still declared, that no other
  migration drops either, and that no live file outside the schema and
  migrations reads or writes either. Known-live control: `decision-inbox.js`
  is found using `decision_recommendations`.

## TDD record

| | commit subject | sha |
| --- | --- | --- |
| RED | `test: pin the three MLB leftovers #128 missed (SY-06)` | `98972a7` |
| RED (2) | `test: pin that betting-hub.js drops mlbStanding with props.js (SY-06)` | `b2406c9` |
| GREEN | `fix: close the three MLB leftovers #128 missed (SY-06)` | `b8d155a` |
| merge | `Merge origin/main into claude/cloud-sy-06-mlb-leftovers` (main at `a3e2bf35`) | `f749c778` |
| RED (3) | `test: pin that the MLB props routers are deleted, not accept-listed (SY-06)` | `52f69941` |
| GREEN (2) | `fix: delete the MLB props routers instead of accept-listing them (SY-06)` | `eaf35c96` |

RED (2) exists because the fourth item was found only after RED landed and
the wiring gate was run against the unmounted-props fix — see above. RED (3)
and GREEN (2) are the review round. All five are ancestors of the pushed head
(`git merge-base --is-ancestor <sha> HEAD` for each).

Every count below is from `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<fresh temp
file> NODE_OPTIONS='--import ./test/offline-guard.mjs' node
--experimental-test-module-mocks --test --test-concurrency=1
--test-reporter=tap <files>` on a clean checkout of the named commit
(`git diff HEAD` empty), Node 25.9.0. Test numbers are from a run of
`test/decision-inbox.test.js` + `test/mlb-removed.test.js`, where
decision-inbox's are 1-8 and mlb-removed's are 9 onward.

### The RED failures, verbatim

At `98972a7` (`test/mlb-removed.test.js` + `test/decision-inbox.test.js`),
15 tests, 12 pass, 3 fail:

```
not ok 14 - odds-api.js no longer exports MLB-only symbols
  error: 'odds-api.js still defines MLB_MARKETS, a dead MLB-only export nothing calls'

not ok 15 - the MLB props board and its saved-ticket router are not mounted
  error: 'server/index.js still imports the MLB props router'

not ok 4 - a publish with sport MLB is rejected rather than stored, same as any other invalid sport
  error: 'Missing expected exception.'
```

At `b2406c9` (`test/mlb-removed.test.js` alone), 8 tests, 5 pass, 3 fail.
Tests 6 and 7 still carry RED 1's failures because GREEN had not landed;
test 8 is RED (2)'s own. (Round 1 of this file said 7 pass and 1 fail, a
count that needs GREEN's odds-api.js and index.js edits present but
uncommitted; it was not measured on `b2406c9`.)

```
not ok 6 - odds-api.js no longer exports MLB-only symbols
  error: 'odds-api.js still defines MLB_MARKETS, a dead MLB-only export nothing calls'
not ok 7 - the MLB props board and its saved-ticket router are not mounted
  error: 'server/index.js still imports the MLB props router'
not ok 8 - betting-hub.js no longer computes an MLB standing from the now-unmounted props route
  error: 'betting-hub.js still defines/calls mlbStanding(), which reads props_auto_picks -- a table
  nothing writes once props.js is unmounted'
```

At `52f69941` (`test/decision-inbox.test.js` + `test/mlb-removed.test.js`),
17 tests, 15 pass, 2 fail:

```
not ok 15 - the MLB props board and its saved-slip router are deleted, and nothing live imports or mounts them
  error: 'server/routes/props.js is still in the tree. It is MLB code with no mount and no client caller,
  kept alive only by its own tests; MLB is gone from the product (#128)'

not ok 17 - props_auto_picks and saved_prop_tickets stay on disk, and nothing live reads or writes them
  error: these files read or write props_auto_picks, which has had no producer since the MLB props board was deleted
    + [ 'server/routes/props.js' ]
    - []
```

### GREEN

- At `b8d155a`, `test/mlb-removed.test.js` + `test/decision-inbox.test.js`:
  16 tests, 16 pass, 0 fail.
- At `eaf35c96`, `test/decision-inbox.test.js` +
  `test/legacy-route-security.test.js` + `test/mlb-removed.test.js`:
  23 tests, 23 pass, 0 fail (8 + 6 + 9). The same three files plus
  `test/props-saved-tickets.test.js` on `f749c778`, before round 2: 30 tests,
  30 pass.

## Liveness

**Round 1: RED fails with the implementation reverted.** Checked out each
of the four production files at `b8d155a~1` (pre-GREEN) on top of the GREEN
test files and re-ran:

```
not ok 4 - a publish with sport MLB is rejected rather than stored, same as any other invalid sport
not ok 14 - odds-api.js no longer exports MLB-only symbols
not ok 15 - the MLB props board and its saved-ticket router are not mounted
not ok 16 - betting-hub.js no longer computes an MLB standing from the now-unmounted props route
# tests 16
# pass 12
# fail 4
```

Restored to `b8d155a` afterward; `git write-tree` before and after the round
trip was `af97f19852034ba0aa7ed8becbfa43bc6f45e767`, which is `b8d155a`'s
own tree (`git rev-parse b8d155a^{tree}`).

**Round 2: the final tests against the unfixed code.** `eaf35c96`'s two test
files on `d3dca8b6`'s code (the base, before any SY-06 change): 17 tests, 12
pass, 5 fail. Tests 4, 14, 15, 16 and 17 fail. Test 17 names both readers
of the stopped feed, which is its known-nonzero case on real history:

```
not ok 17 - props_auto_picks and saved_prop_tickets stay on disk, and nothing live reads or writes them
    + [ 'server/routes/betting-hub.js', 'server/routes/props.js' ]
```

Test 15 fails there on its first assertion (the files exist), so its import
scan was also run on its own against real history. The same logic as the
test's `importersOf()`, run by a scratch script over each checkout:

```
d3dca8b6  {"props":["server/index.js"],"bettingHubControl":["server/index.js"]}
eaf35c96  {"props":[],"bettingHubControl":["server/index.js"]}
```

The new assertions that pass on `52f69941` and on the base's code only
because an earlier assertion fails first (test 14's sport key, test 16's
`props_auto_picks`) are shown live by their own mutants: OA-U3, OA-C1 and
BH-C1 below each die on exactly that assertion.

## Mutation sweep

Harness: `docs/tdd/sweeps/sy-06-mlb-leftovers-mutations.mjs`, committed with
this file. It makes a throwaway worktree at HEAD with node_modules linked,
applies one mutant, runs `test/mlb-removed.test.js` and
`test/decision-inbox.test.js` on a fresh temp database with the offline guard,
restores, and checks the worktree is clean before the next. Every anchor must
occur exactly once and every created file must be absent, or the mutant is
reported NOT APPLIED, never run on the unmutated tree. A kill counts only if
the test built for that mutant is among the failures.

Run at `eaf35c96` (tree `b853418fa4dce9efa7abe02442343a56928f5bbc`), exit 0,
5 min 40 s wall time with the machine at load 11 to 18 from other jobs.
Baseline: 17 tests, 0 failing. **28 of 28 mutants killed by the test built
for them (16 unit, 12 call-site); both surviving controls survived; both
not-applied controls were reported not applied.**

| Id | Kind | Mutant | Result |
|---|---|---|---|
| OA-U1 | unit | the four removed MLB exports, restored verbatim | killed (14) |
| OA-U2 | unit | an unexported `MLB_SPORT` constant | killed (14) |
| OA-U3 | unit | the MLB events export renamed `baseballEvents` (survived at `40ffeee0`) | killed (14) |
| OA-C1 | call-site | `betting-hub.js` asks the shared `sportEvents()` for `'baseball_mlb'` | killed (14) |
| DI-U1 | unit | `'MLB'` back in `VALID_SPORT`, the exact pre-fix line | killed (4) |
| DI-U2 | unit | the sport check moved after the insert: rejects but leaves the row | killed (4; 3 also fails) |
| DI-U3 | unit | MLB dropped silently (returns null) instead of rejected | killed (4) |
| DI-C1 | call-site | the predicate is handed `'NFL'` when the caller sent `'MLB'` | killed (4) |
| DI-C2 | call-site | the caller's `'MLB'` coerced to `'NFL'` before the check | killed (4) |
| IX-U1 | unit | `server/routes/props.js` restored from the base, unmounted | killed (15, 17) |
| IX-U2 | unit | `server/routes/props-tickets.js` restored from the base, unmounted | killed (15, 17) |
| IX-C1 | call-site | `index.js` regains the base's two dynamic imports and mounts (a stale merge) | killed (15) |
| IX-C2 | call-site | static import, template-literal mount at `/api/props` (survived at `40ffeee0`) | killed (15) |
| IX-C3 | call-site | static import, mounted at a new path `/api/mlb-props` (survived at `40ffeee0`) | killed (15) |
| IX-C4 | call-site | `betting-hub.js` mounts the board at `/api/betting/props` (survived at `40ffeee0`) | killed (15) |
| IX-C5 | call-site | `betting-hub.js` re-exports the saved-slip router | killed (15) |
| IX-C6 | call-site | a script under `scripts/` imports the saved-slip router | killed (15) |
| IX-C7 | call-site | dynamic import in double quotes | killed (15) |
| IX-C8 | call-site | a mount at `/api/props-tickets` with no import | killed (15) |
| IX-C9 | call-site | the board copied to `routes/mlb-board.js`, mounted at `/api/mlb-board` | killed (17) |
| IX-C10 | call-site | the slip router copied to `routes/slips.js`, mounted at `/api/slips` | killed (17) |
| BH-U1 | unit | `mlbStanding()` and the `mlb` key restored verbatim | killed (16, 17) |
| BH-U2 | unit | the same read renamed `baseballRecord()`, `mlb` key kept | killed (16, 17) |
| BH-C1 | call-site | a `props` key on `/summary` reads `props_auto_picks` (survived at `40ffeee0`) | killed (16, 17) |
| BH-C2 | call-site | `nfl-betting.js` reads `props_auto_picks` | killed (17) |
| BH-C3 | call-site | a `slips` key on `/summary` reads `saved_prop_tickets` | killed (17) |
| TB-U1 | unit | `props_auto_picks` renamed out of its declaration | killed (17) |
| TB-U2 | unit | a new migration drops `props_auto_picks` | killed (17) |
| CTRL-S1 | **designed survivor** | a comment in `index.js` quoting the deleted import lines and mounts | **survived** |
| CTRL-S2 | **designed survivor** | a live NFL player-props read (`nfl_props: propEdgeEvidence()`) on `/summary` | **survived** |
| CTRL-NA1 | **not-applied control** | anchor is the pre-fix `VALID_SPORT` line, absent at HEAD | **not applied** (anchor found 0 times) |
| CTRL-NA2 | **not-applied control** | create a file that already exists (`betting-hub.js`) | **not applied** |

Why the survivors must survive. CTRL-S1 is the reason the round 1 pattern was
narrow: if a comment naming the deleted routers could fail the tests, the
tests would be reading prose, and the note in `server/index.js` could not
exist. CTRL-S2 is live NFL product (`server/services/nfl-prop-clv.js`). The
pins name MLB's tables, keys and sport, not the word "props". If either were
killed, the tests would over-pin.

What the unit and call-site rows cover per behaviour change. odds-api: the
export itself (U1-U3) and a caller handing a shared function the MLB key
(C1). Decision inbox: the allow-list and where it is enforced (U1-U3), and the
argument handed to the `VALID_SPORT` predicate (C1-C2). Routers: the files
(U1-U2), and an import or a mount from any file in any form, or a copy under
a new name (C1-C10). Betting hub: its own standing (U1-U2), and a read of
either table under another name, key or file (C1-C3). Tables: the
declaration and a drop (U1-U2).

Round 1's single mutant (re-adding `'MLB'` to `VALID_SPORT`) is DI-U1 above.

## Verification

- Wiring gate, `node scripts/wiring-map.mjs --check`, on the tree committed
  as `eaf35c96` (tree `b853418f`): exit 0, `no missing-feed findings`,
  output identical line for line to the merged tree's before round 2 (47
  lines, `diff` empty), with no `props` line at all. Its known-nonzero case
  is the `exit 1, 2 blocking finding(s)` run above.
  `git status --porcelain` was unchanged by the run.
- The real app, booted from the GREEN tree (`node server/index.js`,
  isolated temp database, `SCHEDULER_DISABLED=1`, a spare port, stopped by
  SIGTERM afterwards; scratch probe script):

  | path | anonymous | with a local session |
  |---|---|---|
  | `/api/teams` (control) | 401 | 200 |
  | `/api/props` | 404 | 404 |
  | `/api/props/board` | 404 | 404 |
  | `/api/props/auto-picks` | 404 | 404 |
  | `/api/props-tickets` | 404 | 404 |

  So the app boots without the two modules, and the old
  `legacy-route-security` assertion (401 from a test-only mount) described
  an app that no longer exists.
- Row counts, on a local copy, not production
  (`sqlite3 ~/gridiron-local/data.sqlite ".backup ..."`, 2026-09-23T00:34:25Z,
  deleted after counting): `props_auto_picks` 0, `saved_prop_tickets` 0;
  known-nonzero controls `decision_recommendations` 7,
  `schema_migrations` 67. No saved slip or auto-pick is stranded by
  the deletion on this install; production was not read.
- `node --check` on every changed `.js`/`.mjs` file: clean.
- Full suite: **not re-run locally in round 2.** The standing rule for this
  machine is targeted tests only, and CI (Node 22) runs `npm run check` on
  the pushed head. Round 1's full run (`npm ci`, then `npm run check` once:
  4047 tests, 4006 pass, 0 fail, 41 skip; wiring exit 0; build and smoke
  passed) was on tree `af97f19852034ba0aa7ed8becbfa43bc6f45e767`
  (`b8d155a`), before round 2 and before the merge of main. Its wiring
  exit 0 depended on the two accept-list entries round 2 removed, so it is
  superseded.
- Acceptance grep on `eaf35c96`:
  `git grep -n -i "mlb" -- server/services/odds-api.js server/routes server/index.js client/src`.
  `odds-api.js` has zero hits. The rest are Middle Linebacker code #128
  already protects (`FormationView.tsx`, `nfldata.js`), comments
  (`App.tsx`, `navigation.ts`, `StaleBanner.tsx`, `index.js`,
  `betting-hub.js`, `decision-inbox.js`, `nfldata.js:213`), and one false
  hit (`HTMLButtonElement` in `DesignSystem.tsx`). The two routers' own MLB
  doc comments are gone with the files.

## Nick's five questions

- **Well built?** Yes, for its scope. Round 1 made four small diffs to
  odds-api, the decision inbox, index.js and betting-hub. Round 2 deletes two
  dead routers and their test, restores one file it should not have touched,
  and rebuilds the tests. There are no new abstractions: the tests reuse the
  wiring gate's own scanner and parser, so "imports" means the same thing in
  this test and in `check:wiring`.
- **Stats or made up?** Neither applies: this is dead-code removal, and no
  number feeds a model or a page. Every "nothing calls this" claim is a
  command above with its tree.
- **How do we know?** TDD, not a backtest. Three RED commits failed for the
  stated reason on clean trees, and two GREEN commits pass. The final tests
  fail five ways on the base's code. The sweep kills 28 of 28 mutants on the
  test built for each, and its controls behave as designed. The five mutants
  that beat round 1's tests are killed. Nothing here is a hand-set constant.
- **Pointed anywhere else?** Yes. `betting-hub.js`'s `mlbStanding()`, the
  reader of the stopped feed, is removed. No other live reader exists: test
  17 scans every live file under `server/` and `scripts/`. The two routers
  had no client caller and no nav entry, so the nav stays 8 tabs.
- **How does it unify?** One producer or none. `props_auto_picks` and
  `saved_prop_tickets` now have neither a writer nor a reader, and a test says
  so. The alternative was a table that still answers with frozen rows, or two
  modules the gate calls built and never wired in. MLB props leave the same
  way #128 took MLB out: code removed, tables and rows kept.

**Defect fixed.** On `f749c778` (merged tree): `server/routes/props.js` and
`server/routes/props-tickets.js` were imported only by tests, and
`docs/wiring/annotations.json:65-66` accept-listed them. Round 1's own
defects were `server/services/odds-api.js:19,157-160`,
`server/routes/decision-inbox.js:26`, `server/index.js:45-46,141-142` and
`server/routes/betting-hub.js:67-75,112` (on `d3dca8b`).

**Incumbent, by command.** `node scripts/wiring-map.mjs --check` on
`f749c778` exits 0 only with the two accept-list lines, and exits 1 without
them. At `40ffeee0`, the tests pass with the props board re-mounted
(IX-C2/C3/C4) or its table read again (BH-C1), per the replay above.

**Does NOT cover.**
- The rows: the two tables and any rows stay. Dropping them needs Nick's
  word, and there are 0 of each on the local copy.
- Provenance lists that still name `server/routes/props.js`. These are
  `server/db/schema/core-and-fantasy.js:34,367`, its `manifest.json:97-107`,
  `scripts/schema-files.txt:7` and a note in `mlb-model-misc.manifest.json:126`.
  #128 left its deleted MLB services in the same lists
  (`mlb-model-misc.js`'s `sources` still names 6 deleted files), and
  `scripts/schema-snapshot.mjs:64` skips a listed file that does not exist.
  These files are not SY-06's.
- `client/src/components/StaleBanner.tsx`, the MLB board's stale-slate
  banner, which nothing in `client/src` imports. It is a client file outside
  this unit's allocation, so it is reported, not edited.
- `docs/inventory/CONTRACT.md` and `inventory.json` still describe both
  routes as mounted (generated inventory, another thread).
- The PR body's section 1 figures, which are round 1's.

**What would make it wrong.**
- A consumer outside this repository calling `/api/props` or
  `/api/props-tickets` (none is known, and the private upstream repo is the
  data source, not a caller).
- A way to load a router that the gate's import parser cannot see, such as a
  computed specifier. With the files deleted, it would also need a file to
  load, and test 15 or 17 fails on any copy that writes either table.
