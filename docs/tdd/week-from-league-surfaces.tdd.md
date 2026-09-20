# TDD evidence (retroactive): seven surfaces priced for the league's week

**Change.** `claude/project-thread-5f9c3y-week-callers`, PR #64, one commit
(`7eb5118`) on top of `791b131`.

**Defect.** PR #57 taught `tradeWeekContext()` to prefer the league's own week and
fixed the eight call sites inside `trade-engine.js`. Seven call sites in four other
service files still called it with no argument, so they kept deriving the week from
`game_lines` — the betting feed — and fell back to week 1 whenever that table had
no unscored row for the season:

| File | Line | Surface |
|------|------|---------|
| `waiver-brain.js` | `:175`, `:210`, `:372` | the waiver list, sell-high, the free-agent pool |
| `roster-risk.js` | `:89`, `:158` | bye risk, bye patches |
| `waiver-wire.js` | `:157` | the waiver board |
| `trend-exploits.js` | `:141` | trend exploits |

Each of these had the league in hand already. Bye risk is the sharpest case: it
counts forward from "now", so a week-1 answer in week 2 shifts every bye it
reports.

## RED (`test/week-from-league-surfaces.test.js`, 7 tests, at `791b131`)

```
# tests 7
# pass 1
# fail 6
ok 1 - no betting line is loaded, so the old path really does answer week 1
not ok 2 - the waiver list is priced for the league's week
not ok 3 - sell-high is priced for the league's week
not ok 4 - the waiver board is priced for the league's week
not ok 5 - bye risk counts from the league's week, not from week 1
not ok 6 - bye patches inherit the same week
not ok 7 - the free-agent pool itself is priced on the league's week
```

Test 1 is the premise, not a behaviour: it establishes that the fixture really
does leave the betting table unable to answer, so that tests 2-7 are reading the
league and not coincidentally agreeing with `game_lines`. Without it, all six could
pass against a fixture where both paths happen to say the same number, and the file
would prove nothing.

**Test 1 originally did not check what its title claimed**, and an injection is
what found it — see below.

## Injections

Test 1 is the only one that passes at `791b131`, so the RED run does not prove it.
Injected against the fixed code: the no-league fallback changed from 1 to 7.

```js
-     WHERE season=? AND team_score IS NULL`, SEASON)[0]?.week || 1;
+     WHERE season=? AND team_score IS NULL`, SEASON)[0]?.week || 7;
```

The whole file stayed green — 7 passed, 0 failed. Test 1 asserted only
`SELECT season FROM game_lines` is empty, under the title "the old path would
answer week 1": it named a consequence and checked a precondition. A reader would
have taken it as pinning the fallback. It now also asserts

```js
assert.equal(tradeWeekContext().week, 1);
assert.notEqual(LEAGUE_WEEK, 1, 'and the league week must differ from it, …');
```

and the same injection then fails it:

```
# tests 7
# pass 6
# fail 1
not ok 1 - no betting line is loaded, so the old path really does answer week 1
```

The second assertion matters as much as the first: without it, tests 2 to 7 could
each be comparing the league's week against a betting-table week that happened to
agree, and the file would prove nothing about which source was read.

## Is this well built

- **Well built:** yes; it is seven call sites that already had the league in hand
  being given it. No new concept.
- **Stats, or made up:** nothing is estimated here at all. Every one of these
  reads is a lookup.
- **How we know:** the seven tests, each asserting the league's week reaches a
  named surface. Bye risk is the one where being wrong costs the most, because it
  counts forward from "now": answering week 1 in week 2 shifts every bye it
  reports by one.
- **Pointed anywhere else:** the sweep behind this PR covered `server/services/`.
  Any *future* caller of `tradeWeekContext()` that has a league and forgets to
  pass it reintroduces the bug silently, because the wrong answer is a plausible
  number rather than an error. A lint rule, or making the argument required with
  an explicit `null` for the no-league callers, would close that for good and is
  not in this PR.
- **How it unifies:** after this there is one week-for-a-league in the fantasy
  half of the app, and `game_lines` is consulted only where there is no league.

## GREEN

At `7eb5118` all 7 pass, and the full suite is green: 2,967 tests, 0 failed, with
typecheck, lint, build and `start:smoke` clean.

## On this PR's red check

The check run on `7eb5118` (`35480265803`) is red because the account's GitHub
Actions minutes are exhausted, not because of this diff: one job, created
01:01:01Z and completed 01:01:03Z, no steps recorded, empty output — no runner was
ever allocated. Every run in the repository from 01:00:24Z has the same shape, and
the base branch is identically red. The local run above is this change's proof.
