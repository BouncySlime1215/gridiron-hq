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

## Mutation table

Each row records `server/routes/trades.js`'s SHA-256 before and after, because a
pattern that does not match leaves the file unchanged and the run is the baseline
wearing a mutation's name. Each row also names the **one** test it must turn red:
an injection that lands but kills a different test is unfinished, not a result.
The last row is a deliberate control whose pattern is not in the file — it is what
shows the verification can fail.

Harness `/tmp/claude-0/mutate2.py` (session scratch, so the output is pasted here
rather than referenced). Baseline `0d825e8efc97` for every row.

| Mutation | Verification | Result | Fails | Named test red? |
|---|---|---|---|---|
| the panel is never put on the response | APPLIED `0d825e8efc97` → `a4b2a3e51592` | RED | 3 | yes (V1/V2) |
| an unbuilt layer returns an empty panel instead of the reason | APPLIED `0d825e8efc97` → `d2aa1ef110cf` | RED | 1 | yes (V1/V2) |
| managers served as the raw Map, which `res.json` turns into `{}` | APPLIED `0d825e8efc97` → `0b800ee13e7e` | RED | 1 | yes (V3-V6) |
| the inert list is dropped from each valuation | APPLIED `0d825e8efc97` → `62813c7a5a86` | RED | 1 | yes (V3-V6) |
| the ablation is arithmetic on the factor's effect, not a re-run | APPLIED `0d825e8efc97` → `63ba51f98969` | RED | 1 | yes (V3-V6) |
| the ablation lists every registered source, fired or not | APPLIED `0d825e8efc97` → `dcfec53379bf` | RED | 1 | yes (V3-V6) |
| the multiplier half of the ablation is dropped | APPLIED `0d825e8efc97` → `093ed6470c5f` | RED | 1 | yes (V3-V6) |
| Nick is served as his own counterparty | APPLIED `0d825e8efc97` → `8169370c8037` | RED | 1 | yes (V3-V6) |
| an absent player returns a silent empty panel | APPLIED `0d825e8efc97` → `1b4b8213f7d0` | RED | 1 | yes (V2b) |
| an absent player falls through to the layer instead of saying so | APPLIED `0d825e8efc97` → `e2385f6a57ff` | RED | 1 | yes (V2b) |
| **CONTROL** — pattern not in the file | **NO-OP — pattern not found** | — | — | — |

10/10 caught by the test that names them; the control reported NO-OP and ran
nothing. The source was restored and verified byte-identical after every row.

## Surviving mutations

**None survive.** Nothing here is declared equivalent — no injection is being
waved through with a reason. Two of the ten, however, survived their FIRST pass,
and both were holes in the tests rather than in the code. They are recorded
because the fix is the guarantee:

| Survived first pass | Why it survived | The test that kills it now |
|---|---|---|
| an absent player returns a silent empty panel | the only unpriced-player test asserted the `reason` was a long string, which is true of every absence | V2b asserts the two absences differ **from each other**, rather than pinning either one's wording |
| an absent player falls through to the layer instead of saying so | with the branch removed the layer threw, the route's own error path reported the crash, and the test read a crash sentence as an honest absence | V2b asserts `reason` does not match `/failed to build/` — an unpriced player is answered by the panel, not by its error handler |

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

## Full check on the exact tree

`npm run check` — typecheck, lint, suite, build, `start:smoke` — exit 0 on
`9bc4bfd` (`claude/project-thread-3xqh5l-accessor-hold`), nothing else running
against it:

- **2,990 tests, 2,949 pass, 0 fail, 41 skipped**, 350.5 s
- lint clean across **876** JavaScript files; typecheck clean
- build 0; startup smoke passed on an isolated database (32 teams)

**Correction, 2026-09-20.** This line first said 877. `scripts/lint.mjs` walks
`server`, `scripts` and `test` on the filesystem, so it counts untracked files
too; `git ls-tree -r 9bc4bfd -- server scripts test` counts **876** `.js`/`.mjs`
files, and the same at `3afdb25` and `1f8562e`. The 877 reading therefore
included a file that is not in the commit. The count is a property of the tree,
so it is stated from the tree.

`npm ci` has not been run in the container these numbers came from. A fresh clone
fails the offline-guard tests with `ERR_MODULE_NOT_FOUND` until it is, which looks
exactly like a regression and is not one. CI is not run: Actions is out of minutes
until 2026-10-01 and the workflow is disabled deliberately.

## Follow-on: one flag for "unpriced"

This panel decides "not priced" in one place — `resolvePlayer()` returning null at
`server/routes/trades.js:786-788`, which means the id is not in the league's asset
universe at all — and the tests carry a second, narrower notion at
`test/valuation-panel.test.js:217`, `our_value === 0`, which is a player who IS in
the universe and whom the market never priced. Those are two different facts and
the second one is currently inferred from a zero.

Feature audit's D13 puts `value_priced` on each asset (the universe resolves a
missing market row to value 0, and the asset will now say so). **The moment D13 is
on main, `our_value === 0` here reads `value_priced` instead** — a zero is a
number and a flag is a fact, and inferring the second from the first is the same
mistake this whole branch is about. D13 is off `main` and this branch sits on
#41's base, so the switch lands in the first commit after the morning merge rather
than here.

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
