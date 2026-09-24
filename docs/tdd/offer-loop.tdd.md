# CLONE-01b b1 — the offer loop

RED `06f3a3c` (test: RED for CLONE-01b b1 offer loop) · GREEN `6436770` (feat: CLONE-01b b1 offer loop) · `test/offer-loop.test.js` 12 cases + 2 route cases in `test/trade-outcomes-route.test.js`.

## What it is

A one-tap **"I sent this"** on any suggested deal writes (or marks) one
`trade_outcomes` row with `sent_at`, carrying the model's P(accept) band. A
settle job, run after every ESPN transaction collection, matches that row to
the `TRADE_PROPOSAL` Nick sent and to ESPN's reply, so each sent offer becomes
a graded row for EVAL E1/E2 and the CLONE-01b b2 clones. The app never sends
an offer.

## Gates (pre-registered before GREEN)

| Gate | Fixture | Pass |
|---|---|---|
| O1 | sent offer; ESPN proposal team 1→2 with the same players, 5 min before the tap; TRADE_ACCEPT 3 h later | `accepted`, `resolved_at` = accept stamp, `matched_tx_id` = proposal |
| O2 | same, TRADE_DECLINE | `declined` |
| O3 | counterparty TRADE_PROPOSAL with `related_tx_id` = ours | `countered`, counter tx in `counter_json` |
| O4 | no matching proposal | `proposed` + reason inside N days; still `proposed` if the collector has not looked since; `expired` once it has looked past N days |
| O4b | TRADE_PROPOSAL/CANCEL on ours, no answer | `expired`, reason "no answer" |
| O5 | settle twice | second run writes nothing, table byte-identical |
| O6 | tap on a suggestion the slate already wrote | that row gains `sent_at`, prediction kept, no duplicate; second tap `already_sent` |
| O6b | deal with no acceptance band | refused, no row |
| O7 | same teams, different players | no match |
| O7b | same players, different counterparty | no match |
| O3b | third team's proposal pointing at ours | not a counter; stays `proposed` |
| O8 | source grep | no `fetch`/ESPN URL in trade-outcomes.js or the `/offers/sent` handler |

## RED

`node --experimental-test-module-mocks --test test/offer-loop.test.js` →
`# pass 0 / # fail 10`: nine `TypeError: recordSentOffer is not a function`, one
`precondition: the /offers/sent route exists`. The failures are the missing
writer and route, not the fixtures.

## Not confirmed

- **Counter vocabulary.** The collector's verified sample (2026-09-15 → 09-17)
  lists PROPOSAL / ACCEPT / DECLINE / VETO and CANCEL; it shows no counter.
  O3 assumes ESPN writes a counter as the counterparty's own TRADE_PROPOSAL
  with `relatedTransactionId` pointing at the original. Unverified on a live row.
- **CANCEL = expired.** ESPN writes the same TRADE_PROPOSAL/CANCEL for a
  withdrawal and an expiry (manager-signals.js:180). Both settle `expired`
  with a reason that says which evidence it was.

## Liveness: mutation sweep

`scratchpad/mutate.sh`: each mutant applied, then `offer-loop` + `trade-outcomes-route` tests run, then the file is restored.
The first sweep left M3 and M4 alive, so O7b and O3b were added; the rerun is below.

| Mutant | Where | Failing tests |
|---|---|---|
| M1 expire by clock, not by collector coverage | unit | 1 |
| M2 drop the player-set compare | unit | 1 |
| M3 drop the counterparty compare | unit | 1 (survived before O7b) |
| M4 accept a counter from any team | unit | 1 (survived before O3b) |
| M5 mark-sent inserts a duplicate | unit | 1 |
| M6 settled rows re-opened | unit | 1 |
| M7 proposer from body only (drop `lg.my_team_id`) | call site, routes/trades.js | 1 |
| M8 no `sent_at` stamp on a new row | unit | 8 |
| C1 surviving control: match window 48 h → 49 h | designed survivor | 0 |
| C2 not-applied control: string absent | designed no-op | 0 (reported NOT-APPLIED) |

## Nick's five questions

1. **Well built?** One writer (`recordSentOffer`) and one settler (`settleSentOffers`) in
   `server/services/trade-outcomes.js`, the file that already holds the ledger. No new table,
   three additive columns (080). No bare catch: a corrupt stored package leaves the row
   pending and the reason names the error.
2. **Stats or made up?** No statistics are computed. Two constants are **guesses**:
   `OFFER_EXPIRE_DAYS = 7` and `OFFER_MATCH_WINDOW_HOURS = 48`.
3. **How we know:** fixtures only. `trade_outcomes` has 0 real rows. Nothing has been backtested.
4. **Pointed anywhere else?** The `/offers/sent` route, the TradeCard button, and the collector's
   post-sync hook (`scripts/collect-league-transactions.mjs`). Nothing reads `sent_at` yet.
   EVAL E1/E2, JEV-01b and CLONE-01b b2 are the planned consumers.
5. **How it unifies:** it lives in the one offer ledger (`trade_outcomes`), sits next to the
   slate's `app_proposed`/`considered_only` rows, and reuses `sidesOf`/`itemsOf`/`ANSWERS`
   rather than a second parse of the ESPN rows.
