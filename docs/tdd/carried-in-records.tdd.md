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

## A second item on the same function: the reason beside the shared build

Feature audit's mutation on `tradeImpact` — rebuild the projection set between the two runs —
was **inert**, 0 tests failed. The comment beside that line said rebuilding "would introduce noise
that has nothing to do with the trade". An inert mutation on a line whose comment claims an effect
is a claim about the comment, so the question is whether `buildProjections` draws anything.

Model audit traced it one level and found no `random()` in `buildProjections` or its eleven direct
callees, with the single `random()` in `projections.js` sitting inside `sampleWeeks`, which this
path does not reach. They did not trace the transitive closure, so the check here is **empirical**,
which a helper added at any depth cannot slip past:

- **Two builds on identical arguments are byte-identical.** On the fixture below, and separately
  against the real local database: 1,139 players, 1,281,866 characters serialised, identical.
- **A build advances the shared generator by nothing.** Under the same seed, the three draws taken
  after a build are the three draws taken without one, to the digit.

So the noise claim is false, and the mutation was inert for exactly that reason. The comment now
gives the reasons that survive measurement: the build is the expensive part of the call and doing
it twice buys nothing, and sharing one object keeps the two runs paired even if a future change to
the projection path does introduce a draw. A test asserts the phrase "rebuilding would introduce
noise" is gone and that the replacement states what was measured — because the reason is what a
future reader decides by, and "would introduce noise" invites whoever measures no noise to
conclude the shared build is pointless.

**This landed one commit after the `:153-154` change rather than in it**, because that commit was
already pushed when the item arrived. Same branch, same evidence file.

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

Second sweep, for the determinism item. Base: `season-sim.js` `8ea412d83e54`, restored and
checked. Run: `test/projection-build-determinism.test.js test/season-sim-carried-records.test.js`.
Before/after text quoted by the runner rather than transcribed.

| # | mutation | before -> after | state | sha256 | fail | a test that fails |
|---|---|---|---|---|---|---|
| D1 | the noise claim restored as the stated reason | `// One projection build shared by both runs. The reason is NOT that rebuilding would introduce` -> `// One projection build shared by both runs - rebuilding would introduce noise. The reason is NOT that rebuilding would introduce` | APPLIED | `8ea412d83e54` -> `30bae7aa0ecc` | 1 | the comment beside the shared build gives a reason that is true |
| D2 | the word the corrected comment turns on is removed | ``buildProjections` is deterministic, measured rather than assumed in` -> ``buildProjections` is safe to share, measured rather than assumed in` | APPLIED | `8ea412d83e54` -> `2ace0d6a0867` | 1 | the comment beside the shared build gives a reason that is true |
| D3 | the two runs are handed separate builds after all | `projections }));` -> `projections: buildProjections({ through: SEASON - 1, scoring }) }));` | APPLIED | `8ea412d83e54` -> `af8189bbc105` | 0 | **none — equivalent, and that is the finding** |
| CONTROL | a comment reworded, no code path touched | `// The reasons that hold: the build is the expensive part` -> `// The reasons that do hold: the build is the expensive part` | APPLIED | `8ea412d83e54` -> `959d0a11f93c` | 0 | none, and none should |

**D3 is an equivalent mutation, and it is feature audit's inert injection reproduced.** A rebuild
returns a byte-identical object, so no behaviour can change and no test can fail — which is not a
gap in the suite but the measurement the item asked for. Unlike most equivalence claims this one
has its proof inside the suite rather than in prose: "two builds with identical arguments are
byte-identical" is the test that makes D3 equivalent, and if a future change introduced a draw,
that test would fail before anyone had to rediscover D3.

Every row in both sweeps is APPLIED with a moved hash. Nothing in this evidence file rests on a
pattern that matched nothing, or on a pattern that matched in more than one place — the runner
refuses to apply an ambiguous match and reports it NO-OP, because matching the wrong place is
worse than matching nothing: an unrelated test then fails and reads as a kill.

Each of the four conditions in the rule has a row that deletes it and a test that fails, and the
two platform branches have one each. R1 failing four tests is the measurement above.

## RED

The RED is the probe in the table: the before column is the shipped behaviour, run on the tree
before the fix. Retroactive RED by mutation for the rest, which CLAUDE.md allows — R1 and R2
restore the shipped rules exactly.

## Numbers

Targeted: 24 tests, 24 passed, 0 failed across
`test/season-sim-carried-records.test.js` (6), `test/espn-weekly-scores.test.js` (14) and
`test/projection-build-determinism.test.js` (4, new).

Full local check `npm run check`: the `:153-154` commit measured exit 0 — 2,970 tests, 2,929
passed, 0 failed, 41 skipped on the tree whose parent is `6b77382`. The determinism commit's
numbers are in its own commit message, measured on the tree whose parent is `7d77aca`. Typecheck,
lint and build clean; `start:smoke` passed on an isolated database (32 teams).

## The five questions

**Is this well built?** One rule, one file, called from three places, with the reason each
condition exists written next to it and a mutation row per condition.

**Is this based on stats, or is it made up?** It is a fact about the stored payload, and the fix
is the removal of an invented number: 5.5 wins per team that no game produced. Nothing is
substituted in their place — a week that was not played contributes nothing, which is why
points-for was already right.

**How do we know?** The before column is a measurement on the shipped tree, not an argument. Nine
mutations and two inert controls across two sweeps, each with the file hash before and after and
its exact text quoted by the runner. The one unkilled row is declared equivalent with its proof in
the suite rather than in prose.

**Should this data be pointed anywhere else on the platform?** The simulator's carried-in record
feeds playoff odds, and playoff odds feed the trade engine's horizon value at
`trade-engine.js:1317`, so a fabricated 5.5-win record was priced into trade advice. Also open:
whether any surface displays the carried-in record directly, and whether a caller should be
allowed to pass a `from_week` past the played weeks at all — a named refusal may be better than a
silently shorter carry-in. Routed, not decided here.

**How does it unify?** Two readers of one quantity had two rules, and the stricter one was right.
The rule now has one home, and a test asserts the second copy cannot come back.
