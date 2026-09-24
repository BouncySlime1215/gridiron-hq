# FLIP-01: the flip radar as a nightly + on-news producer

RED `24fb2d2` "test: RED flip radar producer, flip_map section and nightly/news triggers" ·
GREEN follows · `test/flip-radar.test.js`, 15 cases.

## The gap

The flip map existed only as a study (`scripts/study/acq-flip-proto.mjs`, PR #227,
NORTH-STAR-RND C3): run by hand, writing a JSON file in the study's own names
(`flip.top[].a`, `flip.realised[].legs.p_complete`). Nothing produced it on a schedule,
nothing re-ran it when news moved a player, it sorted by spread alone (the spec ranks by
spread x P(A) x P(B) x days to the deadline), and the War Room contract (#238,
`plans-schema.js`) has a `flip_map` section no producer writes.

## What this adds

| file | what |
|---|---|
| `server/services/flip-radar/flip-score.js` | pure: screen window, spread + SE, two-leg expectation, deadline reader, the spec's rank |
| `server/services/flip-radar/flip-map.js` | the flip map on an injected world (prototype logic, ported), plus each manager's clone price vs title value |
| `server/services/flip-radar/flip-world.js` | the prototype's harness: one `tradeImpactWorld`, exact rescores, `playerValuation` clone price, `acceptanceBand` P(accept) |
| `server/services/flip-radar/flip-section.js` | the result as the typed `flip_map` section of `warroom-plans/1` |
| `server/services/flip-radar/flip-radar.js` | flag gate, nightly/news decision, snapshot write, `flipMapEntry()` for the campaign producer |
| `server/migrations/085_flip_map_snapshots.js` | one new table, additive |
| `server/services/scheduler.js`, `scripts/refresh-live-data.mjs` | job `flip_radar` (growth, worker thread, 30-min tick) on the live loop |
| `scripts/flip-radar.mjs` | one run on a DB copy, public-safe summary (team ids, positions, numbers) |

Changed from the prototype, on purpose:

- A pair is a flip only when the title spread clears 2 SE **and** B's clone price is at
  least A's (spec: "A prices a player low, B prices him high"). The prototype used the
  spread alone.
- Realised flips are ranked by `spread x p1 x p2 x days`; with no deadline in the payload
  the days factor is 1 and the section's `reason` says so.
- Up to 24 clearing pairs are realised (prototype: 12), and the section keeps the top 20.

## RED

At `24fb2d2` the test imports modules that do not exist:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/flip-radar/flip-score.js'
# pass 0
```

## GREEN

```
node --test test/flip-radar.test.js           # pass 15, fail 0
node --test test/scheduler-*.test.js test/preview-mode.test.js \
  test/refresh-loop-steps.test.js test/warroom-plans-contract.test.js   # pass 100, fail 0
```

Full `npm test` on this tree: 4817 tests, 4771 pass, 3 fail; all three were
"migration 085_flip_map_snapshots has no down(db) export" (the latest-migration
down/re-up tests). 085 now has `down()`; those two files re-run: pass 53, fail 0.

`preview-mode.test.js` caught two comments naming the preview variable outside
`preview-mode.js`; both now say "preview mode" instead.

## Not proven here

The real-league run (world build, rescore count, runtime, how many flips clear on league
4) needs the local DB. It is the `LOCAL:` line in the PR body.

## LOCAL run 1 (coordinator, `372d6b2`)

Both LOCAL lines stopped before the radar ran. `runMigrations()` refused its pre-migration
snapshot (0.9 GB DB, 1.1 GB free). Fix: `scripts/flip-radar.mjs` now applies only 085
through `migrate()`, which takes no snapshot. The runner works on a disposable copy, and
the radar reads no other pending migration's tables. The global snapshot rule is unchanged.
A second bug found on an empty-league copy: `tradeImpactWorld`'s `fail` is an object, and
the error read `[object Object]`. It now reads e.g. `title-odds world failed: league rules
incomplete: leagues.payload`.
