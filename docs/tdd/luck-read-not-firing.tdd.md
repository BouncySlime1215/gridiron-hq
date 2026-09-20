# A luck read that is not firing — TDD record

2026-09-20. Code: `server/services/counterparty-pricing.js`. Tests:
`test/valuation-map.test.js` (G9a–G9f). RED `7730804`, GREEN below.

Retroactive-RED form, as `docs/tdd/week2-numbers.tdd.md` established: the tests
were written first here, and every rule is additionally proved by a mutation
that makes it fail, because a test no mutation can fail proves nothing.

## What was claimed, and what was actually true

The model evidence audit reported: `counterparty-pricing.js:55-56` documents that
the luck term is inert at week 2, but the `if` at `:452` has no skip branch, so
the inertness lives in a comment and never reaches the served object.

**Half of that is wrong, and it matters which half.** The inertness does reach
the served object. `add` enforces `min_n` at `:383-386` and pushes
`{source, reason}` onto `inert`; `valuationMap` carries it to `sources_absent`
with the reason at `:750` and `:770-771`. There is already a test for it — G2b,
`test/valuation-map.test.js:422`, on a fixture manager whose luck rests on one
scored week — and `docs/tdd/valuation-map.tdd.md` §7 records exactly that state
for league 4: `luck_self_view` inert, 1 of 4 weeks.

**The conclusion holds anyway, for three states the report did not name.** Probed
against `playerValuation` directly before writing anything:

| profile | factor | inert entry |
|---|---|---|
| `luck: null` | none | **none** |
| `luck: {value: 0.3, n: 1}` | none | yes, with the reason |
| `luck: {value: 0, n: 1}` | none | **none** |
| `luck: {value: 0.01, n: 1}` | none | **none** |
| `luck: {value: 1.0, n: 4}` | yes | none |

Two separate causes. `add`'s first line returned on `Math.abs(effect) < 0.001`
**before** it checked `min_n`, so smallness won over provenance: 0.05 × (0.01 / 2)
is 0.00025, and a real reading on one week vanished along with the reason it was
not firing. And the branch at `:452` guarded on `managerProfile?.luck`, so a
manager with no archetype row at all never reached `add`.

## The part that is worse than "the page cannot say why"

`valuationMap`'s absent-reason chain ends in an `else` at `:775`. A source that is
neither used, nor chat-blocked, nor inert, nor `positional_need` is served:

> "the data exists but no player in this league matched it"

For luck in a league whose archetype build produced no luck row, that sentence is
**false in both halves** — the data does not exist, and no player was ever
compared against it. G9d asserts the exact string the pre-fix code returns, so
this is pinned rather than argued. Per `docs/tdd/valuation-map.tdd.md` §8 that is
the live shape of four of the five leagues. The surface was not silent; it was
confidently wrong, which is the failure class `CLAUDE.md` names.

## The six rules, and the mutation that kills each

| test | rule |
|---|---|
| G9a | a manager with no luck reading is reported, not passed over |
| G9b | a reading below its sample is reported whatever its effect size |
| G9c | a manager exactly at expectation is a reading, not a missing one |
| G9d | a league with no archetype rows is not told the data exists |
| G9e | a zeroed source leaves no trace at all — no factor, no inert entry |
| G9f | a reading with enough sample still prices, at the same number |

RED, run against `791b131`'s `counterparty-pricing.js` with the final test file:
**G9a, G9b, G9c, G9d fail; G9e and G9f pass.** 29 of 33 in the file. G9e and G9f
are regression pins and are supposed to pass on both sides.

GREEN: **33 of 33** in the file. Whole suite: **2,966 tests, 2,925 passed, 0
failed, 41 skipped**, up 6 tests and 6 passes from 2,960/2,919, so the `add`
reorder broke nothing elsewhere despite touching all eight sources.

Mutations, each applied to the GREEN code and run:

| mutation | fails |
|---|---|
| M1 — smallness return put back ahead of `min_n` | G9a, G9b, G9c, G9d |
| M2 — luck branch guards on `managerProfile?.luck` again | G9a, G9d |
| M3 — ablation guard moved after the `min_n` branch | G9e, and nothing else |
| M4 — a missing reading passes `n = 4` instead of `n = 0` | G9a, G9d |

**M3 killed nothing on the first attempt, and that is the useful entry in this
table.** G9e originally used a profile with `luck: {value: 1.6, n: 4}`. `min_n` is
4, so `4 < 4` is false and that profile never reaches the inert branch at all —
it passes however the two checks are ordered. The pin was asserting a property it
could not see. G9e now also runs the zeroed case at `n = 1` and at `luck: null`,
which is the only state where suppression and inertness compete, and M3 fails it.
Worth stating plainly: the first version of this file would have claimed a
regression pin that pinned nothing.

## The fix

1. `add` checks in the order: ablation, finiteness, **`min_n`**, smallness. Only
   the third and fourth moved relative to each other. The ablation guard stays
   first, because `docs/tdd/valuation-map.tdd.md` §7's every count depends on a
   zeroed source leaving no trace, and an inert entry is a trace.
2. The luck branch guards on `owns` alone and passes `n = 0` when there is no
   reading, so a missing measurement routes through the `min_n` branch and gets a
   true reason instead of falling through to the `else`.

No number moves. Nothing that priced before prices differently: G9f pins the
firing case at 0.8 of its cap for 1.6 wins against `LUCK_FULL_WINS` of 2.

## What is deliberately not covered

A reading **above** its sample whose effect is still under 0.001 — a manager with
four scored weeks and luck of exactly 0 — is still dropped silently. Filing a
confident zero under `inert` would make that word mean both "not enough evidence"
and "evidence, saying nothing", which is how this class of defect starts. It
needs a third bucket and a change to the served contract, so it is named here
rather than smuggled into this fix. The same applies to the other seven sources'
outer guards: only luck's was changed, and the rest can still short-circuit
before `add`.

## Is this well built? (the five questions)

**Based on statistics, or made up?** Neither, and the distinction is the point:
this change adds no number. It moves two existing guards past each other and
passes a 0 where a branch used to return early. The only constants involved,
`min_n` 4 and the 0.001 floor, are unchanged, and `min_n` 4 rests on a stated
argument — one scored week of luck is noise — not on a fit.

**How do we know?** Four mutations, three of which kill named tests, and one of
which killed nothing until the test it was aimed at was rewritten. Plus a direct
probe of five profile states before any code was written, pasted above.

**Structure.** The generalisable half is one reordering inside `add`, which fixes
the smallness-over-provenance hole for all eight sources at once. The luck-
specific half is at the one call site. The remaining seven outer guards are named
above rather than changed, because each needs its own "what does no reading mean
here" answer and a blanket `n = 0` would invent one.

**Should this point anywhere else?** Yes. `sources_absent` is the only place on
the platform that says why a signal is not firing, and its last branch is a
guess. The durable fix is to make that `else` unreachable — every source
reporting its own reason — rather than to keep correcting the guess one source at
a time. Until then, the `else` string should say it is a guess.

**What would unify it?** This is the same shape as the `priceable` finding in
`docs/evidence/2026-09-20/trade-brain-signal-provenance.md`: a fact known in one
layer and not carried to the next, where the next layer then invents a plausible
substitute. Both are cases of a serving layer being allowed to guess. One
accessor that carries provenance with the value, and no default that reads like
a measurement, covers both.
