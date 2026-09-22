---
name: gridiron-v2-satellites-absent
description: v2 is a STUDY-ONLY copy whose own header says no v2 family ships; it reads three gitignored satellites absent from a fresh clone, and participation ingest is gated on season<=2023 in the job that runs.
metadata:
  type: project
---

Measured 2026-09-22 in a fresh cloud clone.

**The dependency.** `nfl-weekly-feature-store-v2.js:81-85` reads
`data/line-history/nflverse.sqlite`, `data/line-history/line_history.sqlite`
and `data/derived/player_value.sqlite` (env-overridable). All three are
**gitignored and untracked**: `data/line-history/.gitignore` is `*.sqlite`,
root `.gitignore:75` excludes `data/derived/`, and `git ls-files data/` returns
exactly one path — that .gitignore. A Fly build starts from the same clone.

The code is honest about it (`satellite()` :92-106 catches, :469-471 and :500
report), but the degraded path is the ONLY path off whichever machine built
those files, and ~40 columns — coverage, personnel, pressure, box, motion, RPO,
screen — then never appear.

**SCOPE — READ THE HEADER (`:1-17`).** A **STUDY-ONLY copy** serving
`scripts/backfill-feature-store.mjs` and `scripts/grade-feature-vector.mjs`
against `data/derived/feature-store-study.sqlite`. Its recorded verdict: **"no
v2 family ships (man/zone, deviations and O-line took zero weight; the
871-feature ridge gain did not survive a bootstrap), so production stays on
v1."** man/zone was already tested and took zero weight; "making v2 deployable"
is not a goal.

**Read the module header first.** `--include=*.js` hid both importers, which
are `.mjs` ([[a-grep-finds-a-pattern-not-a-shape]]) — but the header says
"NOTHING in **the server** imports this file" (true; both are under `scripts/`)
and names them. The lesson is the header, not the glob.

**THE REAL FIND (integration thread's, not mine):** `nfl-model-growth.js:200`
is `if (season <= 2023) await attempt('formation_participation', () =>
ingestFormations(season), ...)`. Participation ingest is **gated on
season <= 2023** in the job that actually runs — the same false belief as the
`nfl-formations.js` comment. Two free seasons dropped on a wrong constant.
`ingestFormations`/`ingestCharting` ARE invoked, in four places plus a test
(`nfl-model-growth.js:200-201`, `routes/nfl-betting.js:1545-1546`,
`scripts/nfl-2022-2025-rebuild.mjs:132,137`); "never called" was wrong.

**The satellite subset IS rebuildable from files we already fetch** (useful
even though v2 is not shipping): 2,174 team-weeks, REG 2022-2025, from
participation + FTN joined to pbp, 100% fill, validated against known league
values (11 personnel 0.58-0.63, box 6.0-6.4, pressure 0.29-0.31). Four of its
columns come from the five `ingestFormations` throws away
([[gridiron-participation-not-dead-after-2023]]). Rates there are flat means
over team-weeks, not pooled over plays — a 0.006 difference on 2024; state the
scheme or the number means nothing.

**Zero is not missing in these files.** Four columns halve or double if the
dropback gate is wrong, participation includes special teams, and of the two
obvious `NULLIF` fixes one is wrong. Numbers and checks:
[[zero-is-not-missing-in-participation]]. I shipped the `was_pressure` version
of that bug here and fixed it.

**How to apply:** lift the `season <= 2023` gate at `nfl-model-growth.js:200`
— the files are there (2022-2025 all HTTP 200/206; only 2026 404s, which is
the current season and normal). Then widen `nfl_play_formations`
by the five columns. Then point v2's personnel/coverage/pressure/FTN families
at the repo's own tables. Do NOT claim this retires the satellites: nobody has
checked what else `line_history` and `player_value` carry, and a real
implementation must reproduce v2's earlier-than-cutoff leak discipline
(`:69-77`), which the prototype does not. **Anything touching v2 must first
answer the outage at [[gridiron-v2-outage-version-bump]]** — a version bump
rebuilds every vector synchronously on the request thread.

Spec: `ADVTEAM-SPEC.md` + `adv-team-week.jsonl` + `advteam.mjs`.
