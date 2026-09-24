# AUTOPSY-01: Monday Autopsy team-week producer (`weekly_autopsy`, migration 087)

RED `1d3ee2ce` · GREEN — the next commit · `test/weekly-autopsy.test.js` (12 cases)

## The cause this closes

EVAL E7 ("luck vs decision", `server/services/eval/e7.js` on #235 / #266 head
`9b381bf`) reads `weekly_autopsy` at `e7.js:62`
(`readSource(database, 'weekly_autopsy', COLS)`). No migration on `main` or on any
open branch creates that table (`git grep "CREATE TABLE IF NOT EXISTS weekly_autopsy"`
over every `origin/*` ref: 0 hits before this change). So `common.js:54` returned
`source table weekly_autopsy is not built yet` and E7 could only ever say
"waiting". PROJ-04-a (#251) writes per-player link tables (`projection_autopsy*`,
migration 082), not the team-week rows E7 grades.

After: migration `087_weekly_autopsy.js` creates the table with E7's seven
contract columns, and `server/services/weekly-autopsy.js#runWeeklyAutopsy` fills
it, one row per team per completed ESPN period, for league 4 by default.

## The split

On one basis, ESPN's pregame projection in the league's own scoring
(`league_roster_snapshots.projected_points`, `source = 'final'`), which every team
saw when it set its lineup:

- `decision_points = expected - optimal_expected` (<= 0), where optimal is the
  best legal lineup from the same roster by that projection (`bestLineup` in
  `trade-engine.js` for skill and flex slots, reused, not copied; K and D/ST fill
  only their own slots);
- `luck_points = actual - expected`.

`actual = optimal_expected + decision + luck` exactly. Hindsight (best lineup by
actual points) is stored as `bench_points_lost` for the line only; it is never
in the split.

## RED -> GREEN

RED: `ERR_MODULE_NOT_FOUND ... server/services/weekly-autopsy.js` (pass 0, fail 1).
GREEN: pass 12, fail 0.

| Case | Pins |
|---|---|
| identity | actual = optimal_expected + decision + luck to 1e-9; fixture luck is -7.5, not 0 (control) |
| optimal lineup | decision 0 when the started lineup is the best one |
| flex bench | starting a 6-pt RB in FLEX over an 11-pt WR costs exactly -5 |
| hindsight | a 30-pt bench QB on a 12 projection shows in bench_points_lost, decision stays 0 |
| IR / K / D/ST | an IR-slot player never fills the best lineup; a 30-pt bench K over an 8-pt K costs -22 |
| unknown slot | an unmodelled ESPN slot id leaves optimal NULL and status `unsolved: ...` (E7 skips it) |
| payload slots | lineupSlotCounts parsed; unknown ids named |
| flag | off by default; site flag `GRIDIRON_WEEKLY_AUTOPSY=1` on; preview on + marked; site flag `0` vetoes preview |
| flag off job | writes 0 rows and returns the off reason |
| job | one row per team per `final` period, live-only period skipped, idempotent, E7's columns filled, E7's own formulas reproduce the stored split |
| preview rows | rows written under preview carry preview = 1 |
| unknown league | an error, not an empty success |

## Mutations

Each mutant applied to `server/services/weekly-autopsy.js`, then
`node --test test/weekly-autopsy.test.js` run once.

| Mutant | Result | Killed by |
|---|---|---|
| M1 luck measured from the optimal lineup, not the started one | killed (11/1) | case 10, E7's own formula |
| M2 IR-slot players join the best-lineup pool | killed (11/1) | case 5 |
| M3 call site: the row read takes `source IN ('final','live')` | **survived first**, killed after the test gained a stale live row inside a final week (11/1) | case 10 |
| M4 preview rows written with preview = 0 | killed (11/1) | case 11 |
| M5 K and D/ST dropped from the best lineup | killed (6/6) | case 1 onward |
| M6 call site: the period list drops `source = 'final'` | killed (11/1) | case 10 |
| M7 site flag `0` no longer vetoes preview | killed (11/1) | case 8 |
| C1 designed survivor: `computed_at` fixed to a constant | survived (12/0), as designed: no test reads it | none |
| C2 designed not-applied: the pattern is absent from the file | not applied, 12/0 | none |

M3 surviving showed a gap in the test, not in the code: the only live rows
were in a period with no final rows, so the period filter hid the row filter.
The RED commit's test predates that line; RED was re-run on the tightened test
with the module absent: `ERR_MODULE_NOT_FOUND`, pass 0, fail 1.

## Wiring

`weekly_autopsy` job in `server/services/scheduler.js` (growth tier, off-thread,
daily), plus `scripts/build-weekly-autopsy.mjs` for a hand run.
`node scripts/wiring-map.mjs --check`: exit 1 (`module-reaches-no-surface
server/services/weekly-autopsy.js`) with the script alone; exit 0 with the job.
