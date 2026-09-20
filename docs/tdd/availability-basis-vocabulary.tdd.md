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

**How do we know?** A RED commit, a GREEN commit, nine passing tests, and a
mutation table where each mutation is shown applied by hash and named by the
tests it turns red. Six of six kills land on the test that names them, with no
survivors --- the one survivor an earlier run reported is closed, and how is
recorded rather than dropped. The load-bearing row is control A: rewording the display sentence
leaves every test passing, which is the precise thing that was broken before.

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
strings out again. `DEFAULT_DURABILITY_PRIOR` and `DEFAULT_ACTIVE_PROBABILITY`
are exported from the same file, as two independent literals with two
docstrings — one is the input to the report-status curve, the other replaces
its output for a player the curve never ran on, and the matching digits are
coincidence. Nine tests pass.

## Mutation evidence, applied

Each mutation was written to the file named and its SHA-256 checked before and
after, so "applied" is shown and not asserted: a pattern that does not match
leaves the file unchanged and the run is the baseline wearing a mutation's
name. Each row also names the tests it turned red, because a mutation that
lands and kills a different test is unfinished, not a result. Both files were
restored and their hashes re-verified afterwards (`contingency.js`
`28bffcd49d70`, `availability-basis.js` `6de130fcae48`).

| Mutation | Verification | Result | Fails | Named tests red |
|---|---|---|---|---|
| collapse the measured/substituted split | APPLIED `28bffcd49d70` → `2696e9fcaa93` | RED | 3 | with no fit on file the basis is the prior, and it says which prior · the default prior behind a default_durability row is the shared constant · the basis does not depend on the wording of the source sentence |
| remove `availability_basis` from the served row | APPLIED `28bffcd49d70` → `358de206bf53` | RED | 6 | every served row carries a basis from the list · with no fit on file the basis is the prior, and it says which prior · the default prior behind a default_durability row is the shared constant · a fitted pooled rate moves the basis off the prior, for both players · a fitted role cell takes precedence, and the basis says role · the basis does not depend on the wording of the source sentence |
| stop setting the pooled arm | APPLIED `28bffcd49d70` → `fbb6d1f6fa2f` | RED | 1 | a fitted pooled rate moves the basis off the prior, for both players |
| mislabel the role arm as `pooled` | APPLIED `28bffcd49d70` → `3d5a1175964a` | RED | 1 | a fitted role cell takes precedence, and the basis says role |
| serve the default prior as measured | APPLIED `28bffcd49d70` → `dc9e238bf317` | RED | 3 | a fitted pooled rate moves the basis off the prior, for both players · a fitted role cell takes precedence, and the basis says role · a served durability prior says whether it was measured or substituted |
| derive the fallback probability from the prior | APPLIED `6de130fcae48` → `b17de74027ed` | RED | 1 | the prior and the fallback active probability are independent literals |
| **CONTROL A** — reword the `source` sentence | APPLIED `28bffcd49d70` → `460bb8d2485d` | GREEN | 0 | none, and that is the claim |
| **CONTROL B** — a pattern that is not in the file | **NO-OP — pattern not found** | — | — | — |

**6 of 6 caught, each by the test that names it. No survivors.**

Two controls, doing two different jobs. A is a real edit that must NOT break
anything, and is the whole point of the change: the tests pin the contract and
ignore the prose. B shows the harness can report a miss, so an APPLIED row
above means something.

### The survivor that was closed

An earlier run of this table reported one surviving mutation: mislabelling the
role arm as `pooled` went undetected, because the fixture wrote no role rates
and the branch never executed. It is recorded here rather than quietly dropped,
since the fix is the interesting part.

Closing it took the three things that arm needs and the others do not: rows in
`nfl_availability_role_rates`, a 2026 week-1 appearance with snaps so
`roleStates` can compute a tier and a games gap, and `useRole: true`. The test
"a fitted role cell takes precedence, and the basis says role" now asserts the
role cell wins over the pooled rate written by the test before it, which is the
precedence the arm exists to express. The same mutation is red in the table
above.

## Not covered

All four servable arms are now exercised and every mutation of them is caught,
so the honest gap is elsewhere. Two things this file does not pin:

- **The two consumer arms**, `unfitted_position` and `unrecognised`. Neither is
  servable by construction, so there is nothing here to assert; the tests pin
  only that they are in the list and out of the servable set. Whoever emits
  them owns testing them.
- **The numbers**, which are `availability-role.test.js`'s job. This file pins
  which path priced a row, never what it priced it at. A mutation that changed
  a role cell's probability without changing which arm answered would pass
  here, correctly, and fail there.

## Checks on this commit's own tree

Measured at this commit, not inherited from an earlier one:

```
npm run check    exit 0
  lint           clean
  typecheck      clean
  client build   ok
  start:smoke    passed on an isolated database (32 teams)
  full suite     2,962 tests · 2,921 pass · 0 fail · 41 skipped
```

GitHub Actions is out of minutes until 2026-10-01 and the CI workflow is
disabled deliberately, so this is the only run there is. It was executed on the
tree as committed, after the mutation harness restored both source files and
their hashes were re-verified.
