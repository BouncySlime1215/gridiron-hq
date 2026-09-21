# TDD evidence (retroactive): the simulator reads the league, not two constants — 2026-09-20

**What this is.** PR #40 changed two gated behaviours in the season simulator: the week a
simulation starts from, and the shape of the playoff bracket. Both were pre-existing
constants that the code around them already knew were wrong, and both are documented in
the PR body with measurements. What was missing was this file: `CLAUDE.md` asks for a RED
commit, a GREEN commit and an evidence record under `docs/tdd/`, and #40 shipped the
tests without the record.

**How the retroactive RED was shown.** The code already works, so a test written now
passes at the branch head. Each guarded rule was therefore reverted in place — one
mutation at a time, restored from a pristine copy between runs — and the test files were
re-run against it. A rule no mutation can fail is a rule nothing tests, and the sweep
found exactly one of those; see the last row and the section below it.

| Behaviour in #40 | Guarded rule | Tests | Mutation | Caught |
|---|---|---|---|---|
| `GET /:leagueId/simulate` starts from the league's real week | `Number(req.query.from_week) \|\| leagueCurrentWeek(lg)` | `test/model-sim-from-week.test.js` (7) | reverted to `\|\| 1` | 3 of 7 fail |
| `POST /:leagueId/trade-impact` likewise | same, in the body | same file | reverted to `\|\| 1` | 1 fails |
| The bracket comes from the league's own schedule | `playoffRounds` reading `matchupPeriods` / `playoff_week_start` | `test/season-sim-playoff-shape.test.js` (9) | `playoffRounds` returns the fallback constant unconditionally | 5 of 9 fail |
| A field of *n* gets ceil(log2(n)) rounds, not however many periods the payload lists | `bracket.slice(0, roundsNeeded)` | same file | `slice` removed | 1 fails |
| **A multi-week round is decided on the TOTAL of its weeks** | the sum over `drawnWeeks` in the bracket loop | **nothing, before today** | first week only | **0 of 9 — see below** |

## The rule nothing tested

The mutation that matters most was the one that survived. Replacing

```js
return drawnWeeks.reduce((sum, w) => sum + lineupPoints(players, slots, w.drawn, w.expected), 0);
```

with a read of `drawnWeeks[0]` alone left **all nine** playoff-shape tests passing:

```
### M5: a multi-week round scored on its first week only
# pass 9
# fail 0
```

That mutation is precisely the defect #40 exists to fix. `playoffRounds` was tested
thoroughly as a pure function — it returns `[[14, 15], [16, 17]]` for league 4 as synced —
but nothing asked what `simulateSeason` then *does* with a two-week round. A bracket
helper that returns the right weeks and a simulator that plays only half of them produce
the same wrong odds as the constant did, and every test would have stayed green.

`test/season-sim-multi-week-round.test.js` (3 tests) closes it, and drives the simulator
rather than the helper:

- The two fantasy teams are built entirely on opposite NFL teams, and those NFL teams
  take their byes in opposite halves of the round — the home side has no `schedule_games`
  row in week 16, the away side none in week 17. `season-sim.js:295` scores a player with
  no NFL game that week as nothing, which is the mechanism this leans on.
- Over a two-week round each side therefore scores in exactly one of the two weeks, the
  matchup is symmetric, and neither side can be shut out. Scored on week 16 alone the
  home side scores nothing at all and loses every run.
- **Symmetry is the assertion.** No seed, no point total and no exact share is pinned —
  only that both sides clear 15% of the titles.
- The third test is the control: the same fixture with the round as week 16 alone must
  still be lopsided. Without it, a fixture that quietly stopped biting would leave the
  second test proving nothing.

After the new file, the same mutation fails:

```
### M5 again, now against the new test file
not ok 2 - a two-week round is decided on the total, so a week-16 bye is not a lost title
# pass 11
# fail 1
```

The sampler is stubbed in that file on purpose. What is under test is which weeks a round
is scored over; a real projection-params fixture would make the result depend on the
scoring model as well, and the first version of this test did exactly that and read
`expected_points: 0` for both sides — every lineup scoring nothing, every week tying, and
the title going to the better seed deterministically. A fixture that produces no points
cannot distinguish a one-week round from a two-week one, so that version would have
passed under the mutation for the wrong reason.

## The other four mutations, as run

```
### M1: /simulate default back to 1
not ok 1 - GET /simulate defaults to the league's current week, not 1
not ok 3 - the cache key follows the resolved week, so two leagues cannot share a result
not ok 6 - a league with no current_week column falls back to the payload, still not 1
# pass 4
# fail 3

### M2: /trade-impact default back to 1
not ok 4 - POST /trade-impact defaults to the current week too
# pass 6
# fail 1

### M3: playoffRounds always returns the old constant
not ok 1 - a league whose bracket matches the old constant still gets 15, 16, 17
not ok 2 - a two-week-round league gets its real bracket, which the constant got wrong
not ok 4 - a schedule with fewer playoff periods than the field needs says so
not ok 5 - Sleeper is read from playoff_week_start, one week per round
not ok 8 - malformed week entries inside a real periods map are dropped, not trusted
# pass 4
# fail 5

### M4: rounds count from the periods listed, not ceil(log2(teams))
not ok 3 - the number of rounds is what the field needs, not how many periods are listed
# pass 8
# fail 1
```

M3 failing test 1 — *"a league whose bracket matches the old constant still gets 15, 16,
17"* — is worth reading twice. That test passes under the mutation's *output* and fails on
its `basis`: the fallback reports `default_weeks_15_17` where the league-derived answer
reports `league_schedule`. The two are the same weeks for leagues 2 and 5, and the basis
label is the only thing that distinguishes a bracket read from the league from one
guessed at. That is why the field exists and why it is asserted.

## What the measurements were, and where they live

Both numbers in #40's body were measured before the change and are not re-derived here:
playoff odds moving 9.5 points on average and 15.3 at most across ten teams on league 5,
from discarding one played week; and league 4's real `matchupPeriods` mapping period 14 to
NFL weeks `[14, 15]` and period 15 to `[16, 17]`. The fixtures in
`season-sim-playoff-shape.test.js` are those real `scheduleSettings` as synced on
2026-09-19, not invented ones, because the whole point is that actual leagues disagree
with the constant.

`matchups.js:392` had already written down that the default "is right for a 14-week
regular season with one-week playoff rounds and wrong for leagues 1 and 3 as synced", and
`league-week.js`'s header had already written down "Never a hard-coded 1 — that is how the
app spent two weeks showing week-1 lineups (2026-09-17)". Both defects were documented in
the codebase before #40; neither was tested, and neither was fixed.

## Verification

Branch `claude/project-thread-f921do-sim` at the head this file is committed on. Full
local run stated in the commit, taken in place of CI while the repository's only workflow
is disabled.
