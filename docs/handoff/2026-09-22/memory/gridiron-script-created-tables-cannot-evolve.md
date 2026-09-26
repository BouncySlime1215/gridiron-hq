---
name: gridiron-script-created-tables-cannot-evolve
description: Tables created by scripts with CREATE TABLE IF NOT EXISTS (league_season_teams, league_transactions_raw) have no migration, so an existing table can never gain a column — the root cause behind #89's "no such column: espn_member_id".
metadata:
  type: project
  modified: 2026-09-22T11:41:49.822Z
---

**SUPERSEDED 11:39Z 2026-09-22 (league_season_teams claim only):** Chat sync (#89 owner) found league_season_teams IS created by server/migrations/064_league_history_tables.js with espn_member_id, and every DDL version in git history has the column; see [[gridiron-state-1136-2026-09-22]]. The claim below is kept for the record.

**AMENDED 11:47Z — the superseding note above is itself wrong about which tree.
Measured on origin/main 654ff93, not inferred:**
- `origin/main` migrations stop at **062**. There is no `064`, and
  `git grep espn_member_id origin/main -- server/migrations server/db/schema`
  returns nothing. On main the only creator is
  `scripts/backfill-league-history.mjs`.
- The migration does exist as `server/migrations/20260919213000_league_history_tables.js`
  (commits `1c97e3a`, `9d02912`), with `espn_member_id TEXT` in its DDL, but it
  is **UNMERGED**: `git merge-base --is-ancestor` says NOT on main for both, and
  it lives only on `origin/claude/project-thread-sytruo-{asof-hold,asof-rebase,lst}`.
  "064 ... already on main" is that branch's renumbered copy read as main.
- **Chat sync is still right that the original claim below is withdrawn**, for a
  different reason than they gave: the error `no such column: espn_member_id`
  was NEVER OBSERVED by anyone. It reached this thread only as a string in a
  coordinator relay. No log, no stack trace, no database. Every DDL version
  carries the column, so there is no version gap to repair.
- **Net: no ALTER TABLE migration should be written.** The only real item is
  that the sytruo migration is unmerged, which is a merge-order fact and not a
  defect.
- The pattern worth keeping: four claims in twelve hours (this one, chat sync's
  064, the #100 RED row, the #41/#91 merge order) all failed the same way —
  **a fact measured on one tree, reported under another tree's name.**

`league_season_teams` is in NO migration and NO schema file. It is created by
`scripts/backfill-league-history.mjs:48` with `CREATE TABLE IF NOT EXISTS`, and
that DDL *does* include `espn_member_id` (so does the fixture at
`test/manager-signals-api.test.js:121`).

**So a database that throws `no such column: espn_member_id` has a table created
by an OLDER version of that script, and `IF NOT EXISTS` will never add a column
to a table that already exists. With no migration there is no path by which that
database can ever gain the column.** Verified 2026-09-22 against origin/main
654ff93 while planning the #89 hand-off.

**Why:** this is `league_transactions_raw`'s problem with one extra turn — not
just a table nothing creates, but a table nothing can *evolve*. Re-running the
script does not repair it. Dropping and rebuilding loses history.

**How to apply:**
- The remedy is a real migration doing `ALTER TABLE league_season_teams ADD
  COLUMN`, owned by whoever owns `manager-archetypes.js` (#89), not by the trade
  path.
- Before calling such an error environmental, ask WHICH database: a dev DB
  predating the column behaves identically to a broken production one.
- When a script creates a table, assume every deployed copy may hold a different
  shape. `scripts/swallow-scan.mjs` finds bare catches over these reads but not
  the schema drift itself — see [[gridiron-swallow-scan-tool]].
- Reporting asymmetry found the same day: the archetype read failure IS reported
  on the manager-signals route (`routes/trades.js:495`, `read_state` /
  `read_failed`) and is NOT on the trade path
  (`counterparty-pricing.js:246`/`:394` publishes bare `archetypes`). Two
  callers of one store, one silent.
