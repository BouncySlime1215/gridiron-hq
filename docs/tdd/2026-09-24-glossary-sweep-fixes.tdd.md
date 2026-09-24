# Glossary sweep fixes (FIX-193-2, FIX-193-3)

RED `3e48aebe` "test: pin unsized title_delta noise, season projected_points key, key/name dedupe (RED)" ·
GREEN `c73c0289` "fix: drop unmeasured title_delta figure, add projected_points_season entry" ·
`test/glossary-definitions-match-producers.test.js`, 3 tests added or changed.

## FIX-193-2: the title_delta sentence sized a noise nobody measured

`glossary.ts` said "roughly a couple of points" of the title change is
simulation noise. No run measured that. The pairing defect it describes
(`season-sim.js:313-356`, roster order feeds the draw order) is real; its size
is not known. The figure is removed; the sentence still says some of the change
is noise. The exact-sentence pin is updated, and a new assertion refuses any
digit or size word (`couple`, `few`, `handful`, `point`) in the sentence, so the
figure cannot come back without a measurement being cited.

## FIX-193-3: the season total had no entry and shared the weekly name

`stats.projected_points` (`server/routes/stats.js:98`, ESPN's full-season
projection written by `syncStats()`) is rendered as "Proj pts" on PlayerCard and
StatTable, and had no glossary entry. Its leaf name is the weekly key
`projected_points`. It now has its own entry, `projected_points_season`, raw
`stats.projected_points`, unit points, precision 0 (both pages round it).

The dedupe test is extended: entries are parsed from the source text as
(key, name, raw), and any key or display name that covers two different raw
paths fails. Known-collision controls inside the test: filing the season entry
under `projected_points` is flagged as
`key "projected_points" -> lineup.week_points and stats.projected_points`, and
giving it the weekly display name is flagged too.

## RED (tests at 3e48aebe, glossary.ts at the prior head)

```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp) node --experimental-test-module-mocks --test \
  test/glossary-definitions-match-producers.test.js test/glossary-and-basis.test.js
not ok 15 - no two raw paths share a display key or a display name
not ok 16 - season projected points: stats.projected_points has its own entry under a key that is not the weekly one
not ok 17 - title_delta: the sentence does not promise clean pairing while the paired-seed draw order can still shift between runs
# tests 18  # pass 15  # fail 3
```

## GREEN (c73c0289)

Same command: tests 18 / pass 18 / fail 0. `npm run typecheck` clean.

## Wiring check

`npm run check:wiring` still reports two blocking findings on this branch:
`module-imported-by-nothing` for `client/src/components/ui/BasisChip.tsx` and
`client/src/lib/glossary.ts`. Running the same `scripts/wiring-map.mjs` (from
this branch; #75's tree predates the script) against #75's tree at `64420d39`
with `--findings` reports the same two files as `module-imported-by-nothing`.
So retargeting to #75 does not clear it: C-13 must mount BasisChip on one page
before either PR goes to main.
