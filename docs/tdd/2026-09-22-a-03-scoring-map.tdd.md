# TDD evidence: the ESPN scoring map honours pointsOverrides, un-swaps 24/42, and reports what it cannot score

Work-queue unit A-03. Branch `claude/cloud-a-03-scoring-map`, cut from
`origin/main` at `a3e2bf3` (#158).

| sha | subject |
|---|---|
| `4e5f3c8` | test: RED for ESPN scoring map — D/ST pointsOverrides, 24/42 swap, silent bonus id (A-03) |
| `d3ee33d` | fix: ESPN scoring map honours pointsOverrides by slot, un-swaps 24/42, reports unmapped ids (A-03) |

`d3ee33d` is the last code commit. The commit after it adds only this file.

## 1. Audit (what `scoring.js` did at `a3e2bf3`)

Read: `server/services/scoring.js`, `test/scoring.test.js`, and the three
direct callers of `scoringFor` (`server/services/trade-engine.js:296,1376`,
`server/routes/model.js:431,458,477`, `scripts/weekly-construction-grade.mjs:350`).

1. **pointsOverrides ignored.** `scoringFor` read only `it.points`
   (`scoring.js:64`). ESPN gives slot-specific values in
   `pointsOverrides[<slotId>]`. D/ST items (slot 16) often have `points: 0`
   with the real value in `pointsOverrides['16']`. Read without the override,
   a D/ST line scores almost nothing.
2. **Rushing and receiving swapped.** `24 → rec_yd`, `25 → rec_td`,
   `42 → rush_yd`, `43 → rush_td` (`scoring.js:30-33`). In the public id list
   (espn-api `PLAYER_STATS_MAP`), 24/25 are rushingYards/rushingTouchdowns and
   42/43 are receivingYards/receivingTouchdowns. This went unnoticed because
   most leagues pay the same for both.
3. **Silent drops.** Any statId outside the 9 mapped ones was skipped with
   `continue`. That included bonuses such as 37 rushing100To199YardGame, D/ST,
   K, and ids that are not in the public list at all (the existing fixture
   has 209). Nothing reported them.
4. **Silent fallback.** A payload that failed to parse (bare `catch {}`), or
   one that matched fewer than 4 ids, returned the PPR bucket with no marker.

Caller constraints found in the audit:
- `routes/model.js:433` memoises on `JSON.stringify(scoring)`.
- `weekly-construction-grade.mjs:350` requires
  `JSON.stringify(scoringFor(synthetic)) === JSON.stringify(PPR)`.

So the provenance report must be non-enumerable.

## 2. Change

- `server/services/espn-stat-ids.js` (new): the public ESPN stat-id → name
  table. It has 136 ids, copied from espn-api `espn_api/football/constant.py`
  `PLAYER_STATS_MAP`. ESPN does not publish an official list.
- `scoringFor(lg, { slot })`: each item's points come from
  `pointsOverrides[slot]` when present, and from `points` otherwise.
  24/25 → rush, 42/43 → rec.
- The returned weights carry a non-enumerable `espn` report with these fields:
  - `source`: `league` or `fallback`
  - `reason`: `not-espn`, `no-payload`, `payload-unparseable: …`,
    `no-scoring-items` or `only-N-scoring-ids-matched`
  - `points`: statId → resolved points for the slot
  - `unscored`: ids in the public list that the league pays but `scoreLine`
    has no column for, with id, name and points
  - `unmapped`: ids not in the public list, with id and points
- The bare `catch {}` is gone. A parse failure is named in `reason`.
- `scoreLine`/`scoreSim` are unchanged, and so are `PPR`, `HALF_PPR` and
  `STANDARD`. No migrations.

## 3. RED (`4e5f3c8`, run on a separate worktree at that sha)

The fixtures follow ESPN's `scoringItems` shape (`statId`, `points`,
`pointsOverrides`, `isReverseItem`, `leagueRanking`, `leagueTotal`). No real
league data is used. The D/ST block has 27 items; 20 of them have `points: 0`
with the real value in `pointsOverrides['16']`, matching the proportion in
the unit brief.

```
ok 1..4   (existing tests)
not ok 5 - A-03: D/ST points come from pointsOverrides[16] when scored in the D/ST slot
not ok 6 - A-03: a pointsOverrides entry for an offensive slot changes that slot's weights only   (expected 1.5, actual 1)
not ok 7 - A-03: stat id 24 is rushing yards and 42 is receiving yards, not the other way round  (expected 0.1, actual 0.2)
not ok 8 - A-03: a bonus id the scorer cannot apply is reported by id, not silently dropped
not ok 9 - A-03: a stat id outside ESPN's public list is listed as unmapped
not ok 10 - A-03: falling back to the ppr bucket says so, and still serialises as the bucket
# pass 4
# fail 6
```

Tests 5 and 8-10 fail with a `TypeError` on `.espn` because at `a3e2bf3`
there is no report at all. The overrides were never read, and dropped ids
were never recorded. Tests 6 and 7 fail on wrong values, which is the
behaviour defect itself.

## 4. GREEN (`d3ee33d`)

`node --test test/scoring.test.js`: `# pass 10`, `# fail 0`.

D/ST fixture week (3 sacks, 1 INT, 1 FR, 20 PA, 320 YA):
- slot 16: **7 pts**
- base `points` only: **2 pts**

## 5. Liveness: one killed mutant

Mutant M1 makes `itemPoints` ignore overrides: `return it.points;`.
Result: `not ok 5` (D/ST) and `not ok 6` (TE premium), `# pass 8`, `# fail 2`.
**Killed.** File restored from a copy, and the working tree was checked
against the commit afterwards.

## 6. Guard run

`npm ci` (exit 0). Then one `npm run check` in the foreground, on the clean
tree at `d3ee33d`:

- **exit 0**
- typecheck, lint and wiring passed (wiring: "no missing-feed findings")
- tests: `# tests 4126`, `# pass 4085`, `# fail 0`, `# cancelled 0`,
  `# skipped 41`
- build passed
- start:smoke: "Application startup smoke passed on isolated database (32 teams)"

An earlier check was started, then stopped during typecheck. The working
tree was briefly changed while it ran, when the RED file was checked out to
capture output. That run was discarded and nothing from it is reported. The
RED output above was then captured from a separate `git worktree`.

## 7. What this does not do (updated by the local fixer, section 8)

- Section 8 wires the readers the cloud build left out: `GET
  /api/leagues/:id/scoring`, the sync summary and the Leagues page message,
  and a D/ST scorer that consumes the slot-16 overrides.
- Kickers still have no scorer. Their paid ids (for example 77, 80, 85, 86,
  198) are named as unscored or unmapped on every sync, not applied.
- Yardage-game bonuses (17/18/37/38/56/57), 2-pt conversions (19/26/44) and
  return TDs (101-104) are reported, not applied to player lines. `scoreLine`
  is also called on averaged and projected lines, where a per-game threshold
  bonus would be wrong, and `player_week_usage` has no 2-pt or return-TD
  column.
- 198 and 209 are outside the public id list and are not given names here.
  On the local copy, 198 is non-zero only on kicker lines (defaultPositionId
  5), paying 5 per unit.

## 8. Skeptic fixes (local fixer, own worktree `verify-163-fix`)

The skeptics found four blocking defects at `90fb03b`:

1. The report (`espn.source/reason/unscored/unmapped`) had no reader.
2. `slot` / D/ST resolution reached no consumer.
3. A mutant (`pts !== 0` → `pts > 0`) survived.
4. A call-site mutant survived at `model.js:431` and at `trade-engine.js:296`.

### Change

- `server/services/scoring.js`:
  - `ESPN_DST_SLOT = 16`
  - `scoreEspnStats(stats, points)`: scores an ESPN stat line keyed by stat
    id under the resolved per-id points.
- `server/services/espn-scoring-report.js` (new):
  - `scoringSummary(lg)`: returns `{source, reason, unscored, unmapped}`.
  - `scoringWarning(id, summary)`: one line of text.
  - `espnScoringReport(lg)`: the full report. It scores every rostered D/ST's
    observed week lines (`statSourceId 0`, `statSplitTypeId 1`) at slot 16
    and puts ESPN's `appliedTotal` for the same line beside each one.
- Readers:
  - `GET /api/leagues/:id/scoring` (`routes/leagues.js`), member-gated. It
    selects only `id, platform, ppr, payload`, so no cookie columns.
  - `syncEspnLeague` returns `scoring` (the summary) and calls `console.warn`
    when anything is not applied. This reaches:
    - the `POST /:id/sync` response
    - the scheduled `refreshLeagueRosters` detail
    - the Leagues page sync message (`client/src/pages/Leagues.tsx`
      `scoringNote`)
- No schema change, no migration, and no new table.

### RED (`a0406fe`, tests only)

`test/league-scoring-report.test.js`:

```
not ok 1..4  GET /:id/scoring …   (route absent: HTML 404 body, "Unexpected token '<'")
not ok 5     syncEspnLeague returns the scoring summary …  ("Cannot read properties of undefined (reading 'source')")
# pass 0  # fail 5
```

`test/scoring.test.js` (new test 11, negative unscored id) and
`test/scoring-call-sites.test.js` (4 tests) are guards: they pass on the
implementation and exist to kill the surviving mutants below.

### GREEN

Targeted runs, each with its own temp DB
(`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test test/<file>`):

| file | pass | fail |
|---|---|---|
| `league-scoring-report` | 6 | 0 |
| `scoring` | 11 | 0 |
| `scoring-call-sites` | 4 | 0 |

`tsc --noEmit` exit 0; `scripts/wiring-map.mjs --check` exit 0 ("no missing-feed findings").

### Liveness: mutants, each applied alone and restored

| id | mutant | result |
|---|---|---|
| M-A | `model.js:431` swaps rush_yd/rec_yd at the call site | `scoring-call-sites` not ok 1: **killed** |
| M-B | `trade-engine.js:296` `scoringFor(lg, { slot: 16 })` | `scoring-call-sites` not ok 4: **killed** |
| M-C | `scoring.js` `pts !== 0` → `pts > 0` | `scoring` not ok 11: **killed** |
| M-D | report scores D/ST lines at base points, not slot 16 | `league-scoring-report` not ok 2: **killed** |
| M-E | sync drops `console.warn(warning)` | `league-scoring-report` not ok 5: **killed** |

### Real data (local copy, not production)

- Source: `sqlite3 ~/gridiron-local/data.sqlite ".backup …/fix163-db/data.sqlite"`.
- Read-only `node:sqlite`, `SELECT id, platform, ppr, payload FROM leagues WHERE platform = 'espn'`.
- Leagues are shown by row id only.

| league | source | unmapped | unscored (neg) | D/ST week lines | matched ESPN applied |
|---|---|---|---|---|---|
| #1 | league | 2 [209, 198] | 15 (1) | 8 | 8 |
| #2 | league | 2 [209, 198] | 15 (1) | 10 | 10 |
| #3 | league | 2 [209, 198] | 15 (1) | 9 | 9 |
| #4 | league | 2 [209, 198] | 15 (1) | 10 | 10 |
| #5 | league | 2 [209, 198] | 15 (1) | 11 | 11 |

- **Known-nonzero control:** the same 48 D/ST week lines scored at base
  `points`, without the slot-16 overrides, match ESPN on **0 of 48**.
- The slot-16 read matches on **48 of 48** (within 0.01 pt).
- So the overrides are what make D/ST points right, and the match is not
  coincidental.
- The 17 ids per league (2 unmapped + 15 unscored) are no longer silent.
  They are named on every sync, in the sync response, on the Leagues page and
  in the server log, and the full list is at `GET /:id/scoring`.
- `scoringSummary` equals the route's `unscored` on all 5 leagues.
