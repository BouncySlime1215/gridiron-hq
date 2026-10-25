---
name: gridiron-no-read-only-path-to-the-production-db
description: Importing any Gridiron service opens the database READ-WRITE and writes to it at import time, so there is no read-only path to production; take a VACUUM INTO snapshot instead, and never `cp` a WAL database.
metadata:
  type: project
---

Found by the Explorer 2026-09-22 while building the production read
(`/mnt/project-files/read.mjs`, `READ-PREREG-2026-09-22.md`), after the Auditor
(R21.2) correctly rejected a `cp`-based design. The prescribed replacement —
"open it read-only in place" — turned out not to be reachable either.

**`server/db/index.js` does all of this AT IMPORT TIME**, before any caller gets
a say:

    :20   new DatabaseSync(DB_PATH)                      read-WRITE, no option
    :22   PRAGMA journal_mode = WAL                      a write
    :45   CREATE TABLE IF NOT EXISTS schema_migrations   a write
    :184  the legacy-schema migration, if unapplied      a write, with a backup
    :194  CREATE TABLE IF NOT EXISTS db_health_checks    a write
          then an integrity check that records its result

So **any** script importing a service (`weekly-backtest.js`, anything) opens
production read-write and writes to it. `{ readOnly: true }` cannot be reached
without changing the repository, and changing the repository in order to take a
read is the wrong order of operations.

**NEVER `cp` the live database.** It runs in WAL mode, so a plain copy takes the
main file without `-wal`/`-shm` and **silently drops every committed
transaction still in the WAL**. The symptom is **low row counts**, which looks
exactly like the data being missing rather than the copy being wrong. A
concurrent write can also tear it.

**The pattern that works:** `VACUUM INTO` from a **read-only** connection to the
live file. It takes a read transaction, so the snapshot is transactionally
consistent and includes the WAL; it writes nothing to the source; and the
import-time writes above land on the snapshot. Then set `GRIDIRON_DB_PATH` to
the snapshot and **dynamically** import the service (a static import would
resolve before the env is set).

**Say it precisely.** The source file is not modified (verified: mtime
unchanged across a full run). A read-only open of a WAL database does attach
to — and on an idle database can create — the `-shm` and a zero-length `-wal`
beside it. On production the app already holds both open.

**Check free space first.** The database is past 2 GB (`server/db/index.js`
records a `-wal` that once reached ~3.3 GB), and a snapshot needs room for a
full copy.

Related: [[gridiron-deploy-step-2026-09-22]], [[gridiron-open-risks]],
[[gridiron-live-environment-notes]].
