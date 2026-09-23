# SY-02 — one code per team: the Rams are LAR, at write time and in reconcile

## Audit

- `server/services/nfl-pbp.js` read `posteam`, `defteam` and `home_team`
  straight from nflverse's CSV. nflverse spells the Rams `LA`. The file had no
  `canonicalTeamCode` import (`git grep -n team-codes server/services/nfl-pbp.js`
  was empty on `main` at `a3e2bf3`).
- The weekly job re-ingests the whole season, so each run wrote `LA` rows
  next to the `LAR` rows that `reconcileHistoricalTeamCodes` had already
  renamed. `nfl_team_week_features` ended a season with 33 teams.
- `reconcileHistoricalTeamCodes` (`server/services/nfl-advanced.js:441`)
  renames with `UPDATE OR IGNORE`. Where `(season, week, 'LAR')` already exists,
  the unique key blocks the rename and SQLite skips that row without an error.
  Every row that has a twin is exactly the row it can't fix.
- `teamWeeks()` in `nfl-pbp.js` already hides an `LA` row that has an `LAR`
  twin on read (`test/nfl-pbp-team-code-dedupe.test.js`). Any code that queries
  the table directly still saw 33 teams.

## Fix

1. The writer puts `posteam`, `defteam` and `home_team` through
   `canonicalTeamCode` (`server/services/team-codes.js:35`) before they key
   anything. The team row, its opponent, the home flag and the player
   team/opponent all come from these three values.
2. Before its generic rename, reconcile finds each legacy
   `nfl_team_week_features` row that has a canonical twin. It merges the two
   feature objects into the canonical row. Where both rows have a key, the
   canonical value wins. Keys that only the legacy row has are kept. Then it
   removes the legacy row, which is now empty of unique data. Rows with no
   twin are renamed as before. Each merge is reported in `changes` with
   `merged_into_twin: true`.

No migration. No change to the schema.

## RED

`77095bc` — `test: RED for SY-02, pbp stores LA and reconcile leaves LA/LAR twins`

`test/sy-02-rams-one-code.test.js`, run on its own: 0 pass, 2 fail.

- Writer test: the stored rows were `team: 'LA'` and `opponent: 'LA'`. The test expected `LAR`.
- Reconcile test: the fixture has 31 teams + LAR + an LA twin + an LA-only
  week. After reconcile it still had 33 distinct teams. The test expected 32.

## GREEN

`aac44f6` — `fix: store one Rams code at pbp write time and fold LA twins in reconcile (SY-02)`

The new test file passes 2/2. With the neighbouring suites
(`nfl-pbp-team-code-dedupe`, `fourth-down-units`,
`formations-possession-team-code`) it passes 13/13.

## Liveness — one killed mutant

The mutant turns the writer's canonicalisation off:
`return v == null ? null : canonicalTeamCode(v);` → `return v;`.
With the mutant, the writer test fails and the reconcile test still passes (1 pass, 1 fail).
So the writer test is what guards the write-time fix. The mutant was reverted
with `git checkout`, and the tree is clean.

## Guard run

See the PR's "Merge gate" §1 for the `npm ci` + `npm run check` exit code and
test counts on this tree.
