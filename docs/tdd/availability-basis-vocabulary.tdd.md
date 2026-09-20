# One vocabulary for what priced a chance to play

`server/services/availability-basis.js` (new) · `server/services/contingency.js`
· `test/availability-basis-vocabulary.test.js`

## The five questions

**Is this well built?** It replaces three classifiers with one field read from a
list defined once. The list is a frozen array in a file of its own, so no
consumer can define its own copy without that being obvious.

**Is this based on stats, or made up?** Neither. It is a contract: it reports
which of four already-existing code paths priced a row. It computes no new
number and changes no existing one.

**How do we know?** A RED commit, a GREEN commit, six passing tests, and a
mutation table where each mutation is shown applied by hash. The load-bearing
entry is the NO-OP control: rewording the display sentence leaves all six
passing, which is the precise thing that was broken before.

**Should this data be pointed anywhere else?** It already is: the fantasy
plan's accessor and the UI's `playerAvailabilityBasis` both want it and both
were guessing. Neither should keep guessing once this lands.

**How does it unify?** Nick's rule is one normalised name per stat everywhere.
This is that rule applied to the availability basis — with the correction that
there were two stats wearing one name, not one.

## The fault

Nothing on a chance-to-play row said what priced it, so three places worked it
out for themselves, two of them by reading display prose:

1. `lineup-brain.js#playerAvailabilityBasis` (UI's adopt-chip branch) matches
   prefixes of the `source` sentence: `'fitted availability by role'` → role,
   `'fitted availability ('` → pooled, anything else → constants.
2. The fantasy plan's accessor matches the same sentence into a different set of
   words: fitted / durability_prior / default_durability.
3. `availabilityBasis()` reports a third thing under the same name — which fit
   tables this process loaded.

Two consequences.

**Rewording is a silent reclassification.** `source` is display text. Changing
"fitted availability (league…)" to anything else moves every fitted number into
the prior bucket in two consumers, and no test anywhere fails.

**The row-level value on main is not row-level at all.**
`lineup-brain.js:640` stamps the *process* basis onto every row, so a row reads
`role` whenever the fit tables are loaded, whoever the player is — including a
player the role fit has no cell for.

## Two quantities, one name

This is the part worth getting right, because collapsing them is what created
the problem:

| | what it describes | shape | values |
|---|---|---|---|
| `availability_basis` on a row | what priced **that player** in **that week** | string | `AVAILABILITY_BASIS` |
| `availabilityBasis()` | which fit tables **this process** loaded | `{ basis, missing, stamp }` | `AVAILABILITY_FIT_BASIS` |

The process one cannot use the row vocabulary: its `constants` means "no fit on
file", and at that point there is no player and no prior, so it cannot split
into `durability_prior` / `default_durability`. Six client surfaces read the
process one as an object and the row one as a string, which is what keeps them
apart at a call site.

## The vocabulary

Four values `weeklyAvailability` can serve:

| path in `playerActiveProbability` | value |
|---|---|
| the role cell answered | `role` |
| no role cell, the pooled/team lookup answered | `pooled` |
| neither fit; the player has games on file | `durability_prior` |
| neither fit; he has none, so the prior is the constant | `default_durability` |

Two consumer arms it never serves, for two different kinds of missing:

- `unfitted_position` — there is no row for this player at all.
  `weeklyAvailability` selects QB, RB, WR and TE, so a kicker is outside the fit
  entirely.
- `unrecognised` — a row arrived without the field, reachable only from a
  payload built before it existed.

**`unfitted_position` is not `default_durability`,** and folding the two was
declined deliberately. `default_durability` is a row that exists carrying a
substituted prior; `unfitted_position` is no row at all. Folding them would
report a kicker as having a durability prior that nothing ever computed, and
would orphan a live UI arm (`BasisChip.tsx:53`, `Lineup.tsx:382`,
`News.tsx:177`).

## RED

Five tests. Two pass (the list's shape; servable versus arm). Three fail:

```
# tests 5
# pass 2
# fail 3
```

## GREEN

`playerActiveProbability` takes `priorMeasured` and returns `basis` beside
`active` and `source`, set at every branch that sets `source`.
`weeklyAvailability` puts it on the row. `fittedAvailability` emits the process
basis by destructuring `AVAILABILITY_FIT_BASIS` instead of writing the three
strings out again. Six tests pass.

## Mutation evidence, applied

Each mutation was written to `server/services/contingency.js` and the file's
SHA-256 checked before and after, so "applied" is shown and not asserted. The
file was restored to its exact pre-mutation hash `4270ccd8` afterwards.

| mutation | hash before → after | applied | result |
|---|---|---|---|
| collapse the measured/substituted split to always `durability_prior` | `4270ccd8` → `01f1708c` | yes | 2 of 6 fail |
| remove `availability_basis` from the served row | `4270ccd8` → `ae24637c` | yes | 4 of 6 fail |
| stop setting the pooled arm | `4270ccd8` → `084f3832` | yes | 1 of 6 fails |
| **NO-OP control: reword the `source` sentence** | `4270ccd8` → `e61f71a6` | yes | **6 of 6 pass** |

The control is the claim: the tests pin the contract and are indifferent to the
prose, which is exactly the property the old classifiers lacked.

## Not covered

The `role` arm. It needs fitted role rates plus snap rows for `roleStates` to
produce a usable cell, which is `availability-role.test.js`'s fixture — that
file pins the role path's numbers, this one pins the basis string on the three
arms a plain fixture reaches. Stated rather than implied.
