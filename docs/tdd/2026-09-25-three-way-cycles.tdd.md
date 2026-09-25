# THREE-WAY CYCLES (Batch D item 21): shadow

RED `103f1800` · GREEN follows · `test/campaign-three-way.test.js`, 10 cases.

## RED

`node --test test/campaign-three-way.test.js` before the module existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/three-way.js'
```

## GREEN

`server/services/campaign/three-way.js` (new), wired in `planner.js` (the `three_way` block,
flag-gated) and `scripts/campaign/produce-plans.mjs` (`_run.inputs.three_way`).
10 of 10 pass.

## What the tests pin

- Flag `GRIDIRON_THREE_WAY`: only `shadow` / `1` search; off writes no key; shadow leaves every
  served field (targets, best, deck, suggestions, catch-up, risk modes, flip map) byte-identical.
- A cycle is two linked trades with two different partners; what leg 1 brings in is what leg 2
  hands on; joint P = p1 x p2; expected = joint P x title gain (pre-agreed, no stranded leg).
- Nick's rules on every leg and on the holding between legs: never give 160 / 80 / 277 or an
  objective untouchable; never get 290; no sold player back; trade memory per leg; the Blue chip
  floor on the final get and on the player held between legs (unscored fails closed); no overpay
  (cap 0 even when the adapter is uncapped); both legs fair on the partner's screen. A 25-seed fuzz
  runs every served leg through never-give.js `ruleVerdict`.
- Bilateral first: the search is skipped when a single trade is served, and fails closed when
  the trade ledger is missing.
- On the fixture league the balanced deck is all two-step chains, the cycle search runs, finds 11
  cycles, 9 not already scored by the chained search, and the top one has expected +0.0084 title
  odds pre-agreed vs -0.0015 sent one leg after the other.
