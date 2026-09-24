# HIS-SIDE-WIRE: every War Room target says what its owner needs, shops and blocks

ONE-PLAN.md (handoff branch `claude/handoff-package-2026-09-22`), section 5 night 3:
"HIS-SIDE-WIRE: `targets[].his_side` from the 13 counterpart models + pulse +
credibility n + needs + TM-10 `tradeBlock` reader (new, `leagues.payload`)".
Section 4c: "HIS-SIDE-WIRE reads the same ledger [as TRADE-MEMORY]: roster 7 bought
Olave for Chase Brown on 9/17; he sells WRs only for value above 5,705".
Section 4b row 8 names the `manager_signals` n = 0 repair as this unit's too.

Flag: `GRIDIRON_HIS_SIDE=1` serves the field. Default off (shadow): the producer
still builds the read for every target and writes only its counts to
`_run.inputs.his_side`, so it can be measured before anything Nick sees changes.
Preview mode does not switch it on (it serves a new market-value number, the
seller's floor, which is unmeasured).

## Pre-registration (written before the first test)

- Metric: of the top 5 targets on league 4's plan, how many carry a his-side read
  with `status: ok` (at least one of: the counterparty needs read, a chat
  counterpart model, the ESPN trade block, the season's trade ledger).
- Pass bar: 5 of 5 (ONE-PLAN night 3: "`his_side.status ok` 5/5"), and every ok
  read names what the owner needs, shops or blocks, each list with its n.
- What fails it: any top-5 target reading `unknown` while its owner has a read in
  any of the four sources; any `targets[].his_side` served with the flag off; any
  player id in it that is not in the entry's `names`; any manager name in the
  committed fixture.
- Byte check: with the flag off the plans file differs from main's only at
  `_run.inputs.his_side` (the shadow counts). No served number moves.

## Assumed (unit detail the plan does not pin down)

- "13 counterpart models" = the ONE-COUNTERPART model per manager
  (`res.counterpart.models`, people/counterpart.js#publicModel): chat wants,
  untouchable, shopping and his credibility on each (value and n). "Pulse" reaches
  the planner through the same model (PULSE-01 WANT_PLAYER). Without the
  counterpart flag there is no model and the read says "no chat read".
- The TM-10 reader is the one already in `lineup-signals.js` (`tradeBlocks`), moved
  to its own pure module so the adapter and lineup-signals read it once.
  `ON_THE_BLOCK` means shopping. ESPN ids map to planner ids through the sim's
  asset universe; an unmapped id is counted, never guessed.
- The ledger is TRADE-MEMORY's (`res.trade_memory`, PR #379, unmerged): the
  seller's floor on a player he bought this season and his net position currency.
  Until #379 merges the read says "no trade ledger" and the other three sources
  carry the status. No second ledger reader is added here.
