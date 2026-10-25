---
name: sql-alias-colliding-with-a-real-column
description: "In SQLite, an output alias that shares a name with a real column of the same table is silently resolved to the column, giving a wrong grouped answer rather than an error."
metadata:
  type: project
  modified: 2026-09-22T17:17:03.610Z
---

Never alias a computed column with the name of a real column in the same
table. On a collision SQLite resolves the bare name to the **column**, not
to the alias, with no error and no warning.

    -- WRONG: nfl_capture_triggers HAS a `reason` column (migration 014)
    SELECT json_extract(outcome_json,'$.reason') AS reason, COUNT(*) n
    FROM nfl_capture_triggers GROUP BY reason

    -- RIGHT
    SELECT json_extract(outcome_json,'$.reason') AS stop_reason, COUNT(*) n
    FROM nfl_capture_triggers GROUP BY json_extract(outcome_json,'$.reason')

**Why:** 2026-09-22. A read-only probe written by the Opportunity thread was
caught by the Scheduler thread before it reached Nick's paste block. Seeded
with two rows carrying the same table `reason` and two different extracted
outcomes, the wrong form returned ONE row, n=2, labelled with an arbitrary
one of the two. A wrong answer, not a missing one.

**The cause is the collision, not the bare name.** Isolated afterwards: with
the alias renamed to `stop_reason`, `GROUP BY stop_reason` — still a bare
alias, not the expression — returns both rows correctly. SQLite groups by an
output alias perfectly well. So "always GROUP BY the expression" is the wrong
lesson: it fixes the grouping while leaving a colliding alias free to
mislabel what gets printed.

**How to apply:**
- Before aliasing, check the table definition for that column name. In this
  repo the table DDL is in `server/migrations/`, not the schema builder, for
  anything a migration creates unguarded.
- Test a probe against a seeded in-memory `node:sqlite` database with rows
  built to *discriminate* — two rows that must produce two groups — before
  handing it to anyone. A single-row seed passes under both the bug and the
  fix.
- Related: `nfl_capture_triggers` is deliberately absent from the schema
  builder (`server/db/schema/nfl-a-to-m.js:187-191`), so a missing table
  means "migration 014 not applied", never "no rows yet". Report those two
  differently.
