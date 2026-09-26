---
name: gridiron-release-train-deploy-facts
description: Verified facts that shape any gridiron-hq deploy — never delete a .bak, roll back to an image not a commit, how to probe the live machine, and how to take a comparable simulator reading.
metadata:
  type: project
  modified: 2026-09-19T22:47:00.000Z
---

Verified 2026-09-19 while building the release train
([[gridiron-release-train-2026-09-19]]). **Ordered most-costly-mistake first,
because per-file recall shows only the first 4 KB** — this file was 4,444 B and
the rule below sat under the cut, which is how it nearly became invisible in
the file most likely to be recalled during a rollback.

## Never delete a `.bak`

`/data/data.sqlite.pre-migration-<stamp>.bak` (~445 MB) is written at boot when
a migration is pending, and **nothing ever removes it**. There is no scheduled
backup of the live database — `nightly-backup.sh` covers Nick's laptop clone,
not `/data` — so **a `.bak` is the only copy of live rows ever taken**. When
free space nears the line the fix is `fly volumes extend`, never pruning.
Details: [[gridiron-pre-migration-snapshot]],
[[gridiron-fly-volume-has-no-backup]], [[gridiron-migration-snapshot-disk-gate]].

## Roll back to an image, and know what it does not restore

Capture `fly image show -a gridiron-hq` **before** deploying over it; the
running build's provenance is not establishable from commits. Target:
`registry.fly.io/gridiron-hq:deployment-01M2VZ9JRYSXVHCRWJ83V360QH`, the last
release that was actually healthy. `deployment-01M2XRT9094HFEB29SXRG1NMSD` is
**not** a target — it is the 2026-09-19 release that never became healthy.

**The migrations in this train are NOT additive, so an image is half a
rollback.** `053` rebuilds `nfl_news_signals` with a `DROP TABLE` and rename
inside `up()`; `055` runs `UPDATE game_lines SET open_spread …`; `061` runs
`UPDATE sync_log SET consecutive_failures = 1`. Neither `UPDATE` is recoverable
by its own `down()`, so `npm run db:rollback` does not restore what they
overwrote. **The image rolls back CODE; the `.bak` rolls back ROWS.**

## Probing the live machine

**`sqlite3` is not installed.** The image is `node:22-slim`. Use
`node --no-warnings -e` with `node:sqlite` opened `{ readOnly: true }` — tested
end to end including `fly ssh console -C` quoting. `GRIDIRON_DB_PATH` is
already set in the image. Wrap each table read in try/catch so a missing table
prints a named ERROR instead of killing the probe. Untestable from a cloud
session: how `flyctl` splits `-C`; fall back to `fly ssh console -a gridiron-hq`
and paste the `node …` part at the prompt.

## Comparable simulator readings

`GET /api/model/:leagueId/simulate` threads `req.query.seed` through
`withRandomSeed` (`routes/model.js:524`), so `?seed=1&runs=2000&from_week=2` is
deterministic across runs. **Pass `from_week` explicitly** — the route defaults
it to 1 and that default is itself slated to change, so pinning it keeps
readings comparable across that fix. Without a seed every difference is
confounded with Monte Carlo noise.

## Deploying

`fly deploy` by hand; there is no auto-deploy. `.github/workflows/` holds only
`ci.yml` (~6.5 min). Auto-deploy exists in `docs/FANTASY-ENGINE-MASTER-PLAN.md`
as a plan, not as anything implemented. Migrations run at boot before
`app.listen`, so there is no release command and a deploy's boot is longer than
a restart's. `fly.toml` deliberately carries **no** `app` name. Allow 300 s for
the first request after idle: [[gridiron-fly-cold-start]].
