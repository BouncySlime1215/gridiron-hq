# SEARCH-WIDE: search thousands of paths, laterals only toward a Blue chip, claims as steps

RED `<this branch's test commit>` · GREEN follows · `test/campaign-search-wide.test.js`.

Unit source: `docs/handoff/local/ONE-PLAN.md` on `claude/handoff-package-2026-09-22`,
section 5, night 6: "SEARCH-WIDE: node budget on the PRODUCER-FAST cache, depth 3,
lateral depth-for-depth only when the path ends at the tier floor, claims as steps
(free-agent ros_ppg beats the given piece)". Its check: `candidates_scored` >= 2,000
within the printed tick budget (target <= 10 min cold, a guess); same-seed best not
below the incumbent; `validatePlans` ok; `risk_modes[].first_step` differs.

## Scope

All inside the one planner (`server/services/campaign/search.js#searchTarget`,
`planner.js`); no second search. CHESS-01a (#258) is folded in as the wider depth-3
beam below, not as its own planner.

1. **Node budget.** A league-wide budget of exact-scored candidate paths
   (default 2,400) and of fresh rescores (default 2,400: ~10 min cold at the
   measured ~250 ms each; a guess until measured). A fresh rescore is a
   PRODUCER-FAST cache miss when the adapter has the cache, else a planner memo
   miss; cache hits are free. The incumbent shortlist is always scored first and
   never cut by the budget, so the wide search is a superset of today's.
2. **Depth 3, wider.** The second chip layer takes the top 24 distinct first
   steps (today 6) and may give 2 (today 1). Every enumerated path beyond the
   incumbent shortlist is scored in heuristic order until the budget runs out.
3. **Laterals.** A lateral is a trade step where every player given and every
   player got is scored below the Blue chip floor (depth for depth). A path with
   a lateral is kept only when every player Nick acquires and still holds at the
   end passes the floor (83+). Unscored counts as below (fails closed).
4. **Claims as steps.** A path of 1 or 2 trades may end with one free-agent
   claim: add a free agent from the claim pool, drop Nick's same-position depth
   piece (scored below the floor, never untouchable, never 160 / 80 / 277, never
   a player acquired on the path), only when the free agent's ros_ppg beats the
   dropped piece's. Scored by the same world (the adapter simulates the claim
   pool as the sim's `universe`); no claim pool, no claims.

## Flag

`GRIDIRON_SEARCH_WIDE`: `1` on; anything else (unset included) off. The preview
switch does not turn it on. Off, `searchTarget` and `planLeague` run today's code
path and the producer writes no new key. Budgets: `GRIDIRON_SEARCH_WIDE_CANDIDATES`,
`GRIDIRON_SEARCH_WIDE_RESCORES` (positive integers; else the defaults).

Nick's hard rules are not behind this flag and are not changed by it: the claim
step and every wider path pass the same never-give / never-get pins, the
no-overpay cap on trades, GETS-FLOOR on everything held at the end, trade memory
(no buy-backs, claims included) and the confirm-dice no-trade check.

## Pre-registration (written before any code)

Fixtures only (made-up players, `test/fixtures/campaign-league.mjs`). No real data.

| # | Metric | Pass bar | What fails it |
|---|---|---|---|
| W1 | Budget binds | with the flag on and a budget of N candidates, exact-scored candidates beyond the incumbent shortlist <= N; `budget_hit` names the budget that bound; a tiny rescore budget stops extras with `budget_hit: 'rescores'` | more extras scored than the budget; wrong `budget_hit` |
| W2 | Wider, never worse | on the same seed, every path key the off search returns is in the on search's result (lateral rule aside), and on scores strictly more candidates on the fixture league | an incumbent path is missing on; on scores no more than off |
| W3 | Depth 3 widened | on finds a 3-step path whose second chip gives 2 players, which off cannot build | no such path on, or one off |
| W4 | Laterals only toward the floor | a depth-for-depth chip step is kept only when everything held at the end passes 83; with the target scored below 83 the lateral path is dropped and counted | a lateral path ending below the floor survives |
| W5 | Claims as steps | with a claim pool, a claim step (partner `free_agent`) ends a 1- or 2-trade path, drops a same-position depth piece with lower ros_ppg; none when the free agent's ros_ppg does not beat it, when there is no pool, when the only candidate drop is untouchable / pinned / a Blue chip, or when the free agent is pinned never-get; a claim is never step 1 | any of those |
| W6 | Hard rules hold on | flag on: no served step gives an untouchable; no trade step overpays past the 0 cap; every served card beats doing nothing on the confirm dice | any violation |
| W7 | Off is today | flag off: the producer entry has no `search_wide` key and `planLeague` output equals a run with the variable unset | any difference |
| W8 | Contract | flag on, `buildPlansFile` passes `validatePlans`, including a served claim step; `_run.inputs.search_wide` carries budget, used, `budget_hit` and `modes_first_steps` | validation error, or a missing count |

Real-league effects (candidates scored and runtime cold on league 4, whether the
three risk modes pick different first steps, whether a claim reaches the deck)
need the live DB and are listed in the PR under "Needs local measurement".

## Results (GREEN, after the pre-registration above)

Filled in by the GREEN commit.
