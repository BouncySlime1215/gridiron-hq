# TDD evidence: the current-season participation 404 is a skip, and prior seasons have a named backfill

Work-queue unit R-02 (plan item 21, pipeline fragility). Branch
`claude/local-r-02-formations-ingest-404`, cut from `origin/main` at `bd56319b`
(#128). Re-audit findings on #119, #87 and #92
(`~/gridiron-local/reaudit-2026-09-22.json`, not in the repo).

Status of this file: **audit, licence gate and extend-or-build decision,
committed before the first test.** RED, GREEN, mutation sweep and numbers are
added in later commits on this branch.

## 1. Audit: what already exists for this surface (tree `bd56319b`)

| piece | where | what it does today |
|---|---|---|
| table | `nfl_play_formations` (`server/db/schema/nfl-a-to-m.js`, columns widened by migration 070) | one row per play: formation, personnel, box, rushers, time to throw, pressure, coverage |
| the only writer | `ingestFormations` `server/services/nfl-formations.js:65`, `INSERT ... ON CONFLICT DO UPDATE` at `:86` | downloads one season of `pbp_participation_<season>.csv`; on any non-OK status returns `{ error, note }` at `:68-75` instead of throwing |
| scheduled caller | `runNflModelGrowthCycle` `server/services/nfl-model-growth.js:247` | `attempt('formation_participation', () => ingestFormations(season))`, inside the download branch gated at `:227` (`finalized_week > 0 && (force \|\| coreLag)`). `season` is `availableSeason()` (`:53-56`): `NFL_SEASON`, else `MAX(game_lines.season)` = 2026 |
| step recorder | `attempt` `nfl-model-growth.js:149-153` | stores the returned object as-is, so a returned `{ error }` is recorded exactly like a throw |
| verdict | `cycleOutcome` `nfl-model-growth.js:168`, filter at `:177-178` | any ingestion step with `.error` makes the run `ingest_error` with a note calling derived data stale |
| scheduler | `server/services/scheduler.js:1416` job `nfl_model_growth` (6 h, off-thread) -> `refreshNflModelGrowth` `:1008` | runs the cycle |
| manual route | `POST /api/nfl-betting/formations/ingest` `server/routes/nfl-betting.js:1541` (season defaults to 2023 at `:1544`) | runs `ingestFormations` + `ingestCharting` inside the server process; bearer session required |
| hand-run script | `scripts/nfl-2022-2025-rebuild.mjs:129` | still filters `value <= 2023` before calling `ingestFormations`, so it never loads 2024 or 2025 (the gate #92 removed from the cycle survives here) |
| existing tests | `test/growth-cycle-outcome.test.js` (#119), `test/growth-participation-season-gate.test.js` (#92) | #119 pins "a step with `.error` is `ingest_error`"; #92 pins "the cycle attempts participation for 2024 and 2099". Neither covers the two together |
| frozen consumer | `freezeTeamFeatureVector` `server/services/nfl-weekly-feature-store.js:193`, early return of an existing row at `:196`; formation history read by `teamHistory` `:145-154` | a vector already frozen for (season, week, team, version) is returned unchanged; the table has `BEFORE UPDATE` / `BEFORE DELETE` abort triggers (`server/db/schema/nfl-n-to-z.js:874-876`) |

**The defect, as the re-audit found it and as this tree still has it.** #92
(`6e722719`) removed the `season <= 2023` gate so the cycle now calls
`ingestFormations(2026)` on every download cycle. nflverse returns 404 for
2026. `ingestFormations` returns `{ error: 'participation for 2026 returned
404', note }`; `attempt` stores it; #119's `cycleOutcome` counts it as a failed
download. So every in-season cycle that downloads ends `ingest_error`, for an
absence the code's own comment (`nfl-model-growth.js:241-246`) calls "one
honest line in the ingestion detail rather than a failure".

**The gap behind it.** The cycle only ever asks for its own season, which is
never published while the season is being played (see the licence text below:
"provided after all post-season games are completed"). Out of season the
download branch does not run (no `coreLag`). So the scheduled job can never
fill `nfl_play_formations`, and the only other paths are the manual POST
(season defaults to 2023) and the rebuild script (gated to `<= 2023`). On a
fresh local copy of the production DB, `nfl_play_formations` has **0 rows**
(numbers and commands in section 5).

## 2. Licence gate (read 2026-09-22, before any row was measured)

Probe, `curl -s -o /dev/null -w "%{http_code}"` on
`raw.githubusercontent.com/nflverse/nflverse-data/<branch>/<file>`:

| branch | LICENSE | LICENSE.md | LICENSE.txt | COPYING | README.md |
|---|---|---|---|---|---|
| master | 404 | **200** | 404 | 404 | 200 |
| main | 404 | **200** (byte-identical to master, `cmp` exit 0) | 404 | 404 | 200 |
| gh-pages | 404 | 404 | 404 | 404 | 404 |

- `nflverse-data/master/LICENSE.md`, first line: "Attribution 4.0 International" (CC BY 4.0).
- `nflverse-data/master/README.md` (699 bytes): no licence or dataset-specific terms.
- Release page `github.com/nflverse/nflverse-data/releases/tag/pbp_participation`: "Participation data for plays from NGS".
- **Dataset-specific terms, `nflreadr.nflverse.com/reference/load_participation.html`:**
  "Participation data from 2023 onwards is courtesy of FTN and is provided after
  all post-season games are completed. This data is released under the CC-BY-SA
  4.0 Creative Commons license and attribution must be made to FTN Data via
  nflverse (from 2023 onwards) or NFL NextGenStats via nflverse (for 2022 and
  earlier)."

**Verdict: usable, with attribution.** The participation files carry stricter
terms than the repo-wide CC BY 4.0: CC BY-SA 4.0, attributed to "FTN Data via
nflverse" (2023+) or "NFL NextGenStats via nflverse" (2022 and earlier). Free,
no personal-use clause, no paywall. **Open obligation, not closed by this
unit:** `git grep -n -i "FTN Data\|CC-BY-SA\|NextGenStats via"` over
`server client/src scripts` finds nothing, so the app shows this attribution
nowhere. FTN charting (same FTN terms) is already ingested on the timer at
`nfl-model-growth.js:248` with the same gap. Standing rule 10 says CC BY data is
usable only once attribution is visible, so the production backfill should wait
for that line (a Nick / coordinator call, listed under known defects).

The same text is the documentary source for the fix: the current season is not
published until its post-season ends, so a 404 for the cycle's own season is the
expected state, not a failed download.

## 3. Extend or build

**Extend, no new store.** Every piece already exists; what is wrong is the
interaction between #92 and #119 and the missing way to load a completed season.

1. `ingestFormations` (`nfl-formations.js:68-75`): **extend** the non-OK return
   with machine-readable `season` and `http_status` fields. It keeps returning
   `error` for every non-OK status, because the route and the rebuild script
   both treat `error` as a failure and a 404 for a completed season (2016-2025
   are published) should stay loud there.
2. `nfl-model-growth.js:247`: **extend** the call site. The cycle's season is the
   one being played, so a 404 for it becomes a recorded skip
   (`skipped: true, absence: 'not_published'`) with no `error` key. Any other
   status, or a throw, stays a failure. The judgement lives with the caller that
   knows which season is in progress; the writer only reports the fact.
3. `cycleOutcome` (`:168`): **extend** so a skipped step is counted as a skip,
   named in the `ok` note and returned as a field, never as a failure.
4. Prior seasons: **build one thin named command**, not a timer.
   `scripts/backfill-formations.mjs <season>` loads one season through the
   existing writer and prints 2022-2025 row counts. Not on the timer because a
   completed season is a 49-50 MB CSV parsed in memory (`res.text()` then
   `split`), the same size class as the nflverse depth CSV that standing rule 13
   says OOMs the 2 GB production machine. Peak memory is measured below rather
   than assumed.
5. Team-vector re-freeze: **document, not bump.** See section 6.

Not touched (other threads' files or out of scope, reported instead):
`scripts/nfl-2022-2025-rebuild.mjs:129` stale `<= 2023` gate; the missing
attribution line; the route's 2023 default.
