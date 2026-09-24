# CLONE-01b b2 — manager clones v2 + veto model

RED `e1223ddc` (test: RED for CLONE-01b b2 manager clones v2 + veto model) ·
GREEN `ded6aca0` (feat: CLONE-01b b2 manager clones v2 + veto model, behind GRIDIRON_CLONE_V2) ·
`test/clone-01b-b2.test.js`, 15 cases. Branched from #239 (b1 offer loop) head `e8dc0cf5`.

## What it is

Default-off (`GRIDIRON_CLONE_V2=1`, or `GRIDIRON_PREVIEW_UNCONFIRMED=1` via
`preview-mode.js`, then every clone says `preview: true` and its `why` starts
"Preview (unconfirmed forward)"). Off, `acceptanceBand` is called exactly as
before and returns the same bytes.

- **Clone prior** (`clonePrior`, trade-acceptance.js): his ESPN decided-offer
  accept rate shrunk to the league pool, `(k + m·p0) / (n + m)`, `m = 15`
  (CLONE-01a's fallback strength; guess), then capped logit offsets:
  motive state (desperate_buyer +0.4, buyer +0.2, seller +0.2, hold 0 — guesses)
  and trade activity (its `would_effect` when the activity term is withheld;
  when receptiveness already applied it, it is NOT added again).
- **Update** (`cloneFor`): Beta(p·S, (1−p)·S), `S = m + history n`, plus each
  settled reply to an offer Nick sent (`manager_clone_fits`), weighted by price
  relevance: a decline at gain g_d counts 1 for any package ≤ g_d for him and
  `exp(−(g − g_d)/10)` above; an accept mirrors it. Unknown price counts 1.
  Settled replies are subtracted from the ESPN history first (no double count).
- **Price bound / follow-up**: highest declined gain; `markCloneFollowUps`
  marks the cheapest shown package to that manager above it.
- **Band**: the clone enters as one capped factor (`clone`, cap 0.30), effect =
  clone p − centre, so it replaces the anchor rather than stacking on it.
- **Veto** (`vetoFactor`): P(veto) by `vetoRiskFor` level — low 0.02, watch
  0.10, high 0.30, unknown 0.05 (declared; n = 1 vetoed trade, C27), 0 when the
  threshold is unreachable, null with a reason when `vetoVotesRequired` is
  absent. `completion.band` = band × (1 − P(veto)). The band stays P(accept).
- **Writer**: `refreshCloneFits` (trade-outcomes.js), called by
  `settleOfferLoop` after every settle. Migration 086 adds
  `manager_clone_fits` and `trade_outcomes.pitch_json` (additive).

## Gates

| Gate | Pass |
|---|---|
| B1 | one decline lowers P(accept) for an equal package; worse ≤ equal; much better > equal; other manager equals his prior |
| B1b | one accept raises it |
| B1c | a settled reply is taken out of the ESPN history (history_n 10 → 9) |
| B2 | `zero:['clone','veto']` and `clone:null, veto:null` are byte-identical to today's band |
| B2b | on: `clone` factor = clone p − centre, band mid moves by exactly it |
| B3 | n = 0: clone = prior = shrunk accept rate |
| B4 | null threshold: `completion.band null` + reason; else mid × (1 − p_veto); unreachable → 0 |
| B5 | off by default; site flag on (not preview, even with preview set); preview alone on + labelled |
| B6 | refresh writes only decided sent replies (expired / pending left out), idempotent |
| B6b | `settleOfferLoop` returns `clones` |
| B7 | migration 086 columns exist |
| B8 / B8b | activity not double counted; motive capped, null state inert with its reason |
| B9 | cheapest package strictly above the bound |
| B10 | call site: context null when off; each deal reads its own partner's fit; veto from climate |

## RED

`node --experimental-test-module-mocks --test test/clone-01b-b2.test.js` on
`e1223ddc`: `# pass 0 / # fail 14`, e.g. `'acc.clonePrior is not a function'`,
`'acc.vetoFactor is not a function'`, `'outcomes.refreshCloneFits is not a function'`.

**Re-run after assertion changes:** the final test file (15 cases) against
the RED commit's source, in a worktree: `# pass 0 / # fail 15`.

**Fixture corrected after RED (test was wrong, recorded):** B1/B1b/B2b first
used a counterparty whose ESPN rate already contained the decline AND passed
the decline as a settled reply, compared with the same rate and no reply. With
the double count removed (B1c) those two states are the same evidence, so the
first GREEN run read `0.3 < 0.3`. The fixtures now compare the state before the
decline (3 of 9) with the state after (3 of 10 + the reply). B5 gained the
site-and-preview case after M9 survived; B9 gained a package exactly at the
bound after planning M10; B10 was added for the call-site mutants.

## Mutation sweep (15 cases, `scratchpad/mut.py`, one mutant at a time)

| Mutant | Result |
|---|---|
| M1 relevance direction flipped | killed |
| M2 no history subtraction | killed |
| M3 clone added on top of the centre | killed |
| M4 completion keeps the veto share | killed |
| M5 null threshold not inert | killed |
| M6 activity counted twice | killed |
| M7 expired counted as a decision | killed |
| M8 settle loop skips the clone refresh | killed |
| M9 preview flag ignores the site flag | survived first sweep → B5 case added → killed |
| M10 `>` → `>=` in cheapestAbove | killed |
| M11 call site: fit not read | killed |
| M12 call site: veto ignores the climate | killed |
| M13 call site: context ignores the flag | killed |
| M14 call site: give/get swapped in the gain | killed |
| C1 control: decay scale 10 → 11 | survived (designed: no test pins the scale) |
| C2 control: absent pattern | not applied |

## Pre-registration (EVAL E1), fixed before the LOCAL run

`scripts/rnd/grade-clone-e1.mjs`: every decided ESPN offer in the app DB,
prequential (only offers resolved before each proposal), y = accept 1,
decline / counter 0. Baseline = activity only, `(acc + 5g)/(n + 5)` as in
EVAL E1. Model = the shipped `cloneFor` (shrinkage + price relevance; motive
and activity cannot be rebuilt as of old dates and are left out, stated in the
output). Metric: mean per-offer log-loss gain, decider-clustered bootstrap
90% CI, seed 7, 1000 resamples.

- **Pass (the flag may be proposed for default-on):** CI lower bound > 0.
- **Fail (stays default-off, and the prior strength is revisited):** CI upper < 0.
- **Otherwise:** not enough data; stays default-off. At ~37 decided offers (C3)
  this is the expected result.

Synthetic control (scratchpad fixture, 40 offers, one manager accepting
everything): clone −0.054 [−0.147, −0.006]. The declared `m = 15` shrinks
harder than the baseline's 5, so with managers this different it loses; the
grade is sensitive in that direction, which is the known-nonzero case.

## Five questions

1. **Well built?** Pure functions in trade-acceptance.js, one writer in
   trade-outcomes.js, one call site in trade-engine.js; 15 tests, 14 mutants killed.
2. **Stats or made up?** The shrinkage is a beta-binomial posterior; `m`, the
   motive and activity offsets, the decay scale and the P(veto) levels are guesses.
3. **How we know:** nothing yet — the E1 grade runs on the local DB (LOCAL line).
4. **Pointed anywhere else?** `d.acceptance` on every finder idea (trade-engine.js
   `attachTactics`), so `/find`, `/evaluate`, `/offers/sent` (stores the band) and
   TradeCard see it when on.
5. **How it unifies:** no new service or ledger; acceptanceBand stays the one
   P(accept) producer, trade_outcomes the one offer ledger, vetoRiskFor the one veto read.

**Not covered:** the UI follow-up chip (the flag is on the deal's clone block
only); CLONE-01a is unmerged, so its fitted pool (`accept_pool`) is used when a
profile carries it and the n-weighted league rate at m = 15 otherwise; Sleeper
Arm 1 (Sleeper has no declines). **What would make it wrong:** manager-signals'
`tx_accept_rate` not containing the settled sent offers (then B1c's subtraction
under-counts his history by those replies).
