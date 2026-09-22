---
name: local-data-sqlite-is-at-migration-000
description: The cloud clone's server/data.sqlite has one row in schema_migrations (000_legacy_schema), so ~62 migrations are unapplied and "no such table" there means unmigrated, not missing code.
metadata:
  type: project
  modified: 2026-09-22T08:53:52.931Z
---

Measured 2026-09-22 on the cloud clone at `/home/user/gridiron-hq`:
`SELECT * FROM schema_migrations` returns exactly one row,
`000_legacy_schema` (applied 2026-09-20 06:19:02), while `server/migrations/`
holds 63 files. `server/data.sqlite` is gitignored (`.gitignore:11`), so a fresh
container builds it from the legacy schema and stops there.

**What this makes look like a bug and is not.** Tables created by numbered
migrations are simply absent — `nfl_teaser_executions` and
`nfl_teaser_execution_legs` (012), `nfl_execution_opportunities` (023),
`nfl_candidate_findings` (024), `research_trials` (038). Any script that reads
one dies with `no such table: …`, which reads as a missing table, a renamed
column or a dead code path. It is none of those. I misread exactly this once:
`scripts/run-purged-evaluation.mjs` died on `nfl_candidate_findings` and the
first conclusion written down was "neither committed evidence report is
reproducible in this repository", which was wrong.

**Before concluding anything from a `no such table` here**, check
`schema_migrations` first, then `grep -rl "CREATE TABLE[^;]*<name>" server/`.

**How to get a faithful database without touching the primary one.** Copy it and
migrate the copy — never migrate `server/data.sqlite` in place (overnight rule:
no live DB writes):

    cp server/data.sqlite "$SCRATCH/migrated.sqlite"
    GRIDIRON_DB_PATH="$SCRATCH/migrated.sqlite" SCHEDULER_DISABLED=1 node scripts/migrate.mjs

That applied 63 migrations cleanly and left the primary file's sha256 unchanged.
The Scheduler thread's related finding, same day: six of seventeen served tables
come from numbered migrations, so a harness that opens the database without
running them measures a database production never has.

**Schema is not data.** After migrating, `audit_registry`,
`nfl_candidate_input_audits` and `nfl_candidate_robustness_audits` all exist and
all hold **0 rows**. So the committed
`docs/evidence/2026-09-13/purged-evaluation-report.json` (55 registered trials,
best Sharpe 31.785) still cannot be regenerated here, migrations or not — its
55 came from a database this clone does not have, and the same backfill produces
27 rows here, all from literals in `backfill-historical-trial-registry.mjs`
rather than reads.

Related: [[gridiron-migration-runner]], [[migration-numbering-gridiron]],
[[an-empty-read-must-not-reach-a-written-report]].
