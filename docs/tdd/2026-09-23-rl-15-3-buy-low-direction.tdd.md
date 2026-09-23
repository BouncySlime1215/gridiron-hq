# RL-15-3: "Buy Low" deal tag reads role-change direction (TM-01 / TM-03, C-18)

## Audit (before the first test): extend, not build

- Producer of the direction: `detectRoleChange()` in `server/services/role-changepoint.js:12-44` returns `null` or an object whose `status` is `'confirmed_role_increase'` or `'confirmed_role_decrease'` (line 32). It is the single producer; `roleChangepoints()` (line 47) maps it per player and `player-week-engine.js:276,305` attaches it as `player_week_engine.role_change`, which `trade-engine.js:519` copies onto each asset and `slim()` (line 1499) carries onto the deal card.
- Consumer with the defect: `tagDeal()` in `server/services/trade-engine.js:1512` tested `get.some(p => p.role_change)`, i.e. truthiness. A confirmed role DECREASE is a truthy object, so a player losing usage was labelled "Buy Low" on the Trade Machine card (`client/src/components/TradeCard.tsx:217`, renders `deal.tags` verbatim).
- No second producer of a role-direction tag exists: `grep -rn "Buy Low\|Role Rising\|Role Shrinking"` over the tree (origin/main 24fdf434) returns only `trade-engine.js:1535`.
- Decision: extend `tagDeal()` in place (plus the `export` keyword on its declaration so it can be unit-tested). No new table, column or number; the change only re-labels an existing field, so the unit is not statistical (no pre-registration, no holdout look).
