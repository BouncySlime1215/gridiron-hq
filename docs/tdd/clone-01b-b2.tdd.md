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
  `settleOfferLoop` after every settle. Migration 096 adds
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
| B7 | migration 096 columns exist |
| B8 / B8b | activity not double counted; motive capped, null state inert with its reason |
| B9 | cheapest package strictly above the bound |
| B10 | call site: context null when off; each deal reads its own partner's fit; veto from climate |
| B1d | a counter is not subtracted from the ESPN history (it is not in `tx_accept_rate`) |
| B11 / B11b | every "I sent this" writes `pitch_json` (fairness, shape, lead need, the one factor varied); accept rate by arm says "no claim before the prereg n" |
| B12 / B12b | `clone` valuation source inside `PLAYER_VALUATION_CAP`; `zero:['clone']` and flag-off byte-identical; the layer attaches `clone_fit` only when on |
| B13 | settled-reply terms: snapshot, then raw, then stored package; share reported |
| B14 | E1 grade reads terms snapshot-first and prints the share with terms |
| B15 | TradeCard follow-up chip only when `clone.follow_up` is set; preview labelled |
| B16 | Arm 1 grades only claims with >= 10 earlier claims, 2024 only |
| O9 | (offer-loop.test.js) pitch arm on a new row and on a slate row marked sent |

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

## Pre-registration, Arm 1 (Sleeper waiver choices), fixed before the run (FIX-288-6)

Committed before `scripts/rnd/grade-clone-arm1.mjs` exists or has run.
Spec: CLONE-01b "PRE clone test, Arm 1 (primary): Sleeper 2024 waiver choices,
managers with >= 10 prior claims."

- **Data.** A `sqlite3 .backup` copy of `data/derived/sleeper_history.sqlite`, and
  a copy of the app DB for the Sleeper id -> position map (`off_sleeper_players`,
  else `players`). The query reads season 2024 only; 2025 is never opened.
- **Events.** `sh_transactions` rows, `type = 'waiver'`, `status = 'complete'`,
  exactly one add, in a 2024 league. Ordered by week, then `created_ms`, then `seq`.
  Manager = (league, roster) within the 2024 league-season.
- **Outcome.** The position of the claimed player: QB, RB, WR, TE, K or DEF
  (a team-abbreviation id is DEF). An unmapped player is counted and skipped.
- **Graded events.** Claims by a manager who already has >= 10 complete one-add
  claims earlier in that league-season (prequential: only earlier claims are used).
- **What is tested.** Waivers have no price and no decline, so the price-relevance
  weighting and the price bound cannot be tested here; motive and activity are
  also left out. Arm 1 tests the clone's per-manager update, the categorical form
  of the shipped rule `(k + m*p0) / (n + m)` at the shipped `m = 15`.
  - pool `p0`: the league's earlier claims by position, `(count + 1) / (N + 6)`
  - **clone:** `(his count + 15 * p0) / (his n + 15)`
  - **baseline (primary):** EVAL E1's activity-only shape, `(his count + 5 * p0) / (his n + 5)`
  - **population (secondary):** `p0` alone, which is the clone at n = 0
- **Metric.** Mean per-claim log-loss gain = LL(baseline) - LL(clone), with a
  manager-clustered bootstrap 90% CI (1,000 resamples, seed 7).
- **Rule.** Pass: CI lower > 0. Fail: CI upper < 0 (the m = 15 strength is revisited).
  Otherwise: not decided. **Ship (spec):** only if Arm 1 passes AND Arm 2 is not
  worse in direction; else the flag stays default-off.

## PR sweep fixes (FIX-288-1..6), 9/24

- **FIX-1** migration is 096 (MIGRATIONS.md registry; no other open PR uses 096).
- **FIX-2** `CloneFollowUpChip` (client/src/components/trade/CloneFollowUpChip.tsx), rendered
  by TradeCard: "Cheapest package above the price he declined (+X% for him)". The server
  sets `clone.follow_up` only when `cloneMode()` is on (GRIDIRON_CLONE_V2, or preview mode
  through preview-mode.js, then the chip says "Preview (unconfirmed forward)").
- **FIX-3** `pitchArmOf` / `recordSentOffer` write `pitch_json` on every "I sent this"
  (TradeCard route and War Room store alike). Control arm: fair on his screen
  (|their_value_pct| <= 4, the engine's Fair & Clean line), 1-for-1, leads with a position
  he is short at. `varied` names the one factor that differs; two differ -> 'multiple';
  an unread factor -> 'unknown' (never the control). `pitchArmRates` and
  `GET /:leagueId/offers/pitch-arms` report accept rate by arm with a Wilson 90% CI,
  labelled "no claim before the prereg n" (20 settled offers per arm, a guess).
- **FIX-4** `VALUATION_SOURCES.clone` (cap 0.10, min_n 1) inside PLAYER_VALUATION_CAP.
  `counterpartyLayer` attaches `clone_fit` from `cloneFitsFor` only when the flag is on.
  For a player he owns, a decline at +g% for him prices that player up by g% (capped);
  a decline that already cost him value is inert with its reason.
- **FIX-5** `refreshCloneFits` and `grade-clone-e1.mjs` read offer terms from
  `trade_proposal_snapshots` (#247, migration 084) first, then raw `items_json`.
- **FIX-6** below.

## Results on the local DB copies (FIX-288-6)

**Does `tx_accept_rate` include settled sent offers?** Mostly. manager-signals counts a
manager's own `EXECUTE` TRADE_ACCEPT and TRADE_DECLINE rows. On the DB copy, for all 6 of
6 managers who carry the metric (n >= 5), the stored rate and n match that raw count
exactly. So a settled **accept or decline** of an offer Nick sent is inside it once the
collector has seen it. A **counter** is not: ESPN writes it as his own TRADE_PROPOSAL.
`cloneFor` now subtracts only accepts and declines (B1d). There are still 0 settled sent
offers (`trade_outcomes` has 0 rows with `sent_at`), so this is checked on the ESPN
rows, not on a real sent offer.

**Arm 2 (ESPN, `grade-clone-e1.mjs --db <copy>`):**
- **n:** 37 decided offers graded (7 accepted), 13 deciders, 3 leagues.
- **Terms:** 37 of 78 decided offers had terms (47.4%), all from raw rows. `trade_proposal_snapshots` is absent on this DB (#247 is unmerged). 41 decided offers have no terms, and 36 of 37 have a known price.
- **Log loss:** activity-only 0.5301, clone 0.5450, clone without price 0.5433.
- **Clone vs activity-only:** −0.0150, 90% CI [−0.0488, +0.0151]. The CI spans 0, so this is not decided, and the direction is worse.
- **Clone without price:** −0.0132 [−0.0371, +0.0074].

**Arm 1 (Sleeper 2024 waiver choices, `grade-clone-arm1.mjs`, pre-registered above):**
- **n:** 37,541 complete 2024 claims read (818 unmapped). 9,364 were graded, from 1,331 managers with at least 10 earlier claims, in 407 leagues.
- **Log loss:** population 1.6795, activity-only (k=5) 1.7354, clone (m=15) 1.6855.
- **Primary, clone vs activity-only:** +0.0499, 90% CI [+0.0464, +0.0533]. This is a **PASS** by the pre-registered rule.
- **Secondary, clone vs population:** −0.0059 [−0.0112, −0.0008]. This **fails**.
- **Reading:** The primary pass comes from shrinking harder (m = 15 beats k = 5). It does not come from learning the manager. The pool alone beats both per-manager updates.

**Verdict under the spec's ship rule.** Arm 1 passes its primary, but Arm 2 is worse in direction (−0.0150), so the rule is not met. `GRIDIRON_CLONE_V2` stays default-off. The secondary suggests m should be larger than 15, or the update should carry less weight than a full claim. That is a hypothesis for a new pre-registration, and this data is not used to pick m.

## Five questions

1. **Well built?** Pure functions in trade-acceptance.js, one writer in
   trade-outcomes.js, one call site in trade-engine.js; 15 tests, 14 mutants killed.
2. **Stats or made up?** The shrinkage is a beta-binomial posterior; `m`, the
   motive and activity offsets, the decay scale and the P(veto) levels are guesses.
3. **How we know:** Arm 2 not decided (n = 37, worse in direction); Arm 1 primary passes, secondary fails (see Results).
4. **Pointed anywhere else?** `d.acceptance` on every finder idea (trade-engine.js
   `attachTactics`), so `/find`, `/evaluate`, `/offers/sent` (stores the band) and
   TradeCard see it when on.
5. **How it unifies:** no new service or ledger; acceptanceBand stays the one
   P(accept) producer, trade_outcomes the one offer ledger, vetoRiskFor the one veto read.

**Not covered:** CLONE-01a is unmerged, so its fitted pool (`accept_pool`) is used when a
profile carries it and the n-weighted league rate at m = 15 otherwise. Arm 1 cannot test
price relevance (Sleeper has no declines or prices). The `clone` valuation source and the
band's clone factor read the same declines (the spec asks for both); with the flag on, a
decline lowers P(accept) and raises his price, and whether that double-charges is not graded.
**What would make it wrong:** a settled sent offer that the collector has not seen yet, or
a manager-signals build older than the settle, is in the update but not yet in
`tx_accept_rate`, so the subtraction under-counts his history until the next build.
