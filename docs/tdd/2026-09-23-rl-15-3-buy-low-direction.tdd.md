# RL-15-3: "Buy Low" deal tag reads role-change direction (TM-01 / TM-03, C-18)

## Audit (before the first test): extend, not build

- Producer of the direction: `detectRoleChange()` in `server/services/role-changepoint.js:12-44` returns `null` or an object whose `status` is `'confirmed_role_increase'` or `'confirmed_role_decrease'` (line 32). It is the single producer; `roleChangepoints()` (line 47) maps it per player and `player-week-engine.js:276,305` attaches it as `player_week_engine.role_change`, which `trade-engine.js:519` copies onto each asset and `slim()` (line 1499) carries onto the deal card.
- Consumer with the defect: `tagDeal()` in `server/services/trade-engine.js:1512` tested `get.some(p => p.role_change)`, i.e. truthiness. A confirmed role DECREASE is a truthy object, so a player losing usage was labelled "Buy Low" on the Trade Machine card (`client/src/components/TradeCard.tsx:217`, renders `deal.tags` verbatim).
- No second producer of a role-direction tag exists: `grep -rn "Buy Low\|Role Rising\|Role Shrinking"` over the tree (origin/main 24fdf434) returns only `trade-engine.js:1535`.
- Decision: extend `tagDeal()` in place (plus the `export` keyword on its declaration so it can be unit-tested). No new table, column or number; the change only re-labels an existing field, so the unit is not statistical (no pre-registration, no holdout look).

## RED

`70b7b223 test: RED tagDeal labels a confirmed role decrease Buy Low` (also adds the `export` keyword on `tagDeal`, behaviour-neutral). Command: `SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/trade-tag-role-direction.test.js` on 70b7b223: pass 2, fail 3.

- `not ok 2 - confirmed_role_decrease is never "Buy Low" and carries a caution tag`: `got ["Buy Low"]`
- `not ok 3 - confirmed_role_increase is "Role Rising", not "Buy Low"`: `got ["Buy Low"]`
- `not ok 4 - the caution survives the two-tag cap`: `got ["Blockbuster","Youth Play"]`

Liveness re-run after the assertions were tightened (e4b50da2 tests against the 70b7b223 trade-engine.js): pass 2, fail 4 (tests 2, 3, 4 and the call-site scan 6).

## GREEN

`f2156f5b fix: GREEN tagDeal reads role_change direction, decrease is a caution`, then `e4b50da2 test: pin exact role tags and the tagDeal call site (kills M1, M6)`. Same command on e4b50da2 and again after merging origin/main (2e5f280a), together with `test/hype-one-producer.test.js` (which scans the same tag strings): pass 14, fail 0.

## What it does

`tagDeal()` (server/services/trade-engine.js, the one change is inside the function plus `export` on its declaration) now reads `role_change.status`:
- `confirmed_role_increase` on a player you GET -> tag **Role Rising** (usage up; named for what it measures, not a price read, same reasoning as the earlier 'Sell High' -> 'Sell the Veteran' rename).
- `confirmed_role_decrease` on a player you GET -> tag **Role Shrinking**, placed first so the existing two-tag cap (`slice(0, 2)`) cannot drop the caution.
- "Buy Low" is no longer emitted anywhere. Give-side role changes add no tag (unchanged behaviour).
Renderer `client/src/components/TradeCard.tsx:217` prints `deal.tags` verbatim; no client change. Consumer: `tags: tagDeal(give, get, ev)` in the trade search result (trade-engine.js, deal object built in the search loop, ~line 1983 on this branch) served to the Trade Machine cards.

## Mutation test (tests at e4b50da2, same command)

| Mutant | Result |
|---|---|
| M1 read truthiness again (`p.role_change`) | killed (fail 2) |
| M2 caution pushed instead of unshifted | killed (fail 1) |
| M3 caution line deleted | killed (fail 2) |
| M4 directions swapped | killed (fail 3) |
| M5 rising renamed back to 'Buy Low' | killed (fail 2) |
| M6 call site `tags: []` | killed (fail 1, structural scan) |
| M7 designed survivor: filter give+get back down to get (equivalent) | survived (fail 0), as designed |
| M8 not-applied control (pattern absent) | NOT APPLIED, file unchanged |

Before tightening, M1 and M6 survived (fail 0 each); that is why e4b50da2 switched to exact `deepEqual` tags and added the call-site scan.

## Numbers

None. No model number, no DB read, no holdout look (not a statistical unit; no local DB copy was made).

## Known defects / follow-ups

- The call-site test is a source scan, not a route-level run: a full league fixture for the trade search is out of scope. Guess: acceptable because the call site is one line and M6 is killed.
- "Role Rising" is not a price claim; whether a rising-role player is actually cheap is the hype producer's job (services/hype.js#playerHype, S-19) and is not wired into tags here. Overlaps queued B-15.
- TradeCard renders the caution in the same accent pill style as positive tags; a caution tone is a UI follow-up (renderer was scoped "no change expected").
- Needs independent audit (trade-recommendation surface), per the queue row.

## Nick's five questions

1. Well built? One field read by status value instead of truthiness, inside one function; 6 tests, 6 of 6 non-equivalent mutants killed.
2. Stats or made up? Neither: it is a labelling fix. The direction comes from detectRoleChange's existing thresholds (role-changepoint.js:18-30), not changed here.
3. How we know: unit tests + mutation table above. No backtest; none applies (no number changes).
4. Pointed anywhere else? `deal.tags` -> TradeCard pills on the Trade Machine. No other reader of the tag strings (grep for 'Buy Low' / 'Role Rising' / 'Role Shrinking' over server, client/src, test).
5. How it unifies: the tag now agrees with the one role-change producer (detectRoleChange.status) that the weekly engine and model-signal-quality.js:81 already read; there is no second direction producer.
