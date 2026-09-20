# TDD evidence: a hand-set waiver number published as a fitted confidence

**Change.** `claude/project-thread-5f9c3y-waiver-kdef`, PR #62, commit `30a16f8`
on top of that PR's own pair. Edits `server/services/waiver-brain.js` only, which
is this thread's file under the one-editor-per-server-file rule. Nothing in
`server/routes/decision-inbox.js` changes; it appears below only as the target of
one control injection.

RED here is retroactive, by mutation. The tests are new, so the proof that they
bite is that each fails under a defect deliberately put back. **Eight injections
were run; all eight failed the intended test** — one of them only after being
re-aimed, which is the honest part of this file (see f4e).

## The defect

`waiverUpgrades` gave every upgrade `accept_probability: 0.9` — a literal, with a
comment calling acceptance "~1 because nobody has to agree to a waiver claim" —
and passed it to the Decision Inbox as that item's `confidence`.

The trade publisher writes `headline.p_right` into that same column
(`trade-engine.js:2874`, built at `:2833`): a fitted estimate of how often that
model is right, scored against outcomes.

**They are not the same kind of number.** `p_right` answers "is this
recommendation correct". `0.9` answers "will somebody else claim him first". A
reader ranking an inbox on that column is comparing a model's track record with a
guess about other managers, and nothing on the record distinguishes them.

The literal appeared **twice** — once as `accept_probability`, once inside
`expected_value: r2(gain * 0.9)`. Two literals for one concept is how they drift.

## The fix

1. The constant is named `CLAIM_FRICTION`, and both served numbers read it.
2. The basis travels on the wire **in two shapes**, which is the part worth
   arguing about and is settled by this file's own rule. At the `vegas` field the
   file already says: *"A 'no adjustment' note on every row is noise that trains
   you to stop reading them."* A 400-character sentence repeated on every upgrade
   would be exactly that. So the row carries a one-token
   `accept_probability_basis` (`'hand-set'`) for a surface to branch on, and the
   sentence is stated **once** on the payload as
   `acceptance: { basis, value, why }` — beside `not_modelled` and `scored_on`,
   which are the other two places this payload explains itself. It is named for
   the thing rather than for the row's field on purpose: one name carrying two
   shapes in one response is how a consumer ends up reading `.why` off a string.
   The first draft of this change put the whole sentence on every row, and the
   second gave both shapes the same name; injections f4f and f4g exist so a later
   edit cannot quietly undo either.
3. The inbox item publishes `confidence: null` rather than borrowing one.

## What it deliberately does not do

It does **not** remove the friction factor, which still applies to
`expected_value`. The factor is a flat multiplier on every row and therefore
reorders nothing within the list — which is precisely why it survived
unexamined, and is also why removing it would be a behaviour change dressed as an
honesty fix.

It does **not** drop the `confidence` field from the inbox. That was the other
option on the table, and it is wrong: the trade publisher's use of the column is
legitimate and fitted. Test 7 exists to hold that line.

**Verified before changing it, rather than assumed.** `/api/decision-inbox` is
mounted (`server/index.js:129`), but **no client page fetches it** — no reference
to the route or to an inbox item's fields exists anywhere in `client/src` — and
no test asserts on the column. So nothing regresses by the absence. That absence
is itself a wiring finding, and it is routed to the wiring map thread rather than
taken here.

## Injections (`test/waiver-confidence-is-hand-set.test.js`, 7 tests)

```
### f4a  the defect restored: confidence: top.accept_probability
# tests 7   # pass 6   # fail 1
not ok 6 - the inbox item carries no confidence, rather than borrowing the friction factor

### f4b  the per-row basis token deleted, the number left in place
# tests 7   # pass 4   # fail 3
not ok 2 - the acceptance number says on the wire that it is hand-set
not ok 3 - the basis is on every row, not just the one that happened to be first
not ok 4 - the sentence that explains it is on the payload, not repeated per row

### f4c  expected_value given its own literal again (0.85), so the two can drift
# tests 7   # pass 6   # fail 1
not ok 5 - expected_value is the gain times that same constant, not a second copy of it

### f4d  a token is emitted, but one that never says it is unfitted ('standard')
# tests 7   # pass 4   # fail 3
not ok 2, 3, 4

### f4e  decision-inbox.js coerces a null confidence to 0.9 on INSERT
# tests 7   # pass 6   # fail 1
not ok 6 - the inbox item carries no confidence, rather than borrowing the friction factor

### f4f  the payload-level `acceptance` removed, leaving only the bare token
# tests 7   # pass 6   # fail 1
not ok 4 - the sentence that explains it is on the payload, not repeated per row

### f4g  the two-shape split collapsed the wrong way: the whole sentence on every row
# tests 7   # pass 4   # fail 3
not ok 2, 3, 4

### f4h  the payload object given the SAME name as the row's field
# tests 7   # pass 6   # fail 1
not ok 4 - the sentence that explains it is on the payload, not repeated per row
```

**f4e was wrong the first time, and the record should say so.** Aimed at the
first textual match of the parameter list, it landed in `publishRecommendation`'s
**UPDATE** branch. This test publishes a new record, so the UPDATE branch never
runs and the suite stayed green. Under the standing rule that would mean the test
is wrong — here it meant the injection was, and the two are distinguishable only
by reading which branch executes. Re-aimed at the INSERT path, it bit. **A green
suite under an injection is a question, not a verdict.** A function with an
upsert shape has two copies of every argument list, and a first-match replacement
always takes the wrong one.

f4e is a storage-layer control rather than a producer mutation, and it is there
because the fix would be cosmetic if the column silently supplied a default:
`confidence: null` is only honest if a null actually stores.

f4f, f4g and f4h pin the shape from three sides, and each of them is a draft of
this change that was written and thrown away. f4f removes the explanation
entirely. f4g puts the whole sentence back on every row, which is the first
draft and the thing this file's `vegas` comment warns against. f4h gives the
payload object the row's field name, which is the second draft: one name, two
shapes, one response — the arrangement where a consumer reads `.why` off a
string and gets `undefined`. Any one of the three alone would leave the other
two unguarded, which is the argument for writing all three rather than stopping
at the first that goes red.

Test 1 pins that the fixture produced a live upgrade clearing the publish
threshold (`expected_value >= 0.75`). Without it the rest of the file asserts over
`undefined` and passes having checked nothing. Test 6 reads the **stored column**
rather than the call's return, because the column is what a reader eventually
sees. Test 7 publishes a trade-shaped record with a fitted `0.63` and holds that
it stores unchanged.

## Is this well built

- **Well built:** yes. It names one constant, emits its basis in the shape this
  file already uses for the same job, and stops writing it into a column that
  means something else. No number moves. Two drafts were thrown away getting the
  shape right — the sentence on every row, then two shapes under one name — and
  both are pinned by injections rather than only described here.
- **Stats, or made up.** **Made up, and now labelled as such.** `0.9` is
  hand-set; no waiver recommendation in this project has ever been scored against
  an outcome. The change adds no fitted number and does not claim one. Also
  hand-set and untouched here, named so nobody reads this file as a clean bill:
  the `0.75` publish threshold, the `2` / `1.2` urgency cuts, the 72-hour expiry
  (already flagged in its own comment), and the `gain <= 0.05` cutoff.
- **How we know.** Direct reads, not inference: the two writers of the shared
  column are `waiver-brain.js` and `trade-engine.js:2874`, and `p_right` is built
  at `:2833`. The claim that dropping the value regresses nothing was checked
  against `client/src` and `test/` rather than assumed. **What is still
  untested:** whether a waiver recommendation is any good. That is answerable — a
  walk-forward over past claims, scoring the recommended add against what the
  bench actually produced — and the `null` says the question is open instead of
  implying it was answered.
- **Pointed anywhere else.** `accept_probability` is rendered nowhere in the
  client today; `expected_value` is the field that ranks the board. The inbox
  column is shared with the trade publisher, which is the whole reason this
  mattered, and has no reader at all — routed to the wiring map thread. Where
  this **should** point: the same basis-beside-the-number shape is already on
  `availability_source` (#57) and `window.basis` (#74). Three surfaces now carry
  it; a fourth that does not is the next thing worth finding.
- **How it unifies.** One constant behind both numbers in the payload, one shape
  for explaining an unfitted number (token on the row, sentence on the payload,
  one name per shape), and one rule for the shared column: a fitted number or
  nothing.
