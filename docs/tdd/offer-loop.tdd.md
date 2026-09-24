# CLONE-01b b1 — the offer loop

RED `<this branch's test commit>` · GREEN follows · `test/offer-loop.test.js`, 10 cases.

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
