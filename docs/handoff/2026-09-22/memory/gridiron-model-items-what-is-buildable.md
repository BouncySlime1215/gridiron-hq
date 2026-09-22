---
name: gridiron-model-items-what-is-buildable
description: The four model items Nick approved 2026-09-20 — which is already built, which cannot be built as named, and the file evidence for each.
metadata:
  type: project
  modified: 2026-09-20T02:00:54.368Z
---

Nick approved four model items alongside the UI redesign (01:38Z 2026-09-20),
with the gate "just talk to me b4 u do it". Specs sent to the coordinator
01:5xZ. Two of the four are not what their names suggest.

**1. Two-sided trade simulation — ALREADY BUILT AND WIRED. No new model.**
`season-sim.js#tradeImpact` (:573) runs the league twice under
`withRandomSeed(pairedSeed, …)` with roster overrides on both sides, calls
itself a paired experiment on common random numbers at :597-599, and returns
`{ me, them }` with title_before/after, playoff_before/after, wins_delta for
both. Served at `/model/:id/trade-impact` (routes/model.js:559). Rendered both
sides already: TradeLab.tsx:305-306 (`their_title_delta`), TradeCard.tsx:360.
So it is a UI-depth item. **Do not build a second one** — league-brain.js:185-193
records a retired second trade enumerator and second acceptance model that
"disagreed with the trade engine by construction".

**2. Calibrated acceptance probability — real, smaller than the name.**
`league-brain.js#TRADEABILITY`: three ELICITED tiers (never 0.03, hard 0.35,
fair 0.75), multiplicative not additive, reasoning at :99-109.
`counterparty-pricing.js:180-182` blends a real observed rate over it, weight
`min(1, n/15)`, from `manager-signals.js:206-208` which withholds
`tx_accept_rate` below five decided offers. The header says P(accept) "is
elicited, not learned… there is no trade history in this database to fit on" —
still true. **Live `manager_profiles` has 0 rows, so every league runs the
'fair' default today.** Buildable: a UI for `setManagerProfile` (it has none),
and surfacing which of the three sources priced a manager with its n. Calling a
tier-times-attractiveness product "calibrated" without a fit is the false
precision the file refuses.

**3. Personnel groupings — TEAM-LEVEL ONLY.** `nfl_play_by_play` (schema
`nfl-a-to-m.js:306-333`) has `shotgun`, `no_huddle`, `pass_depth`,
`pass_direction`, `offense`, `defense`, `down`, `distance`, and **no player
column**. Per-player personnel splits are not available at any effort. What is:
shotgun rate, no-huddle rate, six pass cells (short/deep × left/middle/right),
by down and distance. Two denominators must be on screen or the grid lies —
`parseFormation` (nfl-espn-pbp.js:103-105) leaves `shotgun` null with no leading
parenthetical, so the denominator is "plays ESPN tagged"; and the only writer is
`nfl-espn-pbp.js:185` off live polling, so coverage is games polled live.
Proposed new file `server/services/team-tendencies.js`; owner unassigned.

**4. Defence vs position — CANNOT become a projection input.**
`matchups.js:28-63` records a pre-registered out-of-sample test: DvP strictly
prior, fitted K=200, recency 0.5 → 2025 MAE **+0.0007, CI [-0.0021, +0.0035]**;
at the old K=12 it made in-sample predictions **worse** (+0.0072); first-half to
second-half r = +0.027. **Every multiplier in that file is hard-coded to 1 with
`signal: false`, behind code constants rather than env vars specifically so more
data cannot switch it back on.** It ships as descriptive history in the deep
dive, labelled as history, beside the sentence that it did not predict. Turning
a multiplier back on requires re-running that test and passing it.

None of this touches the advanced-stats projection arm from the model audit.

See [[gridiron-ui-redesign-build-order]].
