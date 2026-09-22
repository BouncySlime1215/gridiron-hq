# SY-06: the three MLB leftovers #128 missed

2026-09-22. Branch `claude/cloud-sy-06-mlb-leftovers`, off `main` at `d3dca8b`.
#128 (`bd56319`) removed MLB from the product — routes/mlb.js, eight MLB
services, five scheduled jobs — but its own census was scoped to what those
28 endpoints reached. Three things outside that census stayed live.

## Audit: extend, not build

Both test files this unit touches already existed and already carry the
"MLB is gone" contract:

- `test/mlb-removed.test.js` — #128's own sweep test (no MLB job, no
  `/api/mlb` mount, the eleven `mlb_*` tables kept, Middle Linebacker
  survives). Extended with three more assertions in the same style
  (`fs.readFileSync` + regex against source, matching the file's existing
  `read()` helper and assertion voice) rather than starting a new file.
- `test/decision-inbox.test.js` — already asserted `sport: 'NHL'` is
  rejected (`/invalid sport/`, line 77). Extended with the equivalent
  assertion for `'MLB'`, which the existing test did not cover because
  nothing wired-in ever called `publishRecommendation` with it.

No new test file. No new production file, except the accept-list entry
`docs/wiring/annotations.json` needs for two files this unit deliberately
un-wires (see below).

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
   path.

A fourth was found only by running the wiring gate against the fix for (3),
not by the original grep pass: unmounting `props.js` stops anything from
ever writing `props_auto_picks` again (its only writer was `GET
/auto-picks` in that router), and `server/routes/betting-hub.js`'s
`mlbStanding()` reads that table on every `/api/betting/summary` request —
its own comment says the record "needs the results feed, which the props
route already proxies." Left in place, that is a route silently answering
from a feed that stopped: the exact shape #128's own commit called out when
it took the MLB jobs and router out together rather than leaving one half
standing. `node scripts/wiring-map.mjs --check` turned this from a
judgement call into a measured fact — before the betting-hub fix it reported
`table-hand-fed props_auto_picks`; after, that finding is gone.

## TDD record

| | commit subject | sha |
| --- | --- | --- |
| RED | `test: pin the three MLB leftovers #128 missed (SY-06)` | `98972a7` |
| RED (2) | `test: pin that betting-hub.js drops mlbStanding with props.js (SY-06)` | `b2406c9` |
| GREEN | `fix: close the three MLB leftovers #128 missed (SY-06)` | `b8d155a` |

RED (2) exists because the fourth item was found only after RED landed and
the wiring gate was run against the unmounted-props fix — see above. Both
RED commits are ancestors of GREEN.

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

At `b2406c9` (`test/mlb-removed.test.js` alone), 8 tests, 7 pass, 1 fail:

```
not ok 8 - betting-hub.js no longer computes an MLB standing from the now-unmounted props route
  error: 'betting-hub.js still defines/calls mlbStanding(), which reads props_auto_picks -- a table
  nothing writes once props.js is unmounted'
```

### GREEN

At `b8d155a`, `node --test test/mlb-removed.test.js test/decision-inbox.test.js`:
16 tests, 16 pass, 0 fail.

## Liveness

**RED fails with the implementation reverted.** Checked out each of the
four production files at `b8d155a~1` (pre-GREEN) on top of the GREEN test
files and re-ran:

```
not ok 4 - a publish with sport MLB is rejected rather than stored, same as any other invalid sport
not ok 14 - odds-api.js no longer exports MLB-only symbols
not ok 15 - the MLB props board and its saved-ticket router are not mounted
not ok 16 - betting-hub.js no longer computes an MLB standing from the now-unmounted props route
# tests 16
# pass 12
# fail 4
```

All four new assertions failed exactly as they did in the RED commits.
Restored to `b8d155a` afterward (`git checkout b8d155a -- <the four files>`);
`git write-tree` before the revert-and-restore round trip and after it are
identical (`af97f19852034ba0aa7ed8becbfa43bc6f45e767`), so the check left no
residue.

**One mutant killed.** Re-introduced `'MLB'` to
`decision-inbox.js`'s `VALID_SPORT` (`new Set(['NFL', 'MLB'])`, the exact
pre-fix line) with every other file left at GREEN:

```
not ok 4 - a publish with sport MLB is rejected rather than stored, same as any other invalid sport
  error: 'Missing expected exception.'
```

Reverted the mutation; `test/decision-inbox.test.js` returned to 8/8 pass.

## Verification

- `npm ci`: clean install, 270 packages, 0 errors.
- `npm test` (full suite, `SCHEDULER_DISABLED=1`, offline guard):
  4047 tests, 4006 pass, 0 fail, 41 skip.
- `node scripts/wiring-map.mjs --check`: exit 0. `no missing-feed findings`;
  the two remaining `module-only-tested` findings for `server/routes/props.js`
  and `props-tickets.js` are the deliberate ones this unit adds to
  `docs/wiring/annotations.json`'s `accepted_orphan_modules`.
- `npm run check` (typecheck && lint && check:wiring && test && build &&
  start:smoke), run exactly once on the final tree: every stage passed
  through to `Application startup smoke passed on isolated database (32
  teams).`
- `git write-tree` before `npm run check`: `af97f19852034ba0aa7ed8becbfa43bc6f45e767`.
  After: same. The gate does not write to the tree (by its own design —
  `--check` skips the artifact-writing branch).
- Acceptance grep, run on the final tree:
  `git grep -n -i "mlb" -- server/services/odds-api.js server/routes client/src`
  — odds-api.js: zero hits. Remaining hits elsewhere are the Middle
  Linebacker code #128 already protects (`FormationView.tsx`,
  `nfldata.js`), comments (`App.tsx`, `navigation.ts`, `StaleBanner.tsx`,
  `betting-hub.js`, `decision-inbox.js` — the last two naming #128 or this
  unit directly), and the doc comments inside the now-unmounted
  `props.js`/`props-tickets.js`, which are dead files reachable from
  nothing live.

## Nick's five questions

- **Well built?** Four small, surgical diffs (8/18/5/6 lines) plus one
  two-line annotation entry. No new abstractions, no files added except the
  evidence doc itself.
- **Stats or made up?** Measured. Every "nothing else calls this" claim
  above is a `git grep` run before the edit, not an assumption — same for
  the wiring gate's before/after finding count.
- **How do we know?** TDD: four assertions failed for the stated reason
  before the fix and passed after, one revert-and-restore round trip
  reproduced all four failures verbatim, and one specific mutation
  (re-adding `'MLB'` to `VALID_SPORT`) was shown to fail the one test built
  to catch it.
- **Pointed anywhere else?** Yes — `server/routes/betting-hub.js`'s
  `mlbStanding()`. It wasn't named in the original three-item brief; the
  wiring gate surfaced it as a direct consequence of item 3, and it is the
  same "route answering from a stopped feed" bug shape #128 itself already
  named as the reason to remove jobs and routers together. Left alone it
  would have been a second copy of that bug, one hop downstream of this fix.
- **How does it unify?** Same failure mode as #128's own jobs+router
  coupling: removing one half of a read/write pair without removing the
  other leaves a surface that looks alive but silently stopped meaning
  anything. This unit closes that shape twice — once for the props write
  path, once (transitively) for betting-hub's read of it.
