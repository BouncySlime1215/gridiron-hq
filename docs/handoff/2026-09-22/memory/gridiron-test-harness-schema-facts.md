---
name: gridiron-test-harness-schema-facts
description: Test-harness schema facts that cost time on 2026-09-22 — opening the db gives only the legacy schema, runMigrations() is a separate call, nfl_teams is migrated but unseeded, roster_players has no league_id.
metadata:
  type: reference
---

Facts about what a test harness actually gets, each one having first shown up as
a confusing failure rather than as documentation.

**Opening the database gives the LEGACY schema only.** `await import(
'../server/db/index.js')` applies `000_legacy_schema.js`. Numbered migrations are
a **separate** call:

```js
const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
```

Without it, a table created by a numbered migration is simply absent and the
failure reads `no such table: <x>` — which looks like a wrong table name, not a
missing setup step. `league_roster_snapshots` is migration **058**; six of the
seventeen `servedTables()` entries are migration-created.

**`nfl_teams` is created by migration but NOT seeded — zero rows.** Seeding lives
in `server/db/seed/index.js` and a migrated test DB has not run it. Anything with
`team_id REFERENCES nfl_teams(id)` needs the team inserted first. Its real shape
is `(id, abbr, name, conference, division, ...)` — the column is **`abbr`**, not
`abbreviation`, and `name`, `conference`, `division` are all NOT NULL:

```js
db.prepare(`INSERT INTO nfl_teams (id, abbr, name, conference, division)
            VALUES (?, ?, ?, 'AFC', 'East')`).run(901, 'AAA', 'Team A');
```

**`roster_players` has no `league_id` and no `player_id`.** It is
`(id, team_id REFERENCES nfl_teams(id), espn_id, name NOT NULL, position, unit,
... fetched_at, depth_slot, depth_order)` — **NFL team rosters, not fantasy
league rosters.** Fantasy league rosters are `league_roster_snapshots`. A
`servedTables()` rule text describing it as "every connected league" was wrong
for exactly this reason and was corrected 2026-09-22.

**`gamescript_model`** is `(target TEXT PRIMARY KEY, b0, b_spread, b_total, r2,
n, fitted_at)` with target in `'pass_att' | 'rush_att'` — two rows when fully
fitted, which is why its freshness rule is `COUNT(DISTINCT target) >= 2` and not
a row count.

Also true and easy to forget: a bare `node --test` on files touching fitted
models is not comparable to the harness figure — see
[[gridiron-suite-figure-rule]]. And epoch status vocabulary is
`('active','archived')`, never `'closed'` (CHECK constraint).
