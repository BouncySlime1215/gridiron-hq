---
name: publish-under-a-package-specific-name
description: /mnt/project-files is one flat shared directory, so publishing a generically named script silently overwrites another package's file — prefix every artifact with its package.
metadata:
  type: feedback
---

`/mnt/project-files` is a **single flat directory shared by every thread**.
There are no subfolders per package. A `cp build.mjs /mnt/project-files/`
overwrites whatever `build.mjs` was already there, with no warning and no
error.

**Why.** 2026-09-22 I published the TE package's `build.mjs` and `test.mjs` and
destroyed the route-mix package's `build.mjs`, which `ROUTEMIX-SPEC.md` cites
by name. It was recoverable only because the scratch copy still existed —
scratch is not durable, so next time it would not have been.

**How to apply.**
1. Prefix every published artifact with its package: `te-build.mjs`, not
   `build.mjs`. The specs already do this correctly (`TE-PRESSURE-SPEC.md`),
   the scripts did not.
2. Before any `cp` into `/mnt/project-files`, `ls` the target name. Treat a hit
   as a collision until you have confirmed it is your own earlier version.
3. Names already taken by other packages as of 2026-09-22: `build.mjs`
   (route mix), `band.mjs` / `bands.mjs` / `classes.mjs` (red zone),
   `screen.mjs`, `marginal.mjs`, `served.mjs` (route mix),
   `rush.mjs`, `kfit.mjs` (efficiency k), `entropy.mjs`, `interval.mjs`
   (calibration), `icc.mjs`, `share.mjs`, `shares.mjs`, `ceiling.mjs`,
   `clean.mjs`, `verify.mjs`, `advteam.mjs`.
4. The same hazard applies to any generic `.json` or `.md`.

Related: /mnt/project-files is also intermittently unreadable and must never be
the only copy of anything.
