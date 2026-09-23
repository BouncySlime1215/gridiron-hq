# FC-SNAP: FantasyCalc values refresh daily, keep their history, and say how old they are

Unit FC-SNAP = RL-3-1 + RL-4-3 (plan items C12 FantasyCalc disagreement test, S-10 one value store,
TM-09 / AI-04 market price, F3 freshness). R&D packages: `rnd/loop/r3-external-fantasycalc-history-gap.md`,
`rnd/loop/r4-internal-trade-market-price-frozen.md` (both outside the repo).

Tree for every "before" figure below: origin/main `89f69b3b`.

## 1. Audit: what exists, extend or build

| Surface | What is on main (`89f69b3b`) | Command | Decision |
|---|---|---|---|
| Current value store | `dynasty_values` (PK `format_key, player_id`, `server/db/schema/core-and-fantasy.js:205`), written only by `syncDynastyValues` (`server/routes/aggregates.js:130`), upsert at `:149-155` | `git grep -n syncDynastyValues origin/main -- server client scripts` → aggregates.js:130/191/319, leagues.js:220-221, a comment in dynasty-age-curve.js | **Extend**: same writer, same fetch, no second producer |
| Value history | none | `git grep -il dynasty_value_history origin/main \| wc -l` → 0 (control: `dynasty_values` → 27 files) | **Build**: `dynasty_value_history`, written in the same loop as the upsert |
| Timer | none; three manual callers only (league sync button, `/aggregates/sync`, `/aggregates/refresh-all`). `fantasycalc_dynasty` sits in `MANUAL_SOURCES` (`server/services/source-registry.js:178-184`) with a declared daily cadence nothing enforces | `git grep -n -i "fantasycalc\|syncDynasty" origin/main -- server/services/scheduler.js \| wc -l` → 0 (control: `syncSleeper` → 4) | **Build**: daily `fantasycalc_dynasty` job beside `sleeper_players`; move the source from `MANUAL_SOURCES` to `JOBS` (allSources() does not dedupe) |
| Join | Sleeper id, then name key; FantasyCalc's `espnId` never read | `git grep -n espnId origin/main -- server/routes/aggregates.js \| wc -l` → 0 (control: `sleeperId` → 4) | **Extend**: ESPN id, then Sleeper id, then name |
| Rows FantasyCalc stops returning | kept at their old price forever | `git grep -n "retired_at\|in_latest_pull" origin/main -- server \| grep -i dynasty \| wc -l` → 0 | **Build**: additive `dynasty_values.retired_at`; readers skip retired rows. Values are kept, not nulled or deleted |
| Freshness | `FALLBACK_REGISTRY` (the live registry: source-registry.js exports no `servedTables()`) covers `player_week_usage` only | `git grep -n dynasty_values origin/main -- server/services/data-freshness.js \| wc -l` → 0 (control: `player_week_usage` → 3) | **Extend**: second entry, `dynasty_values`, stale after 24 h, matching source-registry.js:182 |
| Asset cache stamp | `{ table: 'dynasty_values', stamp: 'player_id' }` (`server/services/trade-engine.js:204`): an in-place re-sync keeps the row count and the max player id, so the trade cache never sees new prices | read of `compute-cache.js:48-69` (`COUNT(*)` + `MAX(stamp)`) | **Fix**: stamp `fetched_at` (found in this audit; a daily sync makes it bite every day) |
| Attribution | the client names FantasyCalc 5 times and links it 0 times; FantasyCalc's terms ask for a visible link to FantasyCalc.com | `git grep -n -i fantasycalc.com origin/main -- client \| wc -l` → 0 (control: `fantasycalc` → 5) | **Extend** F-08's `DataCredit` line (on every page) plus the Trade Lab "market as of" line |
| Second producer of the same concept | `player_metrics.fc_value` from `syncFantasyCalc` (`aggregates.js:88-122`), one global redraft set priced off the first league's shape, read by leagues.js:262, rankings.js, nfldata.js, players.js, edge.js | `git grep -n "fc_value" origin/main -- server` | **Named, not unified here**: that is the rest of S-10 (`value` vs `redraft_value`, leagues.js). See Known defects |

Licence: FantasyCalc's terms and API docs were read by R3 (2026-09-23, from the site bundle; the pages
are client-rendered): documented endpoints only (`GET /values/current`, `GET /players`), non-commercial
use, caching "ideally ... once per day" encouraged, a visible link to FantasyCalc.com required. The
per-player history endpoint is explicitly off-limits. This unit calls only `/values/current`, at most
once per format per day from the timer, and every test mocks `fetch` (no network, nothing paid).

Not statistical: no model number is produced, so no pre-registration; no 2025 look (no Holdout-ledger
row). Decision grading does not apply: this changes which price the trade surfaces read, not a decision
rule. The forward disagreement test (C12) that this history enables is a separate, pre-registered unit.
