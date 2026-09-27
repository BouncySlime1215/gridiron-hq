---
name: gridiron-availability-fit-cache-traps
description: The caches and the wrong-endpoint trap that make the Gridiron HQ availability fit read as "nothing changed", and the two cache-free reads that work.
metadata:
  type: project
---

Part of [[gridiron-availability-fit]]. Verified on `origin/main` **791b131**.

## (a) The simulate memo WILL fake a null result

`routes/model.js:107` is a plain `Map` keyed
`sim:<league>:<runs>:<from_week>:seed:<seed>` with **no data fingerprint**.
`clearModelCache()` runs only on a league sync, `/api/dev/refresh-all`, or the
big nfldata sync. A script writing from another process invalidates nothing, so
the after-reading comes back byte-identical and reads as *"the fit changed
nothing"*.

**Workaround: use an unused seed for the after-reading.** That is the whole
fix. Do **not** use `POST /api/leagues/:id/sync` or `/api/dev/refresh-all` as
a cache clear — both also change data and confound the comparison. A restart
is not needed either (and re-runs bootJobs, which can refresh `nfl_injuries`,
which `weeklyAvailability` reads).

The route threads a seed through `withRandomSeed`, so
`?seed=<unused>&runs=2000&from_week=2` is deterministic. **Pin `from_week`** —
the route defaults it to 1.

## (b) `/api/model/availability` with no `?week` CANNOT show the fit

It is memoised under the bare key `'avail'` (`model.js:589`) — true, and the
wiring-map thread found that correctly. **But the consequence is different:**
`memo('avail')` wraps `availability()` (`contingency.js:40`), the durability
prior computed from `player_week_usage`. It reads **neither fitted table**. So
it returns identical numbers after the write whether the cache is cleared,
bypassed or the process restarted. Anyone told "restart and the new numbers
appear" will restart, see nothing, and conclude the fit failed.

It also sorts ascending and slices 200, so it serves the **lowest** 200 only —
no healthy-starter reading is obtainable from it.

## The two cache-free reads, which need no restart

- `GET /api/model/availability?week=2` -> `weeklyAvailability()` at
  `model.js:585`, called directly, not through `memo`.
- `GET /api/model/player/<id>?week=2` -> `weeklyAvailability()` at
  `model.js:448`, also direct. Returns `weekly_availability` with
  `active_probability`, `durability_prior`, `designation`,
  `designation_source`.

Both reach `fittedAvailability()` (`contingency.js:559`), stamp-guarded on row
count plus `MAX(fitted_at)` via `availabilityFitStamp()` (`:547`).

## (c) Not hazards — do not waste a step clearing them

`_roleCache` (`contingency.js:313`) is keyed on usage and snap row counts,
which the fit does not write, and role states are fit-independent anyway.
`_espnMemo` (`:232`) is live ESPN status, orthogonal.

## The trade engine is the opposite, and is safe

`trade-engine.js:224-225` puts **both** fitted tables in its cache
FINGERPRINT, stamped on `fitted_at`, so the write invalidates it automatically
(`:493` says so). The intuitive asymmetry is backwards: the surface with the
explicit fingerprint self-heals; the one that merely memoises serves stale
values forever.

**The general lesson:** a check that confirms a thing RAN is weaker than one
confirming what it PRODUCED — and an endpoint whose name matches the thing you
changed is not evidence it reads it.
