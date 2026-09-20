# One availability field, so five call sites stop guessing

2026-09-20. `server/services/player-week-engine.js`, `test/availability-basis.test.js`.
Branched off Opportunity's `claude/project-thread-w45mur-wiring-names-hold` (a6d00bb), not
`main` — see "Why not off main".

## The defect

Five call sites independently wrote `?? 0.92`: `role-scenario-engine.js:124`,
`season-sim.js:226`, `news-fantasy-impact.js:87`, `roster-risk.js:257` and
`trade-engine.js:346`. Not one of them could tell a fitted availability rate from the
blanket constant, and neither could anything downstream, because both arrived as a bare
number. Every surface printed them identically.

The defect was never the constant's value. It was that the constant was invisible — the same
shape as a layer going inert while the page keeps printing numbers, which this project has
shipped twice.

## Why not off main

`weeklyAvailability` serves `durability_prior_measured` and names its constant
`DEFAULT_DURABILITY_PRIOR`, and both exist only on Opportunity's hold branch, not on `main`.
The accessor's whole correctness rests on that flag, so it is branched there. It carries
their four-file change with it (14 lines in `contingency.js`, plus their tests).

## The mapping reads the flag, never the number

`durability_prior_measured` is the only safe discriminator. A veteran whose measured
durability prior really is 0.920 is indistinguishable from the default if you compare
values, and `durability_prior` is served through `toFixed(3)`, so that collision is **exact
rather than unlikely**. A value comparison would label a real career measurement as a
fallback, on precisely the players whose durability is unremarkable — an error correlated
with the population rather than spread as noise. The collision is the fixture the main test
is built on, because the value-comparing version of this function passes every other test.
(Credit to Opportunity for spotting the float-compare trap before it was written.)

## A correction to the field contract, and why there are four values

I published three values. There are **four**. `fitted` has to be derived from the producer's
`source`, which is a human sentence — `fitted availability by role (noreport/starter/full,
n=8657) x KC` — because no machine-readable field says it yet. A prose change upstream would
silently reclassify every fitted number as a prior, which is the exact failure this field
exists to end. So an unmatched source returns `unrecognised` and carries the raw sentence,
rather than being guessed at.

- `fitted` — a fitted availability rate produced the number.
- `durability_prior` — the player's own measured durability prior.
- `default_durability` — no measured prior, or no row for this player at all.
- `unrecognised` — the producer's source did not match any known shape. Loud on purpose.

`unrecognised` is scaffolding with a removal condition: when `contingency.js` grows a
machine-readable basis field, the prose match and this value both go. That is a one-line ask
of Opportunity and is not blocking.

## The constant

`DEFAULT_ACTIVE_PROBABILITY` is in `player-week-engine.js` because `contingency.js` does not
export its own. Two 0.92s in the codebase is the thing to avoid, so a test **reads what the
producer actually serves** for a player it has no availability rows for — a real database, a
real `weeklyAvailability` call — and asserts the two agree. If either number moves, that test
fails instead of the app quietly carrying two different "we know nothing" values.

## A test that could not fail

The first version of that test passed our own constant in as `prior` and asserted it came
back. That path returns the prior it was handed, so it always passes; it survived the
mutation that changed our constant to 0.85. Replaced with the real-database read above. This
is the third time in this session's work that a mutation has found a test asserting its own
input — worth naming as a pattern rather than a one-off.

## Mutations

| # | mutation | result |
|---|---|---|
| A1 | map by comparing the number to the constant | 3 fail |
| A2 | an unrecognised source falls through to `durability_prior` | 2 fail |
| A3 | a missing player throws instead of answering | 1 fail |
| A4 | the fitted match becomes a loose substring | 3 fail |
| A5 | the constant drifts from the producer's | 1 fail (after the test was fixed) |
| A6 | a present row ignores the producer's own probability | 1 fail |

All applied and confirmed changed before running.

## The two call sites in my own files

`role-scenario-engine.js` and `season-sim.js` now call the accessor and **serve**
`availability_basis` on their own payloads — `buildPlayerScenarios` carries
`availability_basis` and `availability_source`, and the simulator's per-player `meta` carries
`availability_basis` beside `active_probability`. Reading the basis and not serving it would
have left the defect exactly where it was. UI owns `news-fantasy-impact.js`; feature audit
owns `roster-risk.js` and `trade-engine.js`, and imports these exports rather than keeping a
local copy of the constant.

## Numbers

7 tests, 7 passed, 0 failed.
Full local check `npm run check`: exit 0 — 2,960 tests, 2,919 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## The five questions

**Is this well built?** One accessor, one constant, one field name, four declared values and
a test asserting nothing outside that list is reachable. It answers rather than throws on
every degenerate input, because it is called from the odds path.

**Is this based on stats, or is it made up?** It invents no number. It labels which measured
thing produced one, and where nothing measured did, it says so. `0.92` is not defended here
as a good number — it is named so that a surface can stop presenting it as a measurement.

**How do we know?** Six mutations, all failing, including one that reproduces the exact
0.920 value collision.

**Should this data be pointed anywhere else on the platform?** Yes — all five call sites,
three of which belong to other threads and now import these exports. `weeklyAvailability`
covers QB, RB, WR and TE only, so **every other position resolves to `default_durability` by
construction**: any surface showing availability for a K or a DST is showing the constant,
and now says so.

**How does it unify?** It replaces five independent literals with one import, before a sixth
was written. The naming follows the same rule as the projection and outlook basis fields: the
number and the statement of what produced it travel together.
