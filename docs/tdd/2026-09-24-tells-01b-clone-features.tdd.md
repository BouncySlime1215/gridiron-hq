# TELLS-01b: tells as named clone features, graded by E1, shown as a tells card

RED `4d4b774` · GREEN follows · stacked on PR #246 (`claude/cloud-e1-fix-pvd8q8`, itself on #235).

`test/tells-clone-features.test.js` (14, new). RED run: the file fails to load
(`ERR_MODULE_NOT_FOUND` for `server/services/tells/clone-features.js`), so all 14 fail.
GREEN: 14 of 14.

## What was built

| piece | file |
|---|---|
| four named features, each as of an offer's proposal time | `server/services/tells/clone-features.js` `featuresAsOf` |
| walk-forward L2-penalised logistic fit on top of E1's activity-only baseline, weights capped at 1.5 | `fitWeights`, `cloneScores` |
| E1 grade of the clone and of today's replayed band on the same league offers | `gradeClone` (calls `eval/e1.js#grade`) |
| per-manager card: value, n, weight, direction, E1 evidence, reason chain | `tellsCard` |
| flagged response (`GRIDIRON_TELLS_CARD=1` or `previewUnconfirmed()`) | `server/services/tells/card.js`, `GET /api/tells/:leagueId/card` |
| Trade Brain card above the manager board, renders nothing when off | `client/src/components/brain/TellsCard.tsx` |
| read-only aggregate report for the local DB | `scripts/eval/tells-clone-e1.mjs` |

## What each test pins

| test | pins |
|---|---|
| reply_latency | responder median vs league median at the cut; under 2 replies is missing (0 in the model) |
| counter_style | a proposal back within 72 h of a decline counts, one after 72 h does not; a `countered` status counts |
| prior_accept_price | offer ratio minus accepted ratio shrunk by n/(n+2); a price captured after the proposal day is not used |
| chat_wants_player | graded:false, never in the fit; a mention after the offer is ignored; the reason says "not dated" |
| as-of safety | an offer resolved, or a proposal made, 1 s after the cut changes no feature |
| fitWeights | under 20 offers: zeros plus a reason; above: the penalty shrinks the weight, the cap holds |
| walk-forward | flipping the answers of later offers leaves every earlier p unchanged |
| gradeClone | E1-shaped rows, target league only; with no usable tell the clone equals activity-only (gain 0) |
| card | every entry has n, predicts, as_of and the E1 status; unknown is `value: null` with a reason |
| card chat | unproven, weight null, player names and n shown |
| loader | offers and proposal items read; absent value/chat/player tables are listed, not thrown |
| flag | off without the switch (no card in the body); on in preview mode, labelled a preview |
| guard | trade-acceptance.js, counterparty-pricing.js, trade-engine.js never import the tells files |
| guard | the tells files carry no league or manager names |
