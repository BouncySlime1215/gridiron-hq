# TDD evidence: TRADE-MEMORY, the planner remembers this season's trades

ONE-PLAN section 4c (night 1). Branch `claude/cloud-trade-memory-egq3cy`, cut
from `origin/main` at `155d9f4` (#373). Draft PR #379.

| sha | subject |
|---|---|
| `eb4ca19` | test: TRADE-MEMORY red - sold players, buy-backs, floors, reversals |
| (GREEN) | feat: TRADE-MEMORY - the planner remembers this season's trades |

## 1. Pre-registration (in the PR body before any implementation)

- Metric: on made-up fixtures, (1) targets and cards that get a player Nick
  sold inside the window; (2) served steps that undo a Nick-counterparty trade;
  (3) `_run.dropped_by_reason.trade_memory`.
- Pass bar: (1) = 0 and (2) = 0 with a ledger; plans unchanged with no ledger;
  the `_run` count equals the planner's count and is >= 1; buy-back text when
  the price fell 10%+; the plans file validates.
- Would fail it: any card getting the sold player, any served reversal, any
  change with no ledger, the floor moving a card with its flag off.

## 2. RED

`eb4ca19`: `test/campaign-trade-memory.test.js` fails at import
(`ERR_MODULE_NOT_FOUND: .../campaign/trade-memory.js`), 0 pass / 1 fail.

## 3. GREEN

- `server/services/campaign/trade-memory.js` (new, pure): `executedTrades`
  (rows to trades), `tradeMemory` (sold, floors, currency, Nick's trades by
  counterparty), `stepMemory`, `applyTradeMemory`, `memorySummary`.
- `planner.js`: builds the memory when `adapter.tradeLedger` is present; a sold
  player is refused as a target and as a flip buy; candidate plans go through
  `applyTradeMemory` before ranking; `trade_memory` is returned.
- `view.js` / `plans-schema.js`: `move.buy_back` (optional) and
  `_run.dropped_by_reason.trade_memory` + `_run.trade_memory` (optional).
- `league-adapter.mjs#tradeLedger`: executed `TRADE_ACCEPT` rows for the
  league and season; the price on a trade day is the last
  `dynasty_value_history` capture on or before it, in this league's format.
- The producer fixture gains league 8 (made-up ledger). Leagues 1-5 are
  byte-identical apart from the two new `_run` keys and `attention.of` 5 -> 6.

One test was wrong and was corrected, not the code: the RED test expected
`wrong_currency: 1` in the `applyTradeMemory` case, but the third plan gives a
TE to roster 3, who sold his TE this season, so 2 is right.

## 4. Results

`test/campaign-trade-memory.test.js`: 13 pass, 0 fail. Full suite, lint,
typecheck and `check:wiring`: see the PR body.
