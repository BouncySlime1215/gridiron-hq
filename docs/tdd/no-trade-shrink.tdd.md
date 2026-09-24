# TDD evidence: a "no trade" row in every risk mode, and shadow pre-rank shrinkage

**Branch** `claude/cloud-no-trade-shrink`. RED then GREEN, in that order, in
`test/campaign-no-trade-shrink.test.js`, `server/services/campaign/modes.js`,
`planner.js`, `view.js`, `plans-schema.js` and `client/src/components/warroom/types.ts`.

Unit: NO-TRADE-SHRINK (ONE-PLAN section 4d, nights 1-2; spot-check row 6: "no
shrinkage BEFORE ranking; no explicit do-nothing option in planner/modes (grep 0
hits)").

## Pre-registration

- **Metric 1 (no-trade row):** every `risk_modes` row carries `no_trade`
  (`expected` 0, `p_complete` 1) and a `pick` of `plan` or `no_trade` from the
  mode's own objective: `plan` only when the mode's best plan scores above 0.
- **Metric 2 (shrinkage, shadow):** the empirical-Bayes shrinkage toward the
  no-trade gain is computed for every mode and reported under `_run.shrink`
  with `status: 'shadow'`; on a constructed pool a noisy winner (0.020 at SE
  0.02) drops below a precise runner-up (0.015 at SE 0.002) in the shadow.
- **Pass bar:** 6/6 tests green; the fixture league's plans entry (all three
  modes) is byte-identical to `main` once `risk_modes[].no_trade` and
  `_run.shrink` are removed; schema validates.
- **Fails it:** any served number, order, deck card or text changes; the shadow
  does not reorder the constructed case; `validateLeague` reports an error.

## RED

Commit `00e9ba4`: the test file alone. `node --test test/campaign-no-trade-shrink.test.js`
-> `# pass 0 / # fail 6` (the exports `NO_TRADE`, `shrinkPrior`, `shrinkExpected`,
`shadowShrink` do not exist; `compareModes` rows have no `no_trade`).

## GREEN

- `modes.js`: `NO_TRADE`, `noTradeRow(best)`, `compareModes` rows carry
  `no_trade`; `shrinkPrior` (tau^2 = max(0, mean(e^2) - mean(se^2)), prior mean
  0 = no trade), `shrinkFactor`, `shrinkExpected`, `shadowShrink`.
- `planner.js`: `res.shrink = shadowShrink(plans, ctxFor)`; nothing reads it.
- `view.js` / `plans-schema.js`: `risk_modes[].no_trade` (optional) and
  `_run.shrink` (optional json) in the contract.

`node --test test/campaign-no-trade-shrink.test.js` -> `# pass 6 / # fail 0`.

One test was corrected between RED and GREEN: it called `toEntry(res, { names: {} })`,
which the contract rejects for every player id; the producer tests pass
`a.names()`. The assertion (entry validates) is unchanged.

## Served bytes

Fixture league (test/fixtures/campaign-league.mjs), all three modes, `toEntry`
without `runtime_ms` / `phases_ms`:

- `main` (`155d9f4`): sha1 `57131b86da3b1fff7e8a38b9b3871f840465c79a`
- this branch, with the two new keys stripped: sha1 `57131b86da3b1fff7e8a38b9b3871f840465c79a` (identical)

Fixture reading: safe best plan expected +0.0067 but scores <= 0 after its
spread penalty -> `pick: no_trade`; balanced and all-in -> `plan`. Shadow:
tau^2 0.00396 over 87 plans, no reorder in any mode on this fixture.
