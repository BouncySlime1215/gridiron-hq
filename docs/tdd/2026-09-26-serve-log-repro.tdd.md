# SERVE-LOG REPRO: pin every served number to snapshot + model + code + seed, and a "reproduce this card" command

2026-09-26. Batch D plan item 31 (research #9). Off `main` `932c8e41`. Flag `GRIDIRON_SERVE_PIN` (off by default).

Item 31 asks for every served number to be pinned to the snapshot, model, code and seed that made it,
and for one command that reproduces a card. The serve-log (IDEA-001, `serve-log.js`, migration 079)
already keeps every served number with its `model` and `model_version`. What it does not keep:

| Needed to reproduce | On `main` today |
| --- | --- |
| Code | nothing: no commit sha anywhere on a served row |
| Snapshot | `as_of` = `leagues.fetched_at` only; nothing says whether the league data behind it is still the same |
| Seed | `trade_impact` rows carry `seed=<n>` in `model_version`. `title_odds` rows carry `seed=` EMPTY: `GET /api/model/:id/simulate` without `?seed` runs on `Math.random` (`withRandomSeed(null)`), so those numbers cannot be reproduced at all. The weekly snapshot's title odds are the same. |
| Producer inputs | the route's arguments (runs, from_week, team, limit, excludes) are not kept |
| A command | none |

This unit adds one row per served response to a new table `served_pins` (migration 119), written in
the same transaction as that response's `served_numbers` rows, and `scripts/eval/repro-card.mjs`, which
re-runs the pinned producer and compares every number.

- **Code** = the commit the server process is running (`GRIDIRON_CODE_SHA`, else `.git/HEAD` read once).
- **Snapshot** = sha256 of the league payload the number was computed from, plus `as_of`. Hashed once per
  league sync (memoised on league id + `fetched_at`), not per request.
- **Model** = the serve-log's own `model` / `model_version` (unchanged) plus the producer arguments.
- **Seed** = the seed the producer ran under. With the flag on, an unseeded title-odds request runs on a
  seed keyed to the league sync (`keyedSeed('title-odds', league, fetched_at, runs, from_week)`, the same
  pattern `tradeImpactSeed` already uses for trade cards), so the served number is one draw of the same
  distribution but a recorded one. That is the only served-number behaviour the flag changes.

<!-- The pre-registration below is committed with the RED tests, before any implementation. -->

## Pre-registration (written before the GREEN commit)

Metric: the share of pinned cards the command reproduces number-for-number on the same code and snapshot,
and the share of drifted cards it refuses or flags instead of passing.

- **B1 (flag off is inert).** `GRIDIRON_SERVE_PIN` unset: 0 `served_pins` rows; `served_numbers` rows for
  all four route surfaces identical to `main`'s (same entity, field, value, model, model_version); an
  unseeded `/simulate` still runs unseeded (`seed=` empty). `GRIDIRON_PREVIEW_UNCONFIRMED=1` alone does
  not switch it on. **Pass bar:** all four hold. **Fails it:** any pin row, any served row that differs.
- **B2 (every response pinned).** Flag on: each served response on the five surfaces (`title_odds`,
  `trade_impact`, `title_trades`, `trade_find`, `war_room`) writes exactly one pin with a 40-hex code sha,
  the sha256 of the league payload, the producer arguments and the seed (or `seed_basis` saying why none
  is needed). The weekly snapshot pins its entries the same way. **Pass bar:** 5/5 surfaces + weekly.
  **Fails it:** a response with numbers and no pin, or a pin with a field missing.
- **B3 (reproduce exactly).** Flag on, same code and snapshot: `reproduceCard` re-runs the pinned producer
  and every served number comes back equal (both null, or |served - rerun| <= 1e-9), and the rerun serves
  no extra number. Producers in the test are seed-dependent stand-ins (the real `random()` stream), so an
  unrecorded seed WOULD fail this. **Pass bar:** 4/4 producer surfaces (`title_odds` unseeded and seeded,
  `trade_impact`, `title_trades`, `trade_find`) `reproduced`. **Fails it:** any number off, or any surface
  that cannot be re-run.
- **B4 (drift is refused or flagged, never passed).** Six cases: league payload changed since serving
  -> `snapshot_mismatch` (refused, exit 2); running code differs -> `code_mismatch` naming
  `git checkout <sha>` (refused, exit 2); a served value tampered in the table -> `mismatch` naming
  entity and field (exit 1); a response served while the flag was off -> `no_pin` (exit 2); the running
  code sha unknown -> `code_unknown` (exit 2); a `war_room` card -> `producer_run_needed` with the
  producer command (exit 2). **Pass bar:** 6/6, and 0 of them report `reproduced`.
- **B5 (seeds recorded).** Flag on: an unseeded `/simulate` records the keyed seed, twice in a row gives
  the same seed and the same numbers; `?seed=5` records 5. **Pass bar:** all three.
- **B6 (cheap on the request thread).** The league payload is hashed once per (league, `fetched_at`):
  10 requests on one sync = 1 hash; a new sync = 1 more. A 2 MB payload hashes in < 200 ms (loose bound
  for CI; the measured figure goes in the GREEN section). **Pass bar:** hash count exact, time bound held.
- **B7 (no silent failure).** No git and no `GRIDIRON_CODE_SHA`: the pin is still written with
  `code.sha = null` and a reason, and the command answers `code_unknown`, never `reproduced`. A failed pin
  write rolls back that batch's `served_numbers` rows too and throws (the serve-log's existing contract).
  **Pass bar:** both.
- **B8 (the command).** `node scripts/eval/repro-card.mjs --db <path> --league <id> --request-id <id>
  [--json]` prints the verdict and exits 0 / 1 / 2 as above; `--latest` picks the newest pinned response;
  an unknown request id exits 2 with a plain line. **Pass bar:** exit codes and JSON verdicts on a fixture DB.

What this does NOT claim: the snapshot hash covers the league payload only. Other DB inputs the producers
read (projections, player metrics, fit stores) are not fingerprinted, so a card whose league payload is
unchanged but whose projections moved reports `mismatch` rather than being refused up front. The fix for
that is running the command against a DB backup taken at `as_of` (`--db`), which the local measurement does.

## Addendum A1 (added after the RED commit, before the GREEN commit; no bar above changed)

Reading the diff before GREEN: the same commit serves different numbers under different `GRIDIRON_*`
switches (the one world, RB-TITLE, basis flags), and the pin did not record them. The pin now carries
`flags`: every set `GRIDIRON_*` variable whose value is switch-shaped (`0/1/on/off/true/false/shadow/
preview/deltas/enforce/live/study`), never one whose name looks like a key, token, password, cookie or
credential, and never `GRIDIRON_CODE_SHA` or a path. A seventh B4 case: switches that differ ->
`flags_mismatch` (refused, exit 2) naming the switches to set; the same switches reproduce. **Pass bar:**
refused with the right switch named, reproduced once it is set, and a secret-shaped or path-valued
variable never lands in a pin.

## Addendum A2 (main moved under this branch: #512 ONE-NUMBER-FIX, merged 2026-09-26)

#512 made `GET /simulate` and `POST /trade-impact` always serve the league world (`league-world.js`), so
the unseeded per-request `simulateSeason` path this unit was going to seed no longer exists on `main`.
What changes, and nothing else: the route title odds' pinned seed is the world id they were drawn on
(`one_world.world_id`), a sent `?seed` is ignored by the route and is not recorded; the keyed
`titleOddsSeed` now applies only to the weekly snapshot's title odds, the last unseeded served draw.
B1's "unseeded `/simulate` keeps `seed=` empty" clause is replaced by: the weekly snapshot's title odds
keep `seed=` empty with the flag off, and ALL five route surfaces' served rows (title odds included,
now deterministic) are identical flag off vs on. B5 becomes: route title odds record the world id,
stable across requests, `?seed=5` not recorded as what ran; weekly title odds record the keyed seed
with the flag on. No bar was loosened; B3 still re-runs `?seed=5` and requires it reproduced.

## RED

`test/serve-pin.test.js` committed first (`f8322018`); run on the RED commit:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/serve-pin.js'
# tests 1
# pass 0
# fail 1
```

## GREEN

```
node --experimental-test-module-mocks --test test/serve-pin.test.js
# B6: 2 MB payload hashed in 6.94 ms
# tests 21
# pass 21
# fail 0
```

| Bar | Result |
| --- | --- |
| B1 flag off inert | pass: 0 pins; served rows for all five route surfaces identical flag off vs on; weekly title odds keep `seed=` empty with the flag off (A2); preview alone does not switch it on |
| B2 every response pinned | pass: 5/5 surfaces + the weekly snapshot (3 surfaces, title odds on the recorded seed) |
| B3 reproduce exactly | pass: 5/5 re-runs (title odds unseeded and `?seed=5`, trade impact, title trades, finder), every number equal |
| B4 drift refused or flagged | pass: 7/7 (snapshot, code, tampered value, no pin, unknown code, War Room, switches), 0 reported `reproduced` |
| B5 seeds recorded (A2) | pass: route title odds record the world id, stable across two requests with equal numbers, the ignored `?seed=5` not recorded; weekly title odds record the keyed seed |
| B6 cheap | pass: 10 reads of one sync = 1 hash, a new sync = 1 more; 2 MB payload 6.8-7.5 ms |
| B7 no silent failure | pass: no git and no env -> pin written with `code.sha = null` + reason, command answers `code_unknown`; a failed pin insert rolls back the batch's numbers, throws, and re-queues |
| B8 the command | pass: unknown id exit 2 `not_found`; War Room exit 2 "needs a producer run"; `--latest --surface` picks the newest; `--help` exit 0 |

One fixture correction after the first GREEN run: the finder stand-in dereferenced `excludeIds.size` when
the weekly snapshot passes no excludes (`null`, which the real `findTrades` accepts,
`trade-engine.js:1886`). The stand-in now treats `null` as empty; no assertion or bar changed.

## Not covered

- Real producers on real league data. The stand-ins draw from the real `random()` stream, so the test
  proves the plumbing records and replays the seed; whether `simulateSeason`, `tradeImpact`,
  `titleOddsTrades` and `findTrades` are fully deterministic given (snapshot, args, seed, switches) on
  league 4 is the local measurement in the PR.
- DB inputs other than the league payload (projections, player metrics, fit stores) are not
  fingerprinted; their drift shows as `mismatch`, and `--db <backup at as_of>` is the remedy.
- A dirty working tree is not detected: the code pin is HEAD's commit.
- War Room cards are not re-run (the plans producer is a separate process with its own inputs); the
  command says so and gives the producer command.
