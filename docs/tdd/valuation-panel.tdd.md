# TDD evidence: the valuation map reaches a surface

**What this is.** `server/services/counterparty-pricing.js` has computed a
per-manager, per-player valuation map — every factor named, capped, carrying its
sample size — since 2026-09-18. Nothing in the running app read it. A census of
this file's exports on 2026-09-20 found `valuationMap` with **no importer
anywhere** in `server/`, `client/` or `scripts/`: the layer that measured the
thing had no reader. This wires it to the surface that should have had it, and
does not rebuild any of it.

**Route.** `GET /api/trades/:leagueId/player/:id` (`server/routes/trades.js`),
the per-player Trade Lab detail, already fetched at
`client/src/pages/TradeLab.tsx:639`. One new field, `valuation_map`. No new
route, no new model, no new weight.

**It is a read, not a price.** Nothing on the panel feeds the deal score. The
clamp it reports per player is `PLAYER_VALUATION_CAP` (0.20,
`counterparty-pricing.js`); the deal score's own clamp is the separate ±10% at
`perceptionFactorFor` (`trade-engine.js:1362-1366`) and no field here touches
it. Those two numbers look alike and are not, which is why V6 pins which one the
panel is allowed to report.

## The guarded rules

| # | Rule | Test |
|---|------|------|
| V1 | The panel is on the response at all | 1 |
| V2 | A league with no manager signals says **which** absence it is | 1 |
| V2b | A player the model never priced and an unbuilt layer are two different sentences, and neither is an exception message | 3 |
| V3 | No `Map` reaches the client as `{}`; `managers` is an array; Nick is never his own counterparty | 2 |
| V4 | Every factor names its source and carries its `as_of`; a source under its `min_n` is reported **inert with its reason**, not dropped | 2 |
| V5 | The ablation is a **re-run** with the source suppressed, not arithmetic on its effect, and covers exactly the sources that fired | 2 |
| V6 | The clamp reported is `PLAYER_VALUATION_CAP`, and no field the deal score reads is on the panel | 2 |

## RED, then GREEN

RED is real, not retroactive: commit `2246178` adds three tests against a
response that has no `valuation_map` field at all. Both tests that existed at
that point fail on `the player detail carries valuation_map`.

## Mutation run, pasted verbatim

Harness `/tmp/claude-0/mutate.py` (session scratch; it prints `APPLIED` or
`NO-OP`, and a `NO-OP` is a defect in the injection, not a result — the
scheduler thread's rule).

```
P1  the panel is never put on the response                       APPLIED  -> V1/V2, V3-V6, V2b
P2  an unbuilt layer returns an empty panel instead of the reason APPLIED  -> V1/V2
P3  managers served as the raw Map, which res.json turns into {}  APPLIED  -> V3-V6
P4  the inert list is dropped from each valuation                 APPLIED  -> V3-V6
P5  the ablation is arithmetic on the factor's effect, not a re-run APPLIED -> V3-V6
P6  the ablation lists every registered source, fired or not      APPLIED  -> V3-V6
P7  the multiplier half of the ablation is dropped                APPLIED  -> V3-V6
P8  Nick is served as his own counterparty                        APPLIED  -> V3-V6
P9  an absent player returns a silent empty panel                 APPLIED  -> V2b
P10 an absent player falls through to the layer instead of saying so APPLIED -> V2b
```

Ten injections, ten caught, every test failed by at least one.

**Two of these were written twice.** P9 and P10 both survived their first pass.
P9 survived because the only test of an unpriced player asserted the reason was
long, not that it was the right one. P10 survived for a worse reason: with the
absent-player branch removed, the layer threw, the route's own error path
reported the crash, and the test read a crash sentence as an honest absence. The
fix is the rule V2b now states — **an unpriced player is answered by the panel,
not by its error handler** — and the two absences are asserted to differ from
each other rather than against pinned wording.

## The multiplier half of the ablation

`their_value = our_value x multiplier`, so for a player our own model has not
priced — `our_value` 0, which is any rookie or anyone with no projection yet —
**every value delta is exactly 0 however hard the sources are pulling.** The
fixture player is one of these, and the first version of the panel reported
`delta: 0` for two sources that were moving the multiplier by 6% and 3.25%. A
panel carrying the value alone says "this source does nothing" about a source
doing plenty. `multiplier_without` and `multiplier_delta` are on the contract for
that reason and the test pins them so they are not later tidied away as a
duplicate of `delta`.

## Is this well built? (the five questions)

Nick's standing rule, 2026-09-20.

**1. Is it based on stats, or is it made up?** The panel measures nothing new; it
serves what the layer already measured, and every number on it carries the
source, the cap and the sample size the layer attached. The caps themselves are
hand-set and say so (`fitted: false` on every entry of `VALUATION_SOURCES`) —
class H in `docs/NUMBER-PROVENANCE.md`, unchanged by this work. The one thing
here that is genuinely measured is the ablation, and it is measured by re-running
the valuation rather than by arithmetic, which is the difference between a
measurement and a restatement.

**2. How do we know?** Three tests, ten mutations, every one caught, pasted
above. Two of the mutations found real holes in the tests before the tests found
anything in the code.

**3. Structure.** One helper, `valuationPanel`, in the route file that owns the
surface; the layer is built once and handed to both the map and the ablation, so
the panel and its own ablation cannot end up on different answers about the same
league. The panel is wrapped in its own try/catch because it is an extra read on
a page that works without it — and the catch reports the fault in the response
rather than swallowing it, which is the `CLAUDE.md` rule that a layer going inert
must be visible on the surface.

**4. Should this data point anywhere else?** Yes, and deliberately not yet. The
same map answers "who should I call about this player" on the Trade Brain
manager board and "why is this package priced like this" on a trade card. Both
are routed through the coordinator rather than taken here, because the deal card
already has its own perception read and a second one beside it would be two
answers to one question — the exact failure `/brain/plan` was retired for.

**5. How does it unify?** One rule, and it is the night's general result applied
to a panel instead of a stamp: **an absence must say which absence it is.** The
panel has four of them — the layer was never built, this player was never priced,
this source has no data, this source has data but not enough — and V2b, V4 and
the `sources_absent` reasons are each one of those four refusing to collapse into
the others. The failure mode they prevent is the one the app already shipped
twice: a surface printing numbers as if nothing were missing.
