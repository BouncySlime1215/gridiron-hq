---
name: servedtables-is-coverage-not-timestamps
description: The freshness registry replacing the fake "data healthy" banner is servedTables() in source-registry.js, and its rules must be coverage-based because 6 of its 10 feed tables have no timestamp column at all.
metadata:
  type: project
  modified: 2026-09-22T04:37:26.235Z
---

`servedTables()` in `server/services/source-registry.js` is the ONE source of
truth for the freshness banner. UI iterates it; UI does not carry a list.
Agreed with the coordinator 2026-09-22. **PUSHED 2026-09-22 08:14Z as PR #96**,
branch `claude/project-thread-o3wt2p-servedtables` head `a24692d`.

**MERGE GATE: do not merge #96 alone** — the consumer reads a different rule
shape and the mismatch makes the banner read `fresh` on stale data. Measured;
full detail and the merge order in [[freshness-contract-seam-failed-open]].

**The evaluator now ships with the rules**, on
`claude/project-thread-o3wt2p-freshness-evaluator` off a24692d:
`evaluateServedTable(entry, {season, week, database})` → `{table, current,
rule, grain, reader, error}`, and `servedTableVerdicts({entries, season, week,
database})` which reports a rule that THREW as `current: null` + `error`
instead of dropping it. It THROWS on: no sql, placeholder/param count
mismatch, a bind name outside `['season','week']`, a query returning no row,
or a value that is not 0 or 1.

**Why the contract is whole queries, not WHERE fragments — do not "simplify"
this.** Two of the 17 rules are UNIVERSALS, not existentials, and a fragment
cannot carry them: `roster_players` is `MIN(fetched_at) >= -1 day` (every NFL
team refreshed) and `gamescript_model` is `COUNT(DISTINCT target) >= 2` (both
targets fitted). A fragment matching one row says "at least one team is fresh",
which is WEAKER than a row count, and "at least one target is fitted", which IS
the half-fitted-model bug the rule exists to catch.

**Corrected 2026-09-22:** `roster_players`'s rule text said "every connected
league was refreshed within the last day". That table has NO league column — it
is `team_id REFERENCES nfl_teams(id)` with a `name`, i.e. NFL team rosters, not
fantasy league rosters. Fantasy league rosters are `league_roster_snapshots`.

Shape per entry: `{ table, season_col, week_col, updated_col, grain, current_rule }`
where `current_rule` is `{ text, sql, params }` and the SQL returns exactly one
row, one column aliased `current`, 1 or 0. `params` is a positional bind order
naming only `'season'` or `'week'`. **The call site must spread** --
`db/index.js` `row(sql, ...params)` is variadic, and passing the array unspread
throws `Unknown named parameter '0'`.

**Why coverage, not timestamps:** six of the ten feed tables --
`player_week_usage`, `nfl_player_week_features`, `schedule_games`,
`nfl_injuries`, `nfl_depth`, `league_roster_snapshots` -- have **no timestamp
column at all**. And the deeper reason applies even where one exists: a sync
that ran, succeeded and wrote zero rows leaves a FRESH timestamp on an EMPTY
table. Production carries zero 2026 rows in `player_week_usage` and the old
"data healthy" banner still read green, because it checked that the database
answered rather than that it held rows. A timestamp-driven banner rebuilds the
exact bug. Only `roster_players` and `news_items` get timestamp rules, because
they have no season or week of their own.

**How to apply:** the list is deliberately narrow -- 100 tables carry a season
or week column, most internal, and betting tables are out by Nick's ruling.
Adding an entry is the mechanism for widening it. Grain `'fit'` covers seven fit
stores with their own stronger rules: [[fit-stores-default-to-not-live]].
`league_roster_snapshots` is in the registry although no model reads it -- a
feeds-vs-model-reads scope difference, not a gap.

**Held, not skipped: `nfl_route_splits` (2026-09-22).** Scheduler is
deliberately NOT adding a `servedTables()` entry for the new
`nfl_route_splits` table yet, and the coordinator agreed. Nothing writes
rows to it yet (no timer, no live pull), so an entry today would read
not-current from day one -- exactly the "database answered but held no
rows" failure this registry exists to catch, undermining the whole point of
the honest-inventory/freshness work. Add the entry only once the sync job is
wired and has written at least one real live pull, with the row-count floor
set from 2-3 observed pulls rather than a guessed number.
