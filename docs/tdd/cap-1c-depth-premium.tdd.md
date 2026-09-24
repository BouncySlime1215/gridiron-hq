# CAP-1C: up to +12% on a depth-only 2-for-1, only when the lineup and title odds rise

RED `9f426a8` · GREEN follows · `test/campaign-cap-1c.test.js`, 14 cases.

## The decision

Nick's decision 1(c), 2026-09-24: the overpay cap stays 0 by default. A depth-only
2-for-1 consolidation (two of his players for one, no blue chip in the give) may give
up to +12% FantasyCalc market value. It is served only if his weekly starting-lineup
points AND his title odds rise on paired dice, and still rise on the fresh-dice
confirm pass.

## RED

12 of 14 failed: `DEPTH_PREMIUM_MAX`, `depthPremiumOf`, `blueChipsOf`,
`depthOnlyTwoForOne`, `newPremiumSink` and `premiumHolds` did not exist, and the
planner planned no step above the 0 cap. The two that passed are the checks that the
premium stays off (premium set to 0, walk-away never past the planned premium), which
hold on main trivially because no premium exists there.

Two fixture mistakes were fixed while going GREEN, both in the test's own tiny world,
not in the rule: pairs with player 18 were even or under-give trades (the plain cap's
business, so the helper now counts only plans that give more than they get), and
12 + 15 = +5% is a legitimate premium the first draft forgot to expect.

## GREEN

- `search.js`: a step past the cap is kept only when it is a depth-only 2-for-1 within
  `max(max_overpay, depth_premium)`; its exact rescore keeps it only if the step's own
  `points_delta` and `title_delta` are both > 0 (`premiumHolds`). Gated-out plans are
  counted by reason.
- `planner.js`: the confirm pass re-checks every premium step on the fresh seed and
  drops the card if either number falls (`confirm_failed`). The walk-away may reach a
  depth-only 2-for-1 only up to the planned step's own premium.
- No board, no premium: `blueChipsOf(adapter)` is null on main (the board is #375), so
  the cap stays 0 and `_run.inputs.depth_premium.reason` says why.
