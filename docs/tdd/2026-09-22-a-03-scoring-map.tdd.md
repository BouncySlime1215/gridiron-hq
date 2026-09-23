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

## 7. What this does not do

- No caller passes `slot` yet, and nothing in the app scores a D/ST or K
  line. The slot-resolved `espn.points` map is ready for a D/ST scorer, but
  this PR does not add one.
- `espn.unscored` / `espn.unmapped` are not yet shown in the UI or API. That
  is the next unit.
- Yardage-game bonuses (17/18/37/38/56/57) are reported, not applied.
  `scoreLine` is also called on averaged and projected lines, where a
  per-game threshold bonus would be wrong.
