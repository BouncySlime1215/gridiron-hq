# trade-engine-correctness — TDD evidence

**Item:** WA Trade Brain T0. **Date:** 2026-09-18. **Branch:** `cursor/betting-model-audit-fixes-1c85`.
**Gate:** pre-registered in `scratchpad/wa/trade-engine-correctness/GATE.md` before the first test
or line of code, and repeated in the code comments of `myPlayoffOdds`, `tradeIdeasFingerprint`,
`HARD_TIER_FACTOR`, `perceptionFactorFor` and the dedupe block.

Nothing in this item is a fitted model, so there is no season split and no bootstrap. The one new
number that enters the ranking — each roster's real P(make playoffs) — is produced by the existing
`season-sim.js` Monte Carlo, so its gates are about determinism, cost and provenance.

---

## 1. Audit before the code (DISCOVER → AUDIT → DECIDE)

Read-only, on a `VACUUM INTO` copy of production taken 13:03 (`baseline.log`).

| What the inventory said (section C) | What I measured |
|---|---|
| "nothing ever passes `playoffOdds`, so it always uses 0.5" | Confirmed: `horizon.playoff_odds` = 0.5 in 5 of 5 leagues. The real seeded odds from week 2 are 0.69 / 0.58 / 0.26 / 0.31 / 0.87. |
| "the `findTrades` cache fingerprint leaves out `manager_signals`, `manager_player_view`, `league_member_identity` and the chat DB" | Confirmed; `manager_profiles` was also stamped by row count only, so editing a tier in place was a cache hit. |
| "the 0.55 factor is applied in `counterparty-pricing.js` and again in `trade-engine.js`" | Already half-fixed by the manager-data-pipeline item: `counterparty-pricing` now only reports the tier. The engine still read the tier in three places and folded it into the reported `receptiveness` on one branch, which is what made the double discount invisible. |
| "`offerFor`/`offerForMany` ignore the chat reads and timing weighting" | Confirmed: no horizon, no counterparty layer, ranked on the flat weekly delta. |
| Not in the inventory — found here | `unique` (one idea per headline pair) ran BEFORE the mutual/plausible filter, so the dedupe could spend an idea's only slot on a variant the filter then rejected. Named in the manager-data-pipeline handoff for T0. |
| Not in the inventory — found here | The ±10% perception factor was driven by `perception_delta`, which includes our own value gap; the fairness term and the value cost already charge for that. |

**Decision: EXTEND `findTrades` + `counterparty-pricing`, RETIRE the four duplicates.** The
inventory's default decision is confirmed. The per-manager layer is already there, so this is
correctness work on one engine, not a new one.

## 2. User journeys

1. *As Nick, when I open Trade Lab, I want the ideas ranked for the team I actually have* — a
   long-shot team should not be told its December roster matters as much as a contender's.
2. *As Nick, when the manager reads are rebuilt, I want the trade list to change* — not to be served
   yesterday's ranking because a row count happened not to move.
3. *As Nick, I do not want to be rewarded for giving value away* — not by a doubled "hard" discount,
   not by a perception term that is really our own value gap.
4. *As Nick, I want the best version of an idea that both teams accept* — not to lose it because a
   greedier variant of the same idea scored higher and failed the filter.
5. *As Nick, when I ask "what do I send for him", I want the same numbers the league list used.*
6. *As Nick, I want one answer per question* — not five surfaces quietly disagreeing.

## 3. RED → GREEN

| Commit | Stage | Evidence |
|---|---|---|
| `40c9dcb` | RED | `test/trade-engine-correctness.test.js` 12 of 12 fail; `test/trade-route-retirement.test.js` 3 of 5 fail (the two that pass are guards on what must REMAIN: `sellHigh` exists, no client calls a retired route). |
| `e8ac85c` | GREEN | 12/12 and 5/5; `test/league-brain.test.js` rewritten to the retirement, 5/5. |
| `698284a` | Refactor | Week and format derived once per call; warm `tradeIdeas` 79 ms → 39.6 ms, same answers. |

## 4. Test specification

| # | What is guaranteed | Test | Result |
|---|---|---|---|
| G1a | The horizon is priced on this roster's real playoff odds, and every deal carries the split those odds produce | `trade-engine-correctness:G1a` | PASS |
| G1b | Those odds are the simulator's own number for this roster, seeded, identical between calls | `:G1b` | PASS |
| G1c | A league the simulator cannot run falls back to the 0.5 prior and says why in `playoff_odds_source` | `:G1c` | PASS |
| G2a | A new manager profile AND a tier flipped in place both change the fingerprint | `:G2a` | PASS |
| G2b/c | With nothing changed the cache still hits (same object) | `:G2b/G2c` | PASS |
| G3 | A "hard" manager is discounted 0.55 once (0.3025 = twice), and the tier never leaks into the reported receptiveness | `:G3` | PASS |
| G4 | The perception factor is 1 when uninformed, signed by `perception_shift`, capped at ±10% | `:G4` | PASS |
| G5 | One idea per headline pair, taken after the filter; no mutual idea is hidden from the mutual list | `:G5` | PASS |
| G6a/c | Every ladder rung carries the same horizon as the league list; "fair" is the most efficient rung on horizon-weighted gain | `:G6a/G6c` | PASS |
| G6b | Every ladder states what counterparty data it had | `:G6b` | PASS |
| G8a | `findTrades` and the entry point return the same ranking and the same odds | `:G8a` | PASS |
| G8b/c | The header documents `tradeIdeas`; the trade-engine ↔ season-sim cycle loads in both orders | `:G8b/G8c` | PASS |
| G7a | Four retired routes return 410 with a `use` pointer | `trade-route-retirement:G7a` | PASS |
| G7b | `enumerateDeals` and `acceptProbability` are gone from league-brain | `:G7b` | PASS |
| G7c | `sellHigh` survives as an input | `:G7c` | PASS |
| G7d | No client file calls a retired route | `:G7d` | PASS |
| — | league-brain keeps exactly `TRADEABILITY`, `brainState`, `managerProfiles`, `setManagerProfile`, `recordNote`; a tier round-trips; an unknown tier is refused | `league-brain.test.js` 5/5 | PASS |

## 5. Measured effect on Nick's five leagues

Controlled A/B: the same production copy, duplicated; old code at `82b6fdb` in a git worktree,
new code at HEAD; both run cold in their own process (`ab-old.json`, `ab-new.json`).

| League | Playoff odds before → after | "Both teams improve" ideas before → after | Ideas dropped | Cold ms before → after | Warm ms before → after |
|---|---|---|---|---|---|
| 1 Matta-Kodsi | 0.5 → 0.69 | 18 → 25 | 0 | 10,901 → 14,927 | 24 → 34 |
| 2 DMV | 0.5 → 0.58 | 3 → 5 | 0 | 1,179 → 5,060 | 24 → 38 |
| 3 My 2025 | 0.5 → 0.26 | 5 → 20 | 0 | 1,582 → 4,751 | 21 → 36 |
| 4 Transfer portal | 0.5 → 0.31 | 3 → 15 | 0 | 1,415 → 6,170 | 27 → 41 |
| 5 My 2026 | 0.5 → 0.87 | 6 → 9 | 0 | 1,070 → 4,877 | 36 → 38 |

**39 new ideas, none lost.** Attribution, measured by forcing the new code back to the 0.5 prior:

- The **count** increase is entirely the dedupe-ordering fix (G5). Idea counts are identical with
  real odds and with the forced prior.
- The **ordering** change from real odds today: 7 of 25 ideas move rank in league 1, 13 of 20 in
  league 3, 4 of 15 in league 4, 2 of 9 in league 5, 0 of 5 in league 2. Only league 3's top three
  reorder this week; the weighting binds harder every week as the season runs down.
- The named case from the manager-data-pipeline handoff reproduces: in league 4 the mutual list now
  contains `Deebo Samuel + Juwan Johnson → Jalen Coker` (0.351). The variant that used to take the
  slot, `Deebo Samuel → Jalen Coker` (0.413), is still the higher-scoring idea and is still not
  mutual — so it appears in the relaxed list and no longer hides the one both teams like.
- The perception fix moves 5 of league 4's 62 ideas, and flips the sign of the factor on 3 of them
  (e.g. `delta = +6, shift = −3`: the old code rewarded a deal that his own views make worse for him).

Ladders (`offerFor`): 20 of 20 sampled targets now produce offers, against 18 of 20 before. Offer
counts are identical on every target both runs shared, with one deliberate exception — for Jalen
Hurts in league 3 the rung `Bucky Irving` is gone: weekly +0.1, playoff −1.9, horizon-weighted gain
≤ 0. The old ladder offered a package that makes Nick's team worse over the rest of the season.

## 6. Coverage and known gaps

- The two new test files cover every gate. The engine's existing suites (`find-trades`,
  `trade-evidence`, `post-draft-plan`, `asset-cache-stamps`, `manager-data-pipeline`,
  `waiver-brain`, `decision-inbox`, `legacy-route-security`, `model-integrity`, `lineup-evidence`)
  all pass unchanged.
- Not covered by a test, measured by hand: the cold cost. `myPlayoffOdds` adds a 1,000-run season
  simulation per league per data change (3.4–4.8 s measured). It is cached on the asset fingerprint,
  so it is paid once per sync, not per request.
- `deriveFormat` measures 13 ms on production data. It is not this item's file; the entry point now
  derives it once, but other callers pay it repeatedly.
