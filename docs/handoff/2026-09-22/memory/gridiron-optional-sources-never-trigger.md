---
name: gridiron-optional-sources-never-trigger
description: "Three feeds (nfl_snaps, nfl_ngs, nfl_pfr_adv) refresh only when a core feed is behind; between weekly updates, or when one fails while the core feeds succeed, they fall behind and nothing reports it. NOT \"stale forever\" — Auditor R53.2."
metadata:
  type: project
---
Explorer, 2026-09-22, static analysis on tree `654ff93`. Nothing edited.

**The chain:**
1. `scheduler.js:1021-1022` — the only scheduled writer path, `runNflModelGrowthCycle()` with NO arguments.
2. `nfl-model-growth.js:160` — `force = false` by default. The only `force: true` caller is the route `nfl-betting.js:231`; `nfl-engine-backfill.js` is likewise route-only (`nfl-betting.js:75`).
3. `nfl-model-growth.js:181` — `const coreLag = before.sources.some(s => s.required && !s.current)`.
4. `:185` — `if (before.finalized_week > 0 && (force || coreLag))` wraps syncNgs, syncPfrAdv, syncSnaps, syncDepthCharts, syncInjuries (`:189-196`).
5. `:76-98` — `required: true` only for `game_lines`, `nfl_team_week_features`, `nfl_player_week_features`, `player_week_usage`. `nfl_snaps`, `nfl_ngs`, `nfl_pfr_adv`, `nfl_depth`, `nfl_injuries` are all `required: false`.

**So their own staleness can never trigger their refresh**, and `:126` sets the
status from `lagging.some(s => s.required)`, so optional lag is not even
reported. Silence is indistinguishable from freshness.

**Scope limit:** `nfl_depth` and `nfl_injuries` have a SECOND scheduled writer —
`scheduler.js:829-831` (`syncInjuries`) and `:1166-1167` (`syncDepthChart` from
`routes/nfldata.js`, a DIFFERENT function from `nfl-advanced.js`'s
`syncDepthCharts`; whether they write the same rows is unchecked). The finding is
at full force only for **nfl_snaps, nfl_ngs, nfl_pfr_adv**.

**NOT established:** that any of them IS stale in production. This is
reachability, not availability — "runs only for a reason unrelated to itself",
which is neither "did not run" nor "cannot run" [[gridiron-table-reach-taxonomy]].

**How it gets settled at no extra cost:** `EXPLORER-READ-B-2026-09-22.sh` now
prints a FRESHNESS block in its pristine census — MAX(season), max week within
it, and row count for ten tables labelled REQUIRED vs optional. Read the gap
between the two groups.

**Why it matters:** `nfl_snaps` feeds `nfl-availability.js`,
`nfl-matchup-specialists.js`, `nfl-evidence.js`; `role-changepoint.js:49` reads
`player_week_snaps`. Snap share is how role change is detected.

**If confirmed, the fix is NOT `required: true`** — that would let a late
nflverse release block the whole cycle. Give the optional group its own
staleness trigger and its own reported status.
Package: `/mnt/project-files/PACKAGE-OPTIONAL-SOURCES-NEVER-TRIGGER-2026-09-22.md`.

---

## CORRECTION 18:06Z — two tables I conflated, and a sharper finding

**WRONG: role detection is NOT exposed.** `role-changepoint.js:49` reads
`player_week_snaps`, NOT `nfl_snaps`. `player_week_snaps` has its own scheduled
job — `scheduler.js:1150-1153`, `refreshNflverseSnapCounts` → `syncSnapCounts`
(`nflverse.js:270`). Exposed consumers of a stale `nfl_snaps` are
`nfl-availability.js`, `nfl-matchup-specialists.js`, `nfl-evidence.js`,
`nfl-advanced.js`. I reasoned about "snaps" without naming the table.

**WRONG THE OTHER WAY: `nfl_depth` has NO second scheduled writer.**
`scheduler.js:1164-1167` calls `syncDepthChart` from `routes/nfldata.js:217`,
which hits ESPN's core API and writes `roster_players.depth_slot`/`depth_order`
(`:252`) — never `nfl_depth`. Deliberate: the job header at
`scheduler.js:1156-1162` says nflverse's `depth_charts_2026.csv` is "already
51 MB in week 2" and a timer on a 2 GB machine "is how the OOM kills come back".
So the finding covers FOUR tables at full force: `nfl_snaps`, `nfl_ngs`,
`nfl_pfr_adv`, `nfl_depth`. Only `nfl_injuries` genuinely has a second
scheduled writer (`scheduler.js:826-831`).

**SHARPER FINDING — one upstream file, two ingests, and only the unscheduled
one carries defense/ST.** Both read nflverse `snap_counts/snap_counts_<season>.csv`:
- `syncSnaps` (`nfl-advanced.js:174`) → `nfl_snaps`, key `(season,week,player,team)`
  by name string, keeps offense AND `defense_snaps`, `defense_pct`, `st_pct`.
  **NOT scheduled.**
- `syncSnapCounts` (`nflverse.js:270`) → `player_week_snaps`, key
  `(player_id,season,week)` by name+position lookup, offense only. **Scheduled.**

So defensive and special-teams snap share exist ONLY in the table with no
trigger of its own, and the two tables can disagree about the same player-week
with nothing reconciling them.

**NEAR-HOMONYM PAIRS IN THIS REPO — name the table, never the concept:**
`nfl_snaps` vs `player_week_snaps`; `syncSnaps` vs `syncSnapCounts`;
`syncDepthCharts` (nflverse → `nfl_depth`) vs `syncDepthChart` (ESPN →
`roster_players`). Each pair has one scheduled member and one unscheduled one.

---

## AUDITOR R53.2, 18:03Z — mechanism CONFIRMED, headline CORRECTED

**Do not say "five feeds go stale forever."** That overstates it: the required
sources lag most weeks, which drags the optional ones along, and two of the five
have a second path. **The only wording that may travel:**

> Three feeds (snap counts, Next Gen Stats, PFR charting) refresh only when a
> core feed is behind, and two more have a second path. Between weekly updates,
> or when one of those three fails while the core feeds succeed, they fall
> behind and nothing reports it.

**Taxonomy:** accepted as a WRITE-SIDE AXIS (own trigger / piggyback / hand-run
only / none) that COMPOSES with the reach classes — not a fourth reach class.
[[gridiron-table-reach-taxonomy]]

**Two sub-mechanisms, signatures pre-registered:**
- (i) upstream publishes late → persistent gap of about ONE WEEK, NO error in
  `nfl_model_growth_runs.detail_json.ingestion`.
- (ii) an optional ingest FAILED and is never retried → MULTI-WEEK gap, with an
  ERROR against that step in the same detail.
- A >1-week gap with NO error is neither, and refutes both.

**Anchor on the last `nfl_model_growth_runs.finished_at`, never on today** — the
scheduler brake was on for part of 2026-09-22, so a clock-anchored gap measures
the brake, not the gate.

**Gate unchanged since the deployed commit `c5ee3b54`** (main is `f620a120`):
`git log -L 220,240:server/services/nfl-model-growth.js c5ee3b54..f620a120`
returns nothing, while `git log --oneline c5ee3b54..f620a120 -- <that file>`
returns `f620a12` (#119) — so the FILE changed once and the GATE LINES did not.

**Related new defect on main, routed to Scheduler, not Explorer's:** #119's
`cycleOutcome()` reports `ingest_error` for a failed optional download but its
note says "The scheduler retries it on the next cycle", which is FALSE for an
optional failure when the required sources are current — sub-mechanism (ii).

Bundle carrying all of this: `EXPLORER-READ-B-2026-09-22.sh`,
md5 `982e62581f5019d14f7cf14f9e41d835`, 46,135 bytes.

