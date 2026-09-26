---
name: gridiron-state-1276-2026-09-22
description: "18:47Z-18:58Z forty-seventh batch: Explorer bundle md5 2a0bd577 with MIN(season) per table; NEW PACKAGE nflverse is CC BY 4.0 and the app carries zero attribution → unit to Release (server descriptor) + UI one-line grant, repo has no LICENSE file (Nick observation later); licence-probe rule added; Fantasy plan's R54.3 committed-fixture RED/GREEN (the R33 blind spot was real), held for gate sha"
metadata:
  type: project
  modified: 2026-09-22T19:00:00.000Z
---
(Coordinator asked for this as "state 1274"; 1274 holds batch 45, so this is 1276.)
- **Explorer:** R56 census done; **BUNDLE MD5 NOW 2a0bd577715b961677edc101dd97443a, 49,888 B** (read.mjs 866b0e22ed7b94e1872263fca8e14416); `MIN(season)` added to the freshness probe for every table.
- **NEW PACKAGE** `/mnt/project-files/PACKAGE-NFLVERSE-ATTRIBUTION-2026-09-22.md` ([[gridiron-nflverse-cc-by-attribution]]): nflverse-data is **CC BY 4.0** (master/LICENSE.md 200; nflreadr MIT); the app pulls it (RELEASE `nflverse.js`, REL `nfl-advanced.js:27`, ≥9 tables) with **ZERO attribution** — only `ffopportunity.js:21` has a `data_license`; client mentions are a comment and a status count. The correct pattern exists at `ffopportunity.js:17-23/:89/:127` → **unit routed to Release** (server `NFLVERSE_SOURCE` descriptor) + **UI one-line grant** for the data-sources line ([[gridiron-file-allocation]]). gridiron-hq itself has **NO LICENSE file** (public repo) → Nick observation only, later post.
- **Licence-probe rule** (Explorer): check both LICENSE filenames × master/main/gh-pages before concluding "no licence" → added to [[gridiron-licence-before-measurement-rule]]. The Sharp refusal stands on the restricted-sheet and endpoint legs. Explorer memory: [[gridiron-nflverse-cc-by-attribution]], [[gridiron-name-the-tree-rule]].
- **Fantasy plan: R54.3 done in committed-fixture form.** RED 60dc4f0 (20 tests, 18 pass, 2 fail: aliased import and renamed destructured dynamic import both gave 0 findings — **the R33 blind spot was real**); GREEN d01aac8 20/20 (binding resolution for `as`, `:`, indirect const); namespace case pinned though it passed; three must-NOT-flag fixtures; string bodies stripped; resolver sanity assertion; evidence 771bf64; citation table on `refs/pull/106/head`; guard running on 771bf64, push on DONE; still held for the gate sha.
Prev [[gridiron-state-1275-2026-09-22]]. Next [[gridiron-state-1277-2026-09-22]].
