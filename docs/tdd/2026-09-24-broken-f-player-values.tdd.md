# BROKEN-F: three player values, named and labelled

BROKEN-NUMBERS row F: "finder vs League Hub vs Trade Brain — three different player
values, unlabeled. Cause: FantasyCalc value, preseason VOR (routes/edge.js:50), clone
price. Fix: three named fields; pages label which."

Base: origin/main `21c9da4`. Not stacked on EA-07 (#269) or the engine spine (#216):
naming and labelling a value needs neither the one world nor engine_state.

## 1. What each surface actually shows (audit, before the first test)

| Surface | Number on screen | Which value | Served from (main) |
|---|---|---|---|
| Trade finder card (TradeCard.tsx:86 pill tooltip, :122 "Market value" delta) | `value` | FantasyCalc, this league's format | trade-engine.js:471 `value: m?.value ?? 0` |
| Trade Lab target lists (TradeLab.tsx:685, :810), mock roster (:1064) | bare `value`, no label | FantasyCalc, this league's format | routes/trades.js:908 via `/rosters` |
| Trade Lab outlook (TradeLab.tsx:892 "Market") | `value` | FantasyCalc, this league's format | trade-engine.js playerOutlook via `/player/:id` |
| League Hub roster analysis (Leagues.tsx:194) | starter value vs league average | **FantasyCalc REDRAFT, first league's format** | leagues.js:281 `fc_value`, written by aggregates.js:104 `... FROM leagues ORDER BY id LIMIT 1` |
| Trade Brain / deep-dive valuation panel | `their_value` | clone price = market × manager multiplier | trades.js:1011, counterparty-pricing.js:880 |
| Every finder asset | `vor` | preseason VOR | trade-engine.js:469 from edge.js:50 `vorBoard` |

Finding beyond the row: League Hub's "FantasyCalc value" is not the finder's. It is the
redraft price fetched once in the first league's format, so for any other league (or a
dynasty/superflex one) the two pages print different FantasyCalc numbers for one player.
This unit labels it as that; re-pointing League Hub at `currentMarket(formatKey)` would
change its numbers and is left as a follow-up row.

Clone price has no client reader on main (no file reads `valuation_map`); UI-ENG-4
(#270) is the clone view. The served field is named here so that page labels it.

## 2. RED

`test/broken-f-player-values.test.js` (new) and one case appended to
`test/valuation-panel.test.js`. Run with the implementation removed
(server changes stashed, player-values.js moved away):

```
not ok 1 - test/broken-f-player-values.test.js     (ERR_MODULE_NOT_FOUND: server/services/player-values.js)
not ok 6 - BROKEN-F: under preview the deep dive names its market value and the panel its clone price  (AssertionError)
# pass 4
# fail 2
```

## 3. GREEN

`server/services/player-values.js`: `PLAYER_VALUE_FIELDS` (market_value, preseason_vor,
clone_price with label/short/scale/basis), `namedPlayerValues` (from the raw rows, so an
unpriced player is `null`, not the bare field's 0), `valueLabelBlock` / `stampValueKind`
(response-level `value_kind`, `value_label`, `value_format`, `value_fields`, preview
fields), `carryNamedValues` (onto slimmed card players).

Behind `preview-mode.js#previewUnconfirmed()`: switch off, every helper returns `{}` or
its input unchanged, so no response changes shape. The asset and findTrades cache keys
carry `:named` when on, so flipping the switch never serves the other shape.

Client: `client/src/lib/playerValues.ts` (label table mirrored from the server, held in
step by a test); TradeCard pill tooltip, TradeLab target lists ×2, outlook, mock roster
and League Hub caption read their label through it. Off: existing wording.

```
node --test test/broken-f-player-values.test.js test/valuation-panel.test.js
# pass 12
# fail 0
```

## 4. Not done here

- League Hub still reads the redraft fc_value; labelled, not re-pointed.
- TradeCard's package "Market value" delta keeps its label (already names the kind).
- No Trade Brain client change: no page renders the clone price yet (#270).
