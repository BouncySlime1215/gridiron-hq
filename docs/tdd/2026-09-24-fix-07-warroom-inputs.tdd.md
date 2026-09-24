# FIX-07: War Room inputs reach the producer; one "I sent it" store

RED `06ebca3a` (test: FIX-07 War Room requests reach the producer, one sent-offer store (RED)) · GREEN `e91124e3` (feat: FIX-07 War Room inputs reach the producer; one "I sent it" store) · built on an integration base (merge commits)
of #233, #230, #231, #239, #243, #255 (FIX-01, on #174), FIX-09
(`claude/eval-seams-migration-4wf4ek`, on #246/#235) and #238. None of them is
on `main` yet; the merge train rebases this branch's own commits onto them and
drops the merge commits.

`test/fix-07-warroom-inputs.test.js` (13, new). RED: the file fails at import,
`ERR_MODULE_NOT_FOUND server/services/campaign/requests.js` (no fold, no card
lookup, no War Room log). GREEN: 13 of 13.

## Gates

| gate | pins |
|---|---|
| G1 | a `mode.set` request makes the next run's `destination.risk_mode` `all_in` (baseline `balanced` on the same fixture), `consumed_at` is stamped by `consumeWith` with the plans write, and the mode holds on the run after (objective state = fold of every non-retracted request) |
| G2 | a plans write that throws stamps nothing and leaves no open transaction |
| G3 / G3b / G3c | a retracted request is ignored and the one before it stands; a Coach plan change with `confirmed = 0` written around the route is ignored; objective / tolerance / stop add + remove fold in id order |
| G4 | `deck.skip` stores its card; "manager" down-weights the partner, "costs too much" the players the card gets |
| G5 / G5b | War Room "I sent it" -> exactly one `trade_outcomes` row: `sent_at`, `source 'app_proposed'`, band = the card's `p_yes_band` with `p_yes` as midpoint, `move_id`, `price_band 'at_point'`, ESPN ids on the players; a second tap returns `already_sent` and writes neither a second outcome nor a second request; the opening sent is `'below'` |
| G6 | a card without `p_yes_band`, or with a band that excludes its `p_yes`, records no outcome row, and the response names why; the request is still kept |
| G7 | retracting "I sent it" inside the undo window sets `sent_at` back to NULL and writes no campaign step |
| G8 | the fatigue cap counts `trade_outcomes WHERE sent_at IS NOT NULL` (TradeCard and War Room taps) within 7 days, and a tapped offer ESPN also shows (`matched_tx_id`) once |
| G9 | consuming an "I sent it" writes E5's `campaign_steps` predicted row (gain + SE from the card), once per (league, move, step) |
| G10 | the shown next move goes to `follow_ledger` (kind `next_move`, action `trade`) once across re-renders; the `war_room` serve-log surface serves p_yes, title_odds_delta, title_after per move and title_now; with no plans file both logs say why |

## Also changed on the integration base

`test/eval-seams.test.js` (FIX-09) assumed 080/082 were absent: its first test
asserted E1/E2/E6 name the missing sibling tables, and its third ALTERed
`sent_at` onto `trade_outcomes`. On a tree that carries #239/#245 both failed
without any FIX-07 change (`duplicate column name: sent_at`). The test now
checks which siblings are present and asserts the "missing" reasons only when
they are.

`test/brain-report-store.test.js` (FIX-09) had the same assumption: E2's
reason on an empty DB is "trade_outcomes lacks column(s) sent_at" only before
080; on this tree it is "needs 10 more offers". The assertion now branches on
the column. Full `npm test` on tree `567e05f4` (before this patch): 5065 tests,
5022 pass, 1 fail (this one), 42 skipped; after it the file is 7 of 7.

## Liveness: mutation sweep

Each mutant applied alone to the GREEN tree, `test/fix-07-warroom-inputs.test.js` run.

| mutant | where | result |
|---|---|---|
| M1 retracted rows folded anyway | requests.js#foldRequests | killed (G3, G7) |
| M2 COMMIT before the plans write | requests.js#consumeWith | killed (G2) |
| M3 card sent -> 'above' | cards.js#PRICE_BAND_OF | killed (G5) |
| M4 matched sent row counted twice | league-adapter.mjs#sentThisWeek | killed (G8) |
| M5 second tap falls through to insert | store.js#recordRequest | killed (G5, G9) |
| M6 unconfirmed Coach row followed | requests.js#foldRequests | killed (G3b) |
| M7 next move not logged | war-room-log.js#logWarRoomShown | killed (G10) |
| M8 band check skipped | cards.js#sentDeal | killed (G6) |
| M9 mode.set not folded | requests.js#foldRequests | killed (G1, G3) |
| M10 call-site query reads `sent_at IS NULL` | league-adapter.mjs#sentThisWeek | killed (G8) |
| C1 control: comment text edited | requests.js | survived (designed) |
| C2 control: `objective.risk_mode = p.modeX;` (absent from the file) | requests.js | reported NOT APPLIED, not run (designed) |

Standing gaps (no test drives these call sites): `produce-plans.mjs#main`
calling `leagueInputs` / `consumeWith` (main needs the full sim), the WR-3
route passing `plans` into `recordRequest`, and the `/war-room` route calling
`logWarRoomShown`. Each is one line; FIX-11's league-4 smoke exercises all three.
