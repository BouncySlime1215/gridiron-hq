---
name: shrinkage-promotion-execution
description: Operational facts for running the volume-shrinkage promotion — what its gate is sensitive to, whether the script is on the machine, and why it waits for the deploy.
metadata:
  type: project
  modified: 2026-09-19T19:55:00.000Z
---

Companion to [[opportunity-stage-findings]].
This file is only about executing it. Measured 2026-09-19.

**THE VERDICT IS SENSITIVE TO QBR COVERAGE.** `projections.js:230` feeds a QB
head from `nfl_qbr_weekly`. Same gate, three states: empty → passes;
**2021-2026 backfilled → FAILS** condition 3 (2025 gain −0.017, not significant);
2025-2026 only → passes. **Live is the third** (0 rows 2021-2024, 540/2025,
34/2026, read 16:38Z), so it passes today. The fix is directionally right in all
three — the head is better and significant every season, and the QB head *widens*
the head gap (2025: −0.119 → −0.364); only the net ensemble benefit narrows.
**A QBR 2021-2024 backfill must not land before the promotion**, or the gate must
be re-read and may come back false. **Deploying cannot flip it** (verified twice
independently): `nfl_qbr_weekly` is written only by `syncQbr` in `nfl-qbr.js`,
whose one scheduled caller passes `[season-1, season]`. Only a deliberate
backfill does. **Trap:** two exported functions are named `syncQbr` —
`offseason-data.js`'s writes `off_qbr_season` (unrelated) and defaults to
`from=2015`, so grepping the name alone invites the wrong answer either way.

**ffopportunity is NOT an input — measured, don't re-ask.** Three runs changing
only `nfl_ffopportunity_weekly` (2021-2026 / 2021-2025 / empty) gave a
**byte-identical production vector** to 16 significant figures, all five passing
each time. It appears in 2 of 19 files reachable from `weekly-backtest.js`, in
neither case a read. PR #28 and PR #31 are both no-ops here.

**WHERE IT RUNS.** Both scripts go through `server/db/index.js`, not HTTP, so
they need a Fly shell with `GRIDIRON_DB_PATH` set; a run against the wrong copy
is a silent no-op, not an error. **No session here can open that shell:** no
`flyctl`, no `~/.fly`, and GRIDIRON_FLY_TOKEN gets **401 from `api.machines.dev`**
(tested) — an app token, not a Fly platform one. No route lists files.

**Is the script deployed? Unresolved, no longer load-bearing.** Two probes
bracket the build *inside* one commit, impossible for a clean deploy, so the
image may not be built from one and commit archaeology settles nothing. The
diagnostic below answers it directly.

**IT WAITS FOR THE DEPLOY REGARDLESS, verified reason:** the machine runs eleven
heavy jobs on the request thread every five minutes until the release lands, and
the gate is a 90s read-heavy job. The app wedges intermittently (16KB in 35s, a
401 in 1.7s, after 25 min of nothing). PR #15 sits on the stack tip, not `main`.

**The gate announces both hidden dependencies.** Besides QBR it prints row+week
counts per graded season from `player_week_usage` and names any missing: a
half-ingested season (what an OOM-killed sync leaves) was previously graded
silently, returning a verdict indistinguishable from a real one. Counts, never
season names — "has 2024" ≠ "has all of 2024".

**UNVERIFIED PREMISE, flagged 2026-09-19 19:58:** "`shrinkage_fits` and
`shrinkage_k` are empty, so production takes the hand-picked branch" was checked
on the rebuilt database, **not on live** — no route exposes those tables. If live
already holds an active fit, the "before" arm of every number is not what the app
is running and step 2 is an overwrite. Both docs in PR #15 now say so.

**The release plan is `docs/RELEASE-TRAIN-2026-09-19.md` (PR #35).** Promotion is
steps 7-8, after the deploy and after AUTO_HEAVY_SYNC comes off; step 7 is the
dry run as its own step. Its read-only diagnostic (a `node -e` against
`node:sqlite` — `sqlite3` is not in `node:22-slim`) reports both scripts, the
`shrinkage_fits` total AND active counts, `GRIDIRON_DB_PATH` + `/data`, QBR and
ffopportunity per season, and `/app/.git`.
