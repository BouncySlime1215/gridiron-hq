# TDD evidence (retroactive): Start/Sit and the posture read their own league

**What this is.** Commit `1ed80a1` ("Start/Sit and the posture read their own
league, not the machine's", PR #60) changed two call sites and added one
exported function across 63 changed lines in `server/services/lineup-brain.js`
and 1 in `server/services/lineup-posture.js`, with
`test/lineup-reads-its-own-league.test.js` (7 tests) committed alongside.

There is no RED commit. The defect was not found from a specification; it was
found by reading the two call sites while doing the availability-basis sweep,
against code already shipped and already serving a wrong week. A RED commit
written afterwards would prove only that a test can be written to fail against
code already known to be wrong.

**How the retroactive RED was shown.** Each guarded rule was reverted in the
shipped source — one mutation at a time, a real edit to
`server/services/lineup-brain.js` or `server/services/lineup-posture.js`, run,
then restored. A test no mutation can fail proves nothing, so there is at
least one mutation per rule below and every one of them is caught by the test
that exists for it. Run at `1ed80a1` on 2026-09-20.

| Guarded rule | Mutation | Test that failed |
|---|---|---|
| The call is for the league's week, not the machine's | `tradeWeekContext(lg)` → `tradeWeekContext()` in lineup-brain.js | 1, 3 |
| The posture is about the same week as the call | `tradeWeekContext(lg)` → `tradeWeekContext()` in lineup-posture.js | 7 |
| Each call carries the model that priced THAT player | `playerAvailabilityBasis(p, availabilityBasis)` → `availabilityBasis?.basis ?? null` | 4 |
| A missing `availability_source` key is not a null one | `!player \|\| !('availability_source' in player)` → `!player` | 5 |
| Every source string maps to a basis | `'fitted availability by role'` → returns `'pooled'` | 4, 6 |

5 mutations, 5 caught, 0 that no test noticed.

## The rule this exists to protect

`tradeWeekContext()` with no league reads the lowest unscored week in
`game_lines` — the betting side's schedule table, which the fantasy half
neither owns nor fills — or `NFL_WEEK`. It returns one answer for the whole
machine, so a second league silently inherits the first's.

A wrong week here is not a label. It selects the projections, the bye flags
and the opponent, so the page is a confident lineup, and a confident matchup
read, for a week nobody is playing.

**#57 is a hard prerequisite.** `tradeWeekContext` takes a league only on #57
(`trade-engine.js:196`). On `main` at 791b131 the signature is still
`tradeWeekContext()` at `:172` and the argument is discarded in silence, so
this change built on a base without #57 compiles, lints, typechecks and
returns a plausible number while doing nothing at all. That was measured, not
assumed: built on #43's base alone, tests 1, 3 and 7 go red exactly as the m1
and m2 rows below do. The merge order is #57 → #43 → #60.

## Mutation output, pasted

### m1 — lineup-brain.js, the league argument dropped

```text
not ok 1 - the call is for the week the league says it is on, not the NFL week
  error: |-
    2 !== 7
not ok 3 - two leagues on different weeks get different calls in one process
  error: |-
    2 !== 3
# tests 7
# pass 5
# fail 2
```

### m2 — lineup-posture.js, the league argument dropped

```text
not ok 7 - the matchup posture is about the same week the call is
  error: |-
    2 !== 9
# tests 7
# pass 6
# fail 1
```

### m3 — the per-player basis replaced by the process basis

```text
not ok 4 - each call says which model priced that player, not which the process is on
  error: |-
    null !== 'pooled'
# tests 7
# pass 6
# fail 1
```

### m4 — the two absences conflated

```text
not ok 5 - the two absences of a source are not the same absence
  location: 'test/lineup-reads-its-own-league.test.js:136:1'
  failureType: 'testCodeFailure'
# tests 7
# pass 6
# fail 1
```

This is the mutation worth reading. `availability_source: null` means the
player had no availability row at all — `weeklyAvailability` selects QB, RB,
WR and TE only, so a kicker is not covered by the fit. The KEY being absent
means something else: an asset universe built before the field existed, which
is reachable because `assetUniverse` is fingerprint-cached on the row counts
and timestamps of the tables it reads, not on the code that built it, so a
deploy does not invalidate it. Reading the second as the first would mark
every player on the page, quarterbacks included, as one the fit does not
cover — a worse claim than the one the change removes.

### m5 — the role prefix mapped to the pooled basis

```text
not ok 4 - each call says which model priced that player, not which the process is on
  error: |-
    and this one did not — same page, same process
not ok 6 - every source string weeklyAvailability can build maps to a basis
# tests 7
# pass 5
# fail 2
```

## What this does not claim

Test 2 (a league with no recorded week falls back rather than failing) passes
before and after; it pins the fallback rather than the fix.

No live read backs this. Nothing was read from the deployed app for it, and
nothing here is a measurement of production: all seven tests build their own
isolated temp SQLite database and mock the asset universe.
