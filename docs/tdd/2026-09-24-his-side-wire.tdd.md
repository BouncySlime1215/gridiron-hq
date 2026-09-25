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

## RED

`test/campaign-his-side.test.js`, commit `1d7062b`: 11 tests, all failing on
`ERR_MODULE_NOT_FOUND` (`server/services/campaign/his-side.js` did not exist).

## What changed (GREEN)

- `server/services/campaign/his-side.js` (new, pure): the flag (`hisSideOn`), the
  ESPN block mapper (`tradeBlockRead`: ON_THE_BLOCK only, ESPN id -> planner id,
  unmapped counted), the per-target read (`hisSide`) and the shadow summary
  (`hisSideSummary`).
- `server/services/espn-trade-block.js` (new): `tradeBlocks` moved verbatim out of
  `lineup-signals.js`, which now imports it. One reader of `teams[].tradeBlock`.
- `scripts/campaign/league-adapter.mjs`: `adapter.tradeBlock` from the league
  payload; ESPN ids through the sim's asset universe (espn_id 0 skipped: 4b row 5).
- `planner.js`: `res.trade_block` passes the adapter's read through (one line).
- `view.js#toEntry`: every target gets its read; with `his_side_on` it is served as
  `targets[].his_side` (source `plan.template`) and the reasoning slot `his_side`
  reads its text. Off, the reasoning text is the old sentence. Either way the
  per-target status goes to `_run.inputs.his_side`.
- `plans-schema.js`: `targets[].his_side` optional, typed.
- `produce-plans.mjs#buildPlansFile`: `his_side_on: hisSideOn(env)`.
- `test/warroom-plans-contract.test.js`: the his_side paths join PENDING (flag-off
  fixture, as FLIP-LEGS-2's are). The regenerated fixture differs from main only by
  four `_run.inputs.his_side` blocks (additions only).

## Not done: the manager_signals n = 0 repair (4b row 8)

The rows with `value = 0, n = 0` are count metrics (`tx_waiver_moves`,
`tx_proposals_sent`, `tx_offers_received`, `tx_decisions_made`, `tx_veto_votes`),
where `n` is the count itself, so 0 is a measured count, not a missing read.
`manager-signals.js#activitySignals` says so on purpose ("the inactive manager is
the signal ... emitted only when the league has transaction rows at all"). The
pricing path reads `tx_adds_per_week` (n = weeks) and `tx_completed_trades`
(n = weeks), not those counts (`counterparty-pricing.js:532-555`). Writing NULL
would turn "did nothing" into "unknown" and move P(yes). Left for Nick to rule on.
