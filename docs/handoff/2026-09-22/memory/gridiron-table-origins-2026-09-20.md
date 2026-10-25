---
name: gridiron-table-origins-2026-09-20
description: Nineteen app-DB tables are created outside server/db/schema and migrations, in four buckets; league_transactions_raw is script-CREATED, which sharpens Finding 7.
metadata:
  type: project
  modified: 2026-09-20T11:59:45.715Z
---

Measured 2026-09-20 12:10Z at hold `claude/coach-grounded-4l8hno-hold` 0b8e77d, by
scanning every `.js`/`.mjs` under `server`, `scripts`, `client` for `CREATE TABLE` and
subtracting what `server/db/schema/` and `server/migrations/` declare. The scan returns
29 names; **19 are app-database tables**, in four buckets:

- **DB layer, at boot (3)**: `schema_migrations`, `db_health_checks` (server/db/index.js),
  `schema_preflight` (server/db/preflight.js).
- **At module import (7)**: `manager_signals`, `manager_player_view`
  (manager-signals.js:42,51) · `manager_archetypes`, `manager_archetype_jev`
  (manager-archetypes.js:74,86) · `league_member_identity` (manager-identity.js:17) ·
  `coach_answers` (coach/audit.js:14) · `coach_person_context` (coach/people/context.js:32).
- **On first write (1)**: `nfl_ensemble_rank_reports` (nfl-ensemble-rank.js:630).
- **Script only, so absent on a fresh clone (8)**: `coach_person_variables` ·
  `nfl_availability_rates`, `nfl_availability_role_rates` (DDL contingency.js:121,133,
  exec'd only by scripts/fit-availability.mjs) · **`league_transactions_raw`**
  (scripts/collect-league-transactions.mjs:21) · `league_season_teams`,
  `league_week_scores` (scripts/backfill-league-history.mjs:43,48) ·
  `nfl_rebuild_checkpoints`, `nfl_rebuild_progress`.

Ten of the 29 are NOT app-DB: `negotiation_profiles`, `jev_chat_signals`, `messages` live
in `data/derived/league_chat.sqlite`; the `sh_*` family in
`data/derived/sleeper_history.sqlite`; `default` and `statement` are template strings the
scan matched, not tables.

**Finding 7 is understated as written.** `league_transactions_raw` is not merely
refreshed by hand — no migration creates it, so a fresh clone does not have the table at
all. The morning-message line should say "from a table a script creates and a person
refreshes, which a fresh clone does not have", not "from rows collected by hand".

**`decision_recommendations` is NOT runtime-created** (the 06:27Z note is wrong): it is
migration `020_decision_recommendations.js`, and routes/decision-inbox.js:7 points at it.

Coach's catalog carries `created_at_runtime_by` (null when the declared schema creates
the table), 55 tables as of 0b8e77d, with a test that every path in the sentence exists
and holds the CREATE TABLE. Evidence: `docs/tdd/coach-table-origins.tdd.md`.

**The method, not just the answer**: my first count said eleven, from scanning
`server/services` and `server/routes` alone, and the `league_transactions_raw` finding
was inside the gap. Scan the whole repo, then subtract the declared schema.

See [[gridiron-failure-modes]], [[gridiron-morning-message-inputs-2026-09-20]].
