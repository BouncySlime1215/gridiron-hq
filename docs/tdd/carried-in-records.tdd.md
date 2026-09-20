# A simulation that carried in wins from weeks nobody played

2026-09-20. `server/services/season-sim.js`, `server/services/espn-weekly-scores.js`,
`test/season-sim-carried-records.test.js` (new). On the weekly-scores branch off `main`
(`791b131`), because the shared rule lands in the file that branch introduces.

This is the coordinator's `season-sim.js:153-154` question, and the answer is both halves of it:
the simulator does **not** want a per-week series, and its admission rule **did** differ from
`espnWeeklyRows`'s — by enough to fabricate five and a half wins per team.

## Does it want a per-week series? No.

`initialRecords` wants two running totals per team: a win count and points-for. It never looks at
a single week on its own. So it is not a consumer of `espnWeeklyRows`'s row shape, and rewriting
it to pair rows back up into matchups would add work to reach the same two numbers. The rows stay
where they are.

What it shares with the parser is not the shape, it is the **judgement**: which periods in a
stored ESPN schedule count as played. That is one quantity, and it had two definitions.

## What the difference did, measured

`fromWeek` is caller-supplied. `/simulate` takes `from_week` straight off the query string
(`routes/model.js:528`) and the trade engine passes `target.week` (`trade-engine.js:1318`).
Nothing bounds it to the weeks a league has actually played.

The old rule admitted any period before `fromWeek` whose two sides carried finite numbers. An
unplayed ESPN period comes back `totalPoints: 0` on both sides — two finite numbers — so it was a
tie, so half a win to each team.

Four-team fixture, two weeks played out of thirteen, window opened at week 14:

| | before | after |
|---|---|---|
| team 1 | **7.5 W**, 223 PF | 2 W, 223 PF |
| team 2 | **5.5 W**, 183 PF | 0 W, 183 PF |
| team 3 | **5.5 W**, 163 PF | 0 W, 163 PF |
| team 4 | **7.5 W**, 243 PF | 2 W, 243 PF |

Eleven unplayed periods, 5.5 invented wins each. **Points-for stayed honest**, because an
unplayed week adds zero — so the record and the points disagreed, a team with the fewest points in
the league carried 5.5 wins, and four teams read as a near four-way tie. The simulation then
reports `standings_carried_in: true`, which tells a reader these are the league's real standings.

Both are in the suite: the win totals, and the weaker but more diagnostic statement that a team
with more wins must also have more points.

**Sleeper had the same bug.** Its branch compared `Number(points) || 0` on both sides, and an
unplayed Sleeper week is two zeroes, so it was a tie as well.

## The fix, and where the rule now lives

`periodPlayed` in `espn-weekly-scores.js`: **decided AND both sides carry a number AND at least
one is above zero**. `espnWeeklyRows` and both branches of `initialRecords` call it. `winner` is
optional, so the same function serves Sleeper, which has no such field.

The three conditions are not redundant, and this fix is the second time that mattered:

- `decided` is the only one that catches a week **in progress**. A partial 58.4 is a plausible
  weekly score, and banking the win from it is a result the league does not have yet.
- `bothScored` is the only one that catches a side with **no total**, which the zero test reads as
  a zero.
- `anyPoints` catches a future 0-0 in a payload with no `winner` key, and it is `||` so that a
  real shutout stays a win.

A test asserts `season-sim.js` imports the rule and contains no copy of the `UNDECIDED` marker, so
the second definition cannot come back quietly.

## Mutations

Canonical shape: one row at a time from the same clean base, both files' SHA-256 (first 12
characters) recorded, run
`node --test --test-concurrency=1 test/season-sim-carried-records.test.js test/espn-weekly-scores.test.js`.

Base: `season-sim.js` `a7f0d17e0b8c`, `espn-weekly-scores.js` `d3a9b543bc04`. Both restored and
checked after the last row.

| # | file | mutation | state | sha256 before -> after | fail | a test that fails |
|---|---|---|---|---|---|---|
| R1 | season-sim | the ESPN branch back to its old rule (both sides finite) | APPLIED | `a7f0d17e0b8c` -> `ab676211a50d` | 4 | a window opened past the played weeks carries no wins from the weeks not played |
| R2 | season-sim | the Sleeper branch back to its old rule | APPLIED | `a7f0d17e0b8c` -> `48d5b3267200` | 1 | a Sleeper league gets the same rule, and it had the same bug |
| R3 | espn-weekly-scores | the decided check dropped from the shared rule | APPLIED | `d3a9b543bc04` -> `d5c038f26c46` | 2 | a week in progress is not a result, even with real points on the board |
| R4 | espn-weekly-scores | the zero check dropped from the shared rule | APPLIED | `d3a9b543bc04` -> `f43aa08507d0` | 2 | a Sleeper league gets the same rule, and it had the same bug |
| R5 | espn-weekly-scores | the zero check becomes `&&`, so a real shutout is dropped | APPLIED | `d3a9b543bc04` -> `c616a503fe62` | 2 | a real shutout is still a win, on both platforms |
| R6 | espn-weekly-scores | one missing side is read as a zero rather than refused | APPLIED | `d3a9b543bc04` -> `6f1694e2a095` | 1 | a side with no score at all takes its whole period with it |
| CONTROL | season-sim | a comment reworded, no code path touched | APPLIED | `a7f0d17e0b8c` -> `8ead7793b88f` | 0 | none, and none should |

Each of the four conditions in the rule has a row that deletes it and a test that fails, and the
two platform branches have one each. R1 failing four tests is the measurement above.

## RED

The RED is the probe in the table: the before column is the shipped behaviour, run on the tree
before the fix. Retroactive RED by mutation for the rest, which CLAUDE.md allows — R1 and R2
restore the shipped rules exactly.

## Numbers

Targeted: 20 tests, 20 passed, 0 failed across the two files (6 new, 14 existing).
Full local check `npm run check` on the tree whose parent is `6b77382`: exit 0 — 2,970 tests,
2,929 passed, 0 failed, 41 skipped; typecheck, lint and build clean; `start:smoke` passed on an
isolated database (32 teams).

## The five questions

**Is this well built?** One rule, one file, called from three places, with the reason each
condition exists written next to it and a mutation row per condition.

**Is this based on stats, or is it made up?** It is a fact about the stored payload, and the fix
is the removal of an invented number: 5.5 wins per team that no game produced. Nothing is
substituted in their place — a week that was not played contributes nothing, which is why
points-for was already right.

**How do we know?** The before column is a measurement on the shipped tree, not an argument. Six
mutations and an inert control, each with the file hash before and after.

**Should this data be pointed anywhere else on the platform?** The simulator's carried-in record
feeds playoff odds, and playoff odds feed the trade engine's horizon value at
`trade-engine.js:1317`, so a fabricated 5.5-win record was priced into trade advice. Also open:
whether any surface displays the carried-in record directly, and whether a caller should be
allowed to pass a `from_week` past the played weeks at all — a named refusal may be better than a
silently shorter carry-in. Routed, not decided here.

**How does it unify?** Two readers of one quantity had two rules, and the stricter one was right.
The rule now has one home, and a test asserts the second copy cannot come back.
