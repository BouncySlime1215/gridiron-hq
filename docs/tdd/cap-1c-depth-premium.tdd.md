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
- No board, no premium: `boardOf(adapter)` is null on main (the board is #375), so
  the cap stays 0 and the planner result's `no_overpay.depth_premium.reason` says why.

## Review round (coordinator review at `6e789b1`: BLOCK, three findings)

Each finding got a fix and a test that pins it. The tests were written alongside the fixes, not run red on `6e789b1` first:

1. **Confirm world fails, so premium cards were served unchecked.** With no fresh
   dice, a card with a premium step cannot pass its confirm check, so it is now
   dropped and counted in `confirm_failed`. Test: `the confirm world failing serves
   no premium card`.
2. **The opening or walk-away could be a different, ungated premium pair.** Above 0%,
   the price ladder now offers only the planned premium package, which is the one
   pair gated on points and title odds. Test: `above 0%, the opening and walk-away
   are only the planned premium pair`.
3. **An empty or unscored board failed open.** The board is now `adapter.board`
   (id -> score). An empty or all-unscored board counts as no board. A given player
   is depth only with an explicit score below 83, and 160, 80 and 277 are never
   depth. Tests: `board: ... fails closed`, `depth: an explicit score below 83 ...`,
   `an empty board or an unscored give never rides the premium`.

Minors taken: objectives-file untouchables join the depth check, and backups never
propose a premium step that did not pass its own fresh-dice check.

## On by default (Nick, 2026-09-25: hard rules are filters, never behind an off-by-default flag)

#375 (the board) is now on main, merged into this branch. The cap (0) and the premium
(+12%) had no flag already. The one thing still off by default was the premium's input:
the adapter built scores only when `GRIDIRON_PLAYER_SCORE` was on. Now
`blueChipBoard` scores the same universe against the same draft whatever that flag
says. The display flag still decides only what is served and protected, and the depth
check reads `adapter.board` on every run.

Fail-closed additions: a given player is depth only below 80 (`DEPTH_BELOW`; the board
labels 80+ "Blue chip" and protects Nick's 80+), and with no draft on file the adapter
serves no scores, because production-only scores top out near 50 and would read every
player as depth.

Tests: `default: no flag, no setting -> cap 0, premium +12% ...`, `adapter: the display
flag off still scores every player ...`, `adapter: no draft on file -> no scores ...`.
