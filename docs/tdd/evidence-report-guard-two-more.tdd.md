# The other two evidence generators, and a guard that stopped dictating format

RED `52df4f9` · GREEN this commit ·
`scripts/lib/evidence-report.mjs`, `scripts/freeze-baseline.mjs`,
`scripts/joint-score-report.mjs`, `test/evidence-report-guard.test.js`,
`test/evidence-generators-guard-write.test.js`

`docs/tdd/evidence-report-guard.tdd.md` closed
`run-purged-evaluation.mjs` and `run-historical-leaderboard.mjs`. These are the
other two the write-only sweep named. Same defect class, two new wrinkles.

## Wrinkle one: the guard was dictating the output format

Both of these serialise on purpose. `freeze-baseline.mjs` ends its file with a
newline. `joint-score-report.mjs` post-processes its JSON so the per-game rows
stay one line each — the object form pretty-printed to 580KB and 31,000 lines,
which is not an evidence file anyone opens. Neither has a `registry_summary` to
stamp counts into.

A guard that takes those away is a guard a generator routes around, and then it
is not on the write path at all. So `writeEvidenceReport` now takes `stampAt`
and `serialize` from the caller. The serialiser receives the **stamped** report,
so the counts cannot be computed, checked and then dropped on the floor, and it
does not run at all when a required source is empty — the refusal comes before
anything is rendered.

Measured: `joint-score-report.mjs`'s output through the guard is **1,927 lines
and 135KB**, with 680 per-game rows on one line each. The formatting survived.

## Wrinkle two: `freeze-baseline.mjs` already had guards, and they did not cover it

Two preconditions were there: `!truth.size` throws, `!proj.size` throws. The one
that was missing is the one that produces a finished artifact. `ids` is the
intersection of three conditions:

```js
const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
```

All three inputs can be non-empty while the intersection is empty. Then every
`gradePoint` call errors, `.filter(x => !x.error)` removes every row, and the
file is written with `players_graded: 0`, an empty `table`, a real git commit
and a real `dataset_hash`. A baseline nothing was measured against, pinned as
the thing later work has to beat.

**`datasetHash` is not a guard against that**, which is the part worth keeping:
it hashes whatever the two queries return, and an empty result set has a
perfectly stable digest. A fingerprint tells you the data changed. It cannot
tell you there was data. So the function now counts the rows as well as hashing
them.

## Measured: four real runs

**Run 1 — `freeze-baseline.mjs 2025`, against a scratch database seeded so that
every one of its existing preconditions passes.** 12 players, 8 weeks of the
prior season each, 2 weeks of the graded season each. Exit 1, nothing written:

```
EmptyEvidenceSourceError: …/2025-baseline.json was not written:
3 required source(s) came back empty -- common_player_set, table_rows,
distribution_samples.
{"players_rows_read":12,"player_week_usage_rows_read":120,
 "graded_season_players":12,"projected_players":12,"prior_season_players":12,
 "common_player_set":0,"table_rows":0,"distribution_samples":0}
```

Read the left half: 12 players read, 120 usage rows read, 12 in the graded
season, 12 projected, 12 in the prior season. **Every existing check passes.**
The graded intersection is empty because nobody played four games. That file was
about to be frozen.

**Run 2 — the same database, the graded season topped up to 9 weeks each.**
Exit 0, written to `--out`, `common_player_set: 12`, `table_rows: 4`,
`distribution_samples: 12`.

**Run 3 — `joint-score-report.mjs --fixture --scoring gaussian --test-seasons
2022,2023`.** Exit 0 in 34s, 272 aligned games, 6 comparison pairs, report
written with its formatting intact.

**Run 4 — the same run with `aligned.joint_gas` emptied by injection**, one line
before the sources are built, to prove the guard is on this script's write path
with real data flowing rather than only in its unit tests. Exit 1, nothing
written, and the declared sources show everything else still real:

```
1 required source(s) came back empty -- aligned_games.
{"test_seasons_requested":2,"challenger_seasons_fit":2,"aligned_games":0,
 "methods_aligned":5,"comparison_pairs":6,"same_game_correlations":272}
```

The injection was reverted and the file's checksum restored to `2ba5e60cffcd…`.

**What is NOT shown, stated plainly.** On a genuinely empty database
`joint-score-report.mjs` dies earlier, at `[incumbent] FAILED: no component
prediction records supplied`, before reaching this guard. That is an existing
check doing its job, and it means the guard's real-data refusal is demonstrated
by injection rather than by an unaided run. `freeze-baseline.mjs` on this
repository's own `server/data.sqlite` also dies earlier — `players` and
`player_week_usage` both hold **0 rows**, so its pre-existing `!truth.size`
throw fires first. Hence the seeded database in runs 1 and 2. The seeded rows
are synthetic and measure nothing.

## Who reads these two artifacts — and one correction

The sweep's framing was that neither file has a reader. That is right for one and
wrong for the other, so:

- **`docs/evidence/baselines/2025-baseline.json` has no reader.** Confirmed by
  grep over `server client scripts test`: every code reference under
  `evidence/baselines` points at a *different* file,
  `2025-weekly-distribution-draws.json`, and all three are comments
  (`weekly-learning.js:183`, `fit-weekly-coverage.mjs:29`,
  `test/weekly-retrain-coverage.test.js:8`). Nothing reads a `*-baseline.json`.
- **The joint-score report does have a programmatic reader.**
  `scripts/governed-reevaluation.mjs:212-213` does `JSON.parse(readFileSync(…))`
  on both `joint-score-report-football.json` and `-gaussian.json`, and names them
  again at `:496-497`. What `nfl-joint-score.js` cites by string at `:107` and
  `:922` is `JOINT-SCORING-STAGE-3.md`, the markdown — a different object.
  `governed-reevaluation.mjs` is itself a hand-run script with no importer and no
  `package.json` entry, so CONTRACT.md's `hand-run-script` reach applies: real,
  and much weaker than a route.

Both readers keep working: the default output paths are unchanged, and
`governed-reevaluation.mjs` reads by fixed filename.

## Two tests that were wrong first, both the same mistake in different costumes

1. **`test/inventory-generate-path.test.js` spelled out the legal statuses.**
   Adding `wired-betting-only` broke it — a failure caused by the vocabulary
   growing, not by the artifact being wrong. It now runs the generator's own
   `check()` over the written rows. A copy of a vocabulary is a copy that goes
   stale.
2. **The structural test asked `scan().code` whether a script contains
   `value('out'`.** The `code` view blanks string bodies, so `'out'` is blank
   there, and a correct file failed. `resolveOutDir(` is a call and belongs to
   `code`; the flag name is a string and belongs to `text`. This is the same rule
   this thread's own producer sweep once got backwards, reporting zero artifacts
   in a repository full of them.

## The five questions

- **Well built?** The guard now fits four generators without any of them giving
  up its own output format, which is what keeps it on the write path. 19 tests
  across the two files.
- **Stats or made up?** Measured. Four runs quoted from their own output, the
  135KB/1,927-line formatting check, the 0-row counts on this repository's
  database, and the reader greps.
- **How do we know?** Run 1 is the defect on data where every pre-existing check
  passes; run 4 is the injection proving the wiring, reverted with its checksum
  restored.
- **Pointed anywhere else on the platform?** The sweep found eight committed
  artifacts whose producers no test ran. These are the last two of the four in
  `scripts/` that this thread owns.
- **How does it unify?** `datasetHash` is the clearest version of the whole
  class: a fingerprint that is stable on nothing, doing duty as a check that
  there was something.
