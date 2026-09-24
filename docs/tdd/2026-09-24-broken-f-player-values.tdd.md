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

test/ux08b-alert-error-no-leak.test.js compiles TradeCard.tsx alone with a hand-kept
import swap list; the new `../lib/playerValues` import gets its swap (the real file,
compiled, as `../lib/errorSanitize` already is). Without it: `Cannot find module
'/tmp/lib/playerValues'` at :138 and :147.

```
```

## 4. Not done here

- League Hub still reads the redraft fc_value; labelled, not re-pointed.
- TradeCard's package "Market value" delta keeps its label (already names the kind).
- No Trade Brain client change: no page renders the clone price yet (#270).

## 5. Commits and liveness

- RED `ab07d97` "test: BROKEN-F RED, three player values named and labelled under preview".
  Against the unfixed tree: `broken-f-player-values.test.js` fails to load
  (`ERR_MODULE_NOT_FOUND ... server/services/player-values.js`), and
  valuation-panel.test.js:309 fails `assert.equal(on.value_kind, 'market_value')`
  with `+ undefined - 'market_value'`. Re-run after the last assertion change.
- GREEN `a1b9886` "fix: BROKEN-F name the three player values and label them on every page (preview)".

Mutation sweep (scratch script; each mutant applied alone, the two BROKEN-F test files re-run, file restored):

| Mutant | Where | Result |
|---|---|---|
| M1 unpriced market → 0 | player-values.js namedPlayerValues | killed |
| M2 switch ignored (always on) | player-values.js namedValuesOn | killed |
| M3 asset cache key drops `:named` | trade-engine.js assetUniverse (call site) | killed |
| M4 asset passes bare `value` instead of the raw row | trade-engine.js asset build (call site) | killed |
| M5 `clone_price` reads `our_value` | trades.js valuationPanel (call site) | killed (survived first; the fixture priced the player at 0 so both fields were 0; the fixture now prices him) |
| M6 League Hub loses its format | leagues.js analysis (call site) | killed |
| M7 deep dive stamped with the wrong kind | trades.js `/player/:id` (call site) | killed |
| M8 TradeLab outlook label reverted | TradeLab.tsx | killed |
| M9 client label table drifts | playerValues.ts | killed |
| C1 designed survivor: preview reason reworded after the `BROKEN-F` prefix | player-values.js | survived (as designed) |
| C2 designed not-applied: absent string | player-values.js | not applied (as designed) |

Not pinned: the findTrades cache-key `:named` suffix (trade-engine.js findTradesKey). The
finder's stamping is at the route and the card players come from the asset universe,
whose key M3 pins. Recorded, not claimed.

## 6. Nick's five questions

1. Well built? One registry (player-values.js), one switch (preview-mode.js), every
   helper a no-op when off; asset and findTrades caches keyed on the switch.
2. Stats or made up? Neither: no number changes. Labels only, plus null in place of a
   defaulted 0 on the named fields.
3. How we know: 9 of 9 mutants killed; the League Hub test asserts the rosters are
   byte-equal with the switch on and off.
4. Pointed anywhere else? The same `value` rides TradeCard, TradeLab and the offer
   routes, all stamped. Preseason VOR is still shown bare on Edge.tsx (unrouted) and
   DraftRoom.tsx (a draft page, not one of this row's three surfaces). Not touched.
5. How it unifies: one field name per meaning (`market_value`, `preseason_vor`,
   `clone_price`) for EA-07 / UI-ENG-4 to read, not a fourth number.
