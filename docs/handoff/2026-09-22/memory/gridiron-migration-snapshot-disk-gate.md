---
name: gridiron-migration-snapshot-disk-gate
description: Any Gridiron HQ deploy carrying new migrations needs the database's size plus 2 GB free on /data, or the machine throws before app.listen and the deploy fails with an error about disk.
metadata:
  type: project
  modified: 2026-09-19T21:21:00.821Z
---

**Before any deploy that carries new migrations:**

```
fly ssh console -a gridiron-hq -C "df -h /data"
```

The live database is **445 MB** (`/data/data.sqlite`, WAL mode, verified
2026-09-19), so this needs about **2.5 GB in `Avail`**. Under that, the deploy
fails — and it fails for a reason that mentions nothing about the code being
deployed.

**The chain, read off the shipping tree** (`server/db/migrate.js`,
`server/db/index.js`):

1. `runMigrations` computes `pendingCount` from the migration filenames.
2. Any `pendingCount > 0` calls `backupBeforeMigration` — a `VACUUM INTO`
   snapshot taken before anything changes.
3. `backupBeforeMigration` calls `assertRoomForSnapshot` **first**, and
   `SNAPSHOT_HEADROOM_BYTES = 2 * 1024 ** 3`. It demands the database's full
   size **plus 2 GB**, deliberately generous.
4. All of this is inside `await runMigrations()` in `server/index.js`, which is
   **before `app.listen`**.

So on a volume without the headroom the new machine throws on start, never
listens, and health checks never go green. **The failure is in the safe
direction** — nothing is written, the snapshot is declined rather than
half-taken, Fly keeps the previous release — but the error is about disk.

**The fix is `fly volumes extend`, never skipping the snapshot.** That is a
person's call, not a session's.

**It fired on 2026-09-19 — the volume was 1 GB and the `df` above was never
run. The incident, the extend, and what a refused deploy leaves behind are in
[[gridiron-disk-gate-fired-2026-09-19]].**

**Two related things that are easy to conflate.** The snapshot is `VACUUM INTO`
rather than a file copy precisely *because* the database runs in WAL mode (there
was a 13.7 MB WAL outstanding on 2026-09-19); it reads through the WAL and is
consistent. So a `cp` of `data.sqlite` alone is never an acceptable substitute —
it would silently miss committed pages. And the snapshot only happens at all if
`pendingCount > 0`, which is computed from the *filename* while migrations apply
under `mod.name ?? basename` — the silent-skip hazard in
[[gridiron-release-train-2026-09-19]]. Verified 2026-09-19: all 63 files have
basename == name, so it is latent, not live.

**How this was nearly missed.** The deploy plan said "three new migrations" from
an earlier count; the real number was about **11** (main carried 52 files, the
proved tree 63). Nobody had asked what 11 pending migrations cause at boot.
Checking what a step *produces* rather than that it runs is the house rule —
see [[gridiron-cite-the-shipping-tree]] for the other half of the same mistake.

**Do not write the pending count down as a checkable number.** `pendingCount` is
counted against the live database's `schema_migrations`, not against a diff of
two trees, and the binary that was serving was branch work rather than `main`.
The gate turns only on the count being above zero.
