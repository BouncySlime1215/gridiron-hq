# NEGOTIATOR-DEFAULTS: how every offer is made (2026-09-24)

ONE-PLAN 4d, night 1. Behind `GRIDIRON_NEGOTIATOR_DEFAULTS=1`, default off (the preview
switch does not turn it on). Flag off, the producer output is byte-identical
(`test/campaign-msg-wire.test.js` "committed producer fixture reproduced byte for byte").

## 0. Audit (extend or build)

- One producer: the playbook stays in `campaign/planner.js#playbookFor`; the ladder is
  still `playbook.js#priceLadder`, and the new `defensibleLadder` post-processes its
  result. The message stays in the playbook's `message` slot; Coach's phraser
  (`messages.js#coachStep`) writes the same firm text when the step carries `negotiation`.
- The "Monday tilt window" is `counterparty-pricing.js#postLossFactor` (a post-loss
  receptiveness boost). Flag on, the adapter passes the layer's existing ablation switch
  `zero: ['recency_post_loss']`, and a loss becomes a cool-off on the send window
  (`negotiator-defaults.js#coolOff`, margin from `manager_signals.last_week_margin`).
- New pure module `server/services/campaign/negotiator-defaults.js`; one new optional contract
  key `steps[].negotiation` (`plans-schema.js`). The no-trade row is #398's (NO-TRADE-SHRINK).

## 1. Tests (RED first)

`test/campaign-negotiator-defaults.test.js` (19 tests) and `test/campaign-negotiator-defaults-adapter.test.js` (3 tests, real adapter), made-up league
`test/fixtures/campaign-league.mjs`, no DB.

RED (commit `e8d311a`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/negotiator-defaults.js'
# tests 1  # pass 0  # fail 1
```

GREEN: 19/19 + 3/3, after adding the flag-gated `negotiation` paths to
`warroom-plans-contract.test.js` PENDING (same pattern as FLIP-LEGS-2).

## 2. Measured (fixture, Balanced + Fuck-it + Safe, flag off -> on; on #398 integration-7)

| metric | off | on | bar |
|---|---|---|---|
| priced steps | 14 | 14 | - |
| priced steps with the 5 always-on levers | 0 | 14 | 100% |
| openings under -5% on his screen | 1 | 0 | - |
| ... of those not marked `defensible: false` | 1 | 0 | 0 |
| openings lifted | 0 | 1 | - |
| steps with a second package (all beat doing nothing on the confirm dice) | 0 | 7 | - |
| outgoing texts with "tweak" or a pressure phrase | 14 | 0 | 0 |
| risk_modes rows with `no_trade` (NO-TRADE-SHRINK's, unchanged by this flag) | 9 | 9 | unchanged |
| entries failing `validateLeague` | 0 | 0 | 0 |
| coach texts failing the grounding checker | 0 | 0 | 0 |
| served move ids / p_yes / title_odds_delta on the fixture adapter | - | identical to off | identical |

The fixture adapter never calls `counterpartyLayer`, so it cannot show P(yes) moving. On the real
adapter it does move with the flag on: `test/campaign-negotiator-defaults-adapter.test.js` shows
receptiveness and P(yes) dropping for a manager who lost last week (no post-loss boost).

## 2b. Review fixes (coordinator batch-B review on #386)

1. Rebased onto #398 (`claude/local-integration-7`); `negotiator-defaults.js#noTradeRow` and its `modes.js`
   import are gone. The no-trade row is NO-TRADE-SHRINK's alone (`modes.js#noTradeRow`, confirm dice).
   Test: "flag: ..." asserts `noTradeRow` is not exported here.
2. No schema or view change for `no_trade` any more.
3. The "Or X for Y" package goes out only if it beats doing nothing on the confirm dice (S2) and passes
   `altWithinCap` (inside the cap, or the planned CAP-1C premium package confirmed on fresh dice); else
   `negotiation.alt_dropped` is `confirm_dice` or `over_cap`. Tests: "a second package that loses on the
   confirm dice is dropped from the offer text" (fails with the confirm check removed: verified),
   "cap rule for the second package ...".
4. P(yes) moves with the flag on (adapter test above); said here and in the PR body.
5. `lastWeekMargins` only reads rows computed within `MARGIN_MAX_AGE_DAYS` (7); the flag reaches the
   planner through `settings.env` and the adapter through its `env` option, never `process.env` inside
   the campaign modules. Test: "the flag in process.env alone does nothing".

## 2b. Batch B (on main decf7ebf)

The "Or X for Y" package now passes what a served plan passes, with no second copy of any gate:
`planner.js#confirmAlt` rebuilds the plan with step i's give swapped (planning dice), then applies
the overpay cap (`altWithinCap`), the held floor (main's `failsHeld`, GETS-FLOOR on), trade memory
(main's `applyTradeMemory`, path-level reversals included) and main's confirm-dice gate
(`priceOnConfirm` + `beatsNoTrade`). Never-give ids and the objectives' untouchables never reach
the ladder (`vals.tradable`, `objUntouch`). `alt_dropped` is one of `ALT_DROP_REASONS`.
Tests: "the second package never offers a never-give player or an objectives untouchable",
"the plan with the second package swapped in is a valid path, holds no player under the floor",
"a second package that would break the path is dropped as path_conflict". The confirm-dice test
fails with the `beatsNoTrade` line removed (verified). The fixture has no case where only the
floor line drops a package, so that line is not mutation-proven.

## 3. Hand-set, not fitted

`ANCHOR_FLOOR_PCT` 5 (messages.js `EVEN_PCT`), `OFFER_HOURS` 48 (`SWITCH_HOURS`),
`COOL_OFF_HOURS` 24, the wording, the pressure-phrase list. 0 graded offers of our own;
external evidence only (ONE-PLAN spot-check row 18).
