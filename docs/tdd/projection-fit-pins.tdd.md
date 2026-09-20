# The projection basis fields, pinned against deletion

2026-09-20. `test/projection-fit-meta-pins.test.js`, on top of PR #58.

## Why a second test file

`test/projection-fit-meta.test.js` runs with **no active fit**, which is the live state —
`shrinkage_fits` holds zero rows — and is the case it was written for. But
`projectionFitMeta` returns `null` in that state, so its fields are never evaluated by any
test. Each of `fit_id`, `recency` and `volume_k` could be deleted from the returned object
with the whole suite staying green. A field a consumer renders and nothing asserts is a
field that silently stops arriving.

This file does the opposite: it stores a real fit, activates it, and reads the object a
caller with a live fit actually receives. The fixture deliberately contains **both** an
efficiency metric and volume metrics, because that is what makes `volume_k` answerable.

## What `volume_k` is for

`activeKVectorFor` withholds the volume entries of the fitted vector from every caller not
on weekly-role recency; its own header says those callers "keep the hand-picked constants
they were validated with. They are not claimed to be right, only untested with the fitted
k." The season simulator is one of them. So with an active fit the odds run on fitted
efficiency constants and unvouched-for volume constants at the same time, and a payload
carrying only `fit_id` states the opposite of what happened. Deleting `volume_k` is not a
smaller version of the truth; it is a different claim. The test asserts the season-long
caller reports `hand_set` **while naming a live fit**, which is the whole point.

## The fourth field was not where it was reported

The unpinned served field was given as `season-sim.js:594`. That line is an *argument* —
`through: tradeBasis.through` — not something served. Reading the function around it found
the real defect.

`tradeImpact` computes `simProjectionBasis`, uses it to build one projection set shared by
both runs (correct: rebuilding would put Monte Carlo noise where the trade's effect should
be), and then returned `{ runs, from_week, seed, paired_simulation, me, them }` — no basis
and no fit meta at all. Both inner `simulateSeason` calls are handed `projections`, so each
one's own `projection_fit` is null by design, because it would describe a build it did not
make. **The trade verdict was the one number in this file served with no statement of what
it rests on**, while the sentence describing it had already been computed and thrown away.

So this field is added, not pinned, and its test was a RED.

## The restructure the mutations forced

The first version of `tradeImpactPayload` took a ready-made `projectionFit`. The mutation
that passed `null` instead failed no test: the caller could describe a build with arguments
the build never saw. The payload now takes `projOpts` — the same object the projections were
built from — and derives the fit meta itself. That is the pattern `simulateSeason` already
uses at its own call site, for the same reason, and it removes the divergence rather than
testing for it.

The payload is a function rather than an object literal so the served shape can be asserted
without standing up a whole league.

## Mutations

| # | mutation | result |
|---|---|---|
| P1 | delete `fit_id` | 3 fail |
| P2 | delete `recency` | 1 fail |
| P3 | delete `volume_k` | 2 fail |
| P4 | `volume_k` always `'fitted'` when a fit is active | 2 fail |
| S1 | delete `projection_basis` from the trade payload | 1 fail |
| S2 | delete `projection_fit` from the trade payload | 1 fail |
| S3 | payload ignores the opts and reports no fit | 1 fail (after the restructure) |
| S4 | `tradeImpact` passes opts it did not build with | **survives — see below** |

Every mutation was applied and the file confirmed changed before running; a pattern that did
not match is reported as NO-OP and is not evidence.

## What is NOT pinned, stated rather than glossed

**S4 survives.** The one remaining wiring line — `tradeImpact` passing its own
`tradeProjOpts` into the payload — cannot be caught without running `tradeImpact` against a
real league, and that needs a seeded players table, rosters, an asset universe and lineup
slots. No existing test runs `tradeImpact` for real; the two that mention it build its
return shape by hand. Building that fixture is a separate item and is not claimed here. What
*is* pinned is that the payload cannot invent a fit from nothing and cannot describe a build
from different arguments; what is not pinned is that this one call site hands it the right
object.

## Numbers

RED: 5 tests, 2 passed, 3 failed. GREEN: 5 passed, 0 failed.
Full local check `npm run check`: exit 0 — 2,997 tests, 2,956 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## The five questions

**Is this well built?** The three existing fields are now read in the state that makes them
mean something, and the fourth is served from one function so the payload has a single
definition. The restructure removed a divergence instead of asserting its absence.

**Is this based on stats, or is it made up?** Every field reports what a specific stored fit
and a specific recency resolve to; nothing is chosen. `volume_k` reads the resolved vector,
so a caller that later moves to weekly-role recency reports the change without anyone
remembering to update it.

**How do we know?** Seven of eight mutations fail. The eighth is named above as unpinned
rather than left implied.

**Should this data be pointed anywhere else on the platform?** Yes — Trade Lab renders the
trade verdict and now has a basis sentence and a fit identity to render beside it, which it
previously could not because neither was served.

**How does it unify?** `projection_basis` and `projection_fit` are the same two fields
`simulateSeason` already serves, under the same names, so a surface reads one contract for
the odds and for a trade comparison rather than two.
