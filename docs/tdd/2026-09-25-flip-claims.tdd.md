# FLIP-CLAIMS: waiver claims only as flip pieces (SEARCH-WIDE)

RED `<this branch's test commit>` · GREEN follows · `test/campaign-flip-claims.test.js`,
`test/campaign-search-wide.test.js` (W5 / W8 rewritten), `test/rule-fuzz.test.js`.

Unit source: Nick's decision "flip claims" (2026-09-25). In SEARCH-WIDE (#406, flag
`GRIDIRON_SEARCH_WIDE`, off by default) a free-agent waiver claim may be a step in a path
ONLY as a flip piece: the claimed player is traded away later in the same path, so Nick
never holds a sub-83 claim at the path's end. #406's own note: the 83+ floor blocked most
end-of-path claims.

## Scope

All inside the one planner (`search.js#searchTarget`, `planner.js`); the claim rules live in
ONE module, `server/services/campaign/search-wide.js` (it reads `heldAtEnd` from
`gets-floor.js`, the pins from `never-give.js` / `search.js`, the tier from `ladder.js`; no
second copy of any of them).

1. **Claims are flip pieces.** A claim step (partner `free_agent`) is built first in the
   path, and a later trade step in the same path gives the claimed player away (a direct
   finish to the target's owner, or a chip that a finish follows). End-of-path claims are no
   longer built. A path whose claimed player is still held at the end is dropped,
   `claim_not_flipped`. GETS-FLOOR on everything held at the end is unchanged.
2. **The drop.** The player Nick releases is never protected: never 160 / 80 / 277, never
   one of his untouchables or the objectives file's, never a Blue chip (83+), never
   unscored (fails closed), never a player acquired on the path. Among the rest: bench
   before starters, then the lowest FantasyCalc value. Overpay: the claim step counts the
   drop's value as what Nick gives for the claimed player, and the flip step counts the
   claimed player's value as what Nick sends (the normal step cap). Cap 0 on the claim step
   (a 1-for-1, so the +12% depth-only 2-for-1 exception never applies to it); the flip step
   keeps today's rule (cap 0, +12% only on a confirmed depth-only 2-for-1). A drop or a
   claimed player with no FantasyCalc value fails closed.
3. **Stranded risk.** If the flip leg fails, Nick holds the claimed free agent and has lost
   the drop. Every claim path that passes 1-2 is re-priced on the confirm dice (the same
   `priceOnConfirm` a served card uses); the stranded branch (claim done, flip declined) is
   in that price at the flip leg's P(yes) and is reported on its own. The path is kept only
   when it beats doing nothing on the confirm dice (`beats_no_trade` under the active mode,
   and confirm-dice expected > 0); else `claim_stranded` (or `confirm_failed` when the
   confirm verdict fails). No sold player (whole season, no price-fall exception) and never
   290 may be claimed: removed from the pool, and a path that claims one is dropped
   (`claim_sold`). A claim's P(yes) stays the league's waiver-win rate (#406).
4. **RULE-FUZZ.** The oracle (`test/fixtures/nick-rules.mjs`) gains `claim_not_flipped`,
   `claim_protected_drop` and `claim_stranded`, and reads the claim paths the planner reports
   (`search_wide.claims.paths`) with every other rule too (never give, overpay on each step,
   final gets, no buy-back). A claims sweep runs the planner with SEARCH-WIDE on over seeded
   leagues that carry a free-agent pool.
5. **UI.** Claim paths stay shadow (`search_wide.claims`), never in the deck, next move or
   any served number, as #406 left them: no claim-step renderer exists in `client/`.

## Flag

Unchanged: `GRIDIRON_SEARCH_WIDE=1` on, anything else off. Off, no code path here runs.

## Pre-registration (written before any code)

Fixtures only (made-up players). No real data.

| # | Metric | Pass bar | What fails it |
|---|---|---|---|
| F1 | Flip only | with a claim pool, every claim path the search returns has the claim at step 1 and a later trade step that gives the claimed player; no path ends holding a claimed player | a claim at the end, or a claimed player held at the end |
| F2 | claim_not_flipped | the rule module drops a hand-built path whose claimed player is never given on, with reason `claim_not_flipped`; the planner reports every claim drop reason (this one included) under `search_wide.claims.dropped_by_reason` | kept, or another reason |
| F3 | Protected drop | the drop is never 160 / 80 / 277, an untouchable (adapter or objectives file), a Blue chip or unscored; a hand-built path with any of those is dropped `protected_drop` | any protected drop kept |
| F4 | Lowest-value bench drop | the search's drop is the lowest-value droppable bench player (a starter only when no bench player is droppable) | a pricier bench player, or a starter while a bench player was droppable |
| F5 | Overpay | cap 0: a claim step whose drop is worth more than the claimed player is never built and a hand-built one is dropped `claim_overpay`; a flip step giving more than it gets is never planned | any overpaying claim or flip step kept |
| F6 | Stranded | every kept claim path carries `dice: 'confirm'`, a stranded branch, and a confirm-dice expected > 0; a path that fails it is dropped `claim_stranded` and counted | a kept path at <= 0 on the confirm dice |
| F7 | Sold | a sold player (whole season) and 290 are never in the pool; a hand-built path claiming one is dropped `claim_sold` | a sold player claimed |
| F8 | Shadow | flag on, no served step (next move, alternatives, itinerary, targets) is a claim; the best claim path is reported as shadow | a served claim |
| F9 | RULE-FUZZ | the claims sweep finds 0 violations of every rule, including the three new ones, and is not vacuous (claim paths reported in some leagues); the oracle catches each new rule on a hand-built result | any violation, or a vacuous sweep |

## Results (GREEN, after the pre-registration above)

RED `ab9b9431` (rebased; first written as `a0321475`): 13 of 20 claim tests failed on main's code
(the end-of-path claim search, no `claimRule` / `pickDrop` / `strandedBranch`). GREEN `34ef326b`, then
`gets-floor.js#isFlipPieceClaim` (the one flip-piece rule, shared with FLIP-STRANDED #432 at the
coordinator's request) and the `premium_gate` count / `best_stranded` report.

Test-only changes after RED, pass bars unchanged: F2 gained the `isFlipPieceClaim` cases; F6's
"hurt" case also checks the reported `best_stranded`. `confirm.js#confirmVerdict` fails exactly when
the confirm-dice expected is <= 0, so a failed verdict is counted as `claim_stranded` (first coded as
`confirm_failed`, which now means "no confirm dice").

| # | Result |
|---|---|
| F1-F8 | pass (`test/campaign-flip-claims.test.js` 10/10, `test/campaign-search-wide.test.js` 18/18) |
| F9 | pass: RULE-FUZZ 44/44 (was 39). Claims sweep, seeds 1..40, every mode: 6,307 claim paths built, 134 / 204 / 397 reported (safe / balanced / all-in) in 35 / 36 / 40 leagues, 0 violations of any rule |

League 4 (snapshot copy, live env + `GRIDIRON_SEARCH_WIDE=1`): see the PR. 57 flip claims built,
22 scored, 0 kept (21 `claim_stranded`, 1 `premium_gate`); the next move is unchanged.
