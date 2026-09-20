# What priced this manager — TDD record

2026-09-20. Code: `server/services/counterparty-pricing.js`,
`server/routes/trades.js`. Test: `test/manager-signals-api.test.js`, "read: the
acceptance read says which source priced the manager, and its sample".
RED `6ab561a`, GREEN below.

## The question this answers

Nick, 2026-09-20 01:21Z: "You need to seriously consider ok is this well built:
is this based on stats, is this just made up. How do we know this."

For the acceptance read the layer already knew the answer for every manager and
threw it away.

## What was wrong

Two facts were computed and discarded, both on the path that decides how
receptive a manager is:

1. **Whether anyone ever stated his tier.** `counterparty-pricing.js` did
   `const tier = tiers.get(id) ?? 'fair'`, so an elicited "fair" and an assumed
   one arrive as the same string. Live `manager_profiles` has **0 rows**, so
   every one of the five leagues is the assumed case while reading exactly like
   the stated one. A default that reads like a measurement is the failure
   `CLAUDE.md` names.
2. **How much of the price his observed rate actually paid for.** The blend
   weight `Math.min(1, accept_rate_n / 15)` was computed, used, and dropped. A
   consumer could not tell a manager priced almost entirely on his own record
   from one priced 7% on it — the number was already there, one line above.

`tradeability_set` on the manager object was already honest (null when unset,
with a comment saying why), so this is not a missing idea in the codebase. It is
the same idea not carried one layer further.

## The contract added

Four fields, on each entry of `counterpartyLayer`'s profile and carried into the
`receptiveness` object that `GET /api/trades/:leagueId/managers/signals` serves,
beside the existing `accept_rate` and `accept_rate_n`:

| field | meaning |
|---|---|
| `tier_source` | `"elicited"` if a `manager_profiles` row exists, else `"default"` |
| `tier_is_assumption` | `true` exactly when `tier_source` is `"default"` |
| `accept_rate_weight` | `min(1, accept_rate_n / 15)`, to 2 places |
| `priced_by` | `"observed"` \| `"blended"` \| `"elicited"` \| `"default"` |

`tier_is_assumption` is deliberately redundant with `tier_source`: a boolean is
what a badge binds to, a string is what a tooltip prints, and a consumer forced
to derive one from the other is one that eventually derives it wrong.

No number moves and no model is added. Every value was already computed inside
the layer.

## RED, GREEN, and the five mutations

The existing fixture already had both states, so no fixture was added: roster 2
has no tier and six decided offers, roster 4 has a hand-set `hard` and two.

RED: 1 failing of 15 in the file. GREEN: **15 of 15**. Whole suite below.

Each mutation was applied to the GREEN code and run, and each trips a **different
assertion**, which is what makes the test one test rather than one assertion
repeated:

All five were re-run 2026-09-20 through a harness that **asserts the
substitution changed the file** before running anything, and each printed
`APPLIED` — the scheduler thread's rule, after their own pattern silently failed
to match and the baseline was read as a mutation result.

| mutation | applied? | the assertion that fails |
|---|---|---|
| N1 — `tier_source` always `"elicited"` | APPLIED | "nobody has judged him, and the payload must say so" |
| N2 — the blend weight is never recorded | APPLIED | `accept_rate_weight` 0 !== 0.4 |
| N3 — `tier_is_assumption` hardcoded `false` | APPLIED | the boolean and the string disagree, false !== true |
| N4 — blend denominator 15 → 10 | APPLIED | `accept_rate_weight` 0.6 !== 0.4 |
| N5 — `priced_by` collapses `elicited` into `default` | APPLIED | "his tier is the only thing that priced him" |

N4 is the reason the test asserts `0.4` rather than "some weight": 6/15 pins the
**denominator**, which is the number that would drift silently if anyone retuned
the blend.

## What is deliberately not covered

`priced_by: "observed"` requires fifteen decided offers. No fixture reaches it,
and neither does any of Nick's five leagues — the live population is 30 decided
proposals across all of them. Rather than fake a fixture into that state, the
three reachable values are pinned and the threshold is pinned through N4. The
test says so in place, so nobody later reads the gap as an oversight.

Also unchanged: `accept_rate` is `null` below five decided offers, because
`manager-signals.js:208` withholds `tx_accept_rate` under `decided >= 5` — "an
acceptance rate from fewer than five decisions is noise dressed as a number". So
`accept_rate: null` with `priced_by: "default"` is the correct live state for
every league today, and a page must render it rather than treat it as a load
failure.

## Is this well built? (the five questions)

**Based on statistics, or made up?** The fields are provenance, not estimates —
they report which of two existing inputs was used and on what sample. The one
constant on the path, the 15-decision blend denominator, is **hand-set and
unfitted**, and this change makes that visible for the first time instead of
changing it. `docs/NUMBER-PROVENANCE.md` classes the whole counterparty family H.

**How do we know?** Five mutations, five distinct failing assertions, listed
above with the message each produced.

**Structure.** The computation stays where it was; only two derived strings and
two numbers are added to an object that already carried seven fields of the same
kind. The route change is a pass-through, so there is one place that decides what
"priced by" means.

**Should this point anywhere else?** Yes, and it is the reason to do it now
rather than after the UI redesign. `trade-engine.js:2158` and `:2336` read
`tradeability` straight out of `manager_profiles` with their own defaults, so the
trade card can still present an assumed tier as a stated one. Those are on the
trade path and were not touched here; they are named rather than silently left.

**What would unify it?** This is the third instance tonight of one shape: a fact
known in one layer and dropped on the way to the next, where the next layer
substitutes something plausible. The others are `priceable`
(`docs/evidence/2026-09-20/trade-brain-signal-provenance.md`) and the luck read
(`docs/tdd/luck-read-not-firing.tdd.md`). The unification is a rule rather than a
patch: **no served value may carry a default that is indistinguishable from a
measurement.** All three would have been caught by it.
