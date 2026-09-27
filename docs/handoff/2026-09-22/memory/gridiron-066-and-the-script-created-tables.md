---
name: gridiron-066-and-the-script-created-tables
description: Migration 066 vs the script's CREATE TABLE for league_transactions_raw (verified equal by PRAGMA, not by eye), and why league_season_teams / league_week_scores must NOT get the same treatment.
metadata:
  type: project
  modified: 2026-09-20T12:03:00.000Z
---

## league_transactions_raw — 066 is a real no-op, checked

On `main` (791b131) **nothing in `server/migrations` or `server/db` creates
this table**, across all 63 migrations. The only CREATE TABLE **outside
`test/`** is `scripts/collect-league-transactions.mjs:21`. Say it that way:
there are six on main, five of them test fixtures, and "the only CREATE TABLE"
as a bare claim invites a grep that appears to refute it.

Migration 066 (PR **#84**, branch `-scheduled-ingests`) creates it. The DDLs were compared
**mechanically** — both applied to real `node:sqlite`, `PRAGMA table_info`
diffed — not read side by side: **18 columns, every cid/name/type/notnull/pk
equal, same PK (league_id, season, tx_id), index `ltr_proposed` on the same two
columns in the same order.** Do that rather than trust the migration's own
comment claiming "character for character"; the comment is the author's, and
the author is the worst reviewer of their own checker.

Order: fresh clone → `runMigrations()` applies 066 at boot, and the collector
script on that branch is a thin wrapper with no CREATE TABLE, so nothing races.
Live DB → the table already exists from the script, so 066 is a no-op.

**Open caveat, needs one live read.** `IF NOT EXISTS` means 066 can never
*reconcile* a divergent existing table — it is a no-op on the live DB whatever
shape that table is really in. What is proven is that the two DDL **texts**
agree. Confirming the live table needs one `PRAGMA table_info` against it,
which the overnight rule forbids. Carry it into the go sweep.

## league_season_teams / league_week_scores — do NOT migrate these

Same shape (`scripts/backfill-league-history.mjs:43,:48`, no migration), but the
answer is the opposite, for a reason stronger than scope.

1. **066's trigger does not apply.** 066 exists only because moving the
   collector into the scheduler registry puts its CREATE TABLE on the server's
   import path, which `scripts/schema-snapshot.mjs` forbids (baseline and full
   snapshots must stay identical). Nothing moves the backfill script there.
2. **A migration would make it worse.** Creating the tables empty turns an
   honest `no such table` throw into a **silent zero**. The unguarded reads are
   `manager-archetypes.js:819` and `:831` (the one at `:243` is inside the try
   at `:229`; those two are in `managerProfile` and `archetypesFor` with no
   enclosing try). An archetype computed from zero rows reads as a real answer
   about a real person — the project's signature failure, and the same thing as
   the confident-zero third bucket.

**Rule:** the reader fix is right, and only right if it distinguishes "never
collected" from "collected, genuinely zero". If a migration is ever forced
here, it lands WITH that distinction, never before it.

Related: [[gridiron-failure-modes]] · [[gridiron-merge-reconciliations-2026-09-20]]
· [[gridiron-league-transactions-raw-unwritten-on-fly]]
