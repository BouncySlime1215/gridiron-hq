# Two evidence generators wrote a finished report from constants

RED `6475d73` · GREEN this commit · `scripts/lib/evidence-report.mjs` (new),
`scripts/run-purged-evaluation.mjs`, `scripts/run-historical-leaderboard.mjs`,
`test/evidence-report-guard.test.js`, `test/evidence-generators-guard-write.test.js`

The generator-coverage sweep from this thread found eight committed artifacts
written by scripts no test runs. These are two of them, and they are the two
whose output later work cites as measurement.

## What was wrong

**`run-purged-evaluation.mjs`.** The bet-ledger universe is built by reading the
backfilled trial registry, and then two rows are pushed unconditionally:

```js
betLedgerTrials.push({ id: 'audit_registry#1',  bets: 84, wins: 36, losses: 48, ... });
betLedgerTrials.push({ id: 'audit_registry#14', bets: 57, wins: 33, losses: 24, ... });
```

They are literals in the source file, appended after the loop and outside any
condition. So when the registry read returns nothing — an empty scratch
database, a backfill that failed and still exited 0, a renamed `kind` — the
cross-section is still non-empty, a deflated Sharpe ratio is still computed over
those two rows, `purged-evaluation-report.json` is still written, and the script
still exits 0. Nothing in the run says the statistics came from two constants.

**`run-historical-leaderboard.mjs`.** No such constants, and it "survives" the
same emptiness only by accident: `:142` calls `sharpeByTrial.reduce((a, b) => …)`
with no initial value, which throws `TypeError: Reduce of empty array with no
initial value` — two lines after `sharpeMean` has already become `NaN` from a
`0/0`. A TypeError out of a reduce is not a guard. It names no cause, and it is
silent in the case this script exists for: `audit_registry` returning zero rows
while Group C returns some. That run produces a complete leaderboard that has
quietly collapsed back into stage 2's hand-picked subset — the one thing the
script was written to fix — and says so nowhere. **That case is not
hypothetical; it is what this repository's own database does today, measured
below.**

## Why a hardcoded output path is part of the same defect

Both wrote to `docs/evidence/2026-09-13/` with no way to redirect. Every trial
run overwrote the committed report it would have been checked against, so no
run could be compared to anything — which is precisely why neither had ever been
exercised. `--out` is not a convenience here; it is what makes the rest of this
file possible. Same shape as the fix already shipped for `scripts/inventory.mjs`.

## The fix

A generator declares the sources it read, with counts, and which of them must be
non-empty. `scripts/lib/evidence-report.mjs` holds three exports:

- `assertEvidenceSources(sources, required, what)` — throws
  `EmptyEvidenceSourceError` naming **every** empty required source. Called early
  in both scripts, before the reduce, so the opaque TypeError is replaced by a
  named cause.
- `writeEvidenceReport({ outDir, filename, report, sources, required })` — asserts
  **before** the `mkdir` and the write, then stamps `sources` into
  `registry_summary`. The only way a report leaves either script.
- `resolveOutDir(argv, fallbackDir, base)` — `--out`.

Three decisions worth stating, because each could reasonably have gone the other
way:

- **Absent counts as empty.** A required key that was renamed or never wired up
  reads as `undefined`; treating that as "not checked, therefore fine" is how
  the silent version of this defect returns.
- **Constants are recorded, never required.** `constant_bet_ledger_trials` and
  `pbo_strategies_constant` count literals in the source. They are always
  present, so requiring them would assert nothing and would fire on a correct
  run — and a gate that fires on correct runs is a gate somebody deletes.
- **Require where emptiness is invisible; record where the zero already shows.**
  The four census reads in the leaderboard (`ensemble_fit_artifacts_read`,
  `pick_decisions_read`, `quote_tape_books_read`, `line_snapshot_groups_read`)
  already print their own zero on the face of the report, so they are recorded
  and not required. The registry and `audit_registry` reads do not, so they are.

The committed reports were **not** regenerated. They predate the stamp and their
numbers are untouched.

## Measured: six real runs

Run against a **migrated copy** of `server/data.sqlite`:
`cp` to the scratchpad, then `GRIDIRON_DB_PATH=<copy> node scripts/migrate.mjs`,
which applied **63 migrations** (001 through 062) and brought the copy to the
schema production has. `GRIDIRON_REAL_DB_PATH` points at that copy, `--out` at a
scratch directory.

The migration step is not incidental. The primary `server/data.sqlite` here has
**one** row in `schema_migrations` — `000_legacy_schema` — so every numbered
migration is unapplied on it, and a harness that opens it directly measures a
database production never has. Runs 1 through 4 below were made before that was
established, against a copy whose four missing tables had been created by hand;
runs 5 and 6 repeat the two that matter on the properly migrated schema and
reach the same verdict for the same reason. Both are kept, with what each one
actually ran against stated.

Before and after every run, `sha256sum -c` on `server/data.sqlite` and both
committed reports: **OK, all three, every time.** Nothing was migrated in place.

**Run 1 — purged, hand-completed copy.** Exit 1, nothing written, the
output directory not even created:

```
EmptyEvidenceSourceError: purged-evaluation-report.json was not written:
1 required source(s) came back empty -- db_derived_bet_ledger_trials.
All declared sources: {"trial_registry_rows_read":27,"scored_trials_read":26,
"standardized_effect_sequence_length":26,"db_derived_bet_ledger_trials":0,
"constant_bet_ledger_trials":2,"sharpe_cross_section_trials":2}
```

Read that cross-section: **2 trials, both of them the constants.** The registry
backfilled fine — 27 rows, 26 scored — and Group C returned nothing, so the
deflated Sharpe ratio this run was about to publish would have been computed over
two literals in the source file. Before this commit it would have been written,
and the run would have exited 0.

**Run 2 — purged, one seeded Group C row.** Exit 0, report written to `--out`,
with the counts stamped in:

```json
"sources": { "trial_registry_rows_read": 28, "scored_trials_read": 27,
  "standardized_effect_sequence_length": 27, "db_derived_bet_ledger_trials": 1,
  "constant_bet_ledger_trials": 2, "sharpe_cross_section_trials": 3,
  "pbo_strategies_constant": 4 }
```

A cross-section of 3 of which 2 are constants is now a fact on the face of the
artifact rather than a thing you learn by reading the generator.

**Run 3 — leaderboard, hand-completed copy.** Exit 1, nothing written:

```
EmptyEvidenceSourceError: historical-leaderboard-report.json was not written:
2 required source(s) came back empty -- audit_registry_rows_read,
audit_registry_bet_ledger_rows. All declared sources:
{"trial_registry_rows_read":28,...,"group_c_bet_ledger_trials":1,
"audit_registry_rows_read":0,"audit_registry_bet_ledger_rows":0,
"sharpe_cross_section_trials":1}
```

**This is the run that matters most.** `sharpeByTrial` had one element, so the
`reduce` at `:142` would not have thrown. The old code would have completed,
written a leaderboard whose entire stated purpose — generic extraction over the
real `audit_registry`, catching ids 9, 13 and 15 that stage 2 hand-picked past —
had returned nothing at all, and exited 0.

**Run 4 — leaderboard, seeded `audit_registry` (3 rows: one `{bets,wins,losses}`,
one `{record:"W-L"}`, one with no ledger).** Exit 0, report written, both real
extraction shapes exercised, the non-ledger row correctly excluded
(`audit_registry_rows_read: 3`, `audit_registry_bet_ledger_rows: 2`), and all
four census reads honestly stamped as `0`.

The seeded rows are synthetic and labelled as such. They demonstrate control flow
reaching the write path; **they measure nothing** and no number from runs 2 or 4
should be quoted as a result.

**Runs 5 and 6 — both generators, migrated copy, real schema, no seeding.**
Both exit 1, both write nothing.

```
purged-evaluation-report.json: 1 required source(s) came back empty
  -- db_derived_bet_ledger_trials
  {"trial_registry_rows_read":27,...,"db_derived_bet_ledger_trials":0,
   "constant_bet_ledger_trials":2,"sharpe_cross_section_trials":2}

historical-leaderboard-report.json: 4 required source(s) came back empty
  -- group_c_bet_ledger_trials, audit_registry_rows_read,
     audit_registry_bet_ledger_rows, sharpe_cross_section_trials
  {"trial_registry_rows_read":27,...,"sharpe_cross_section_trials":0}
```

Run 5 reproduces run 1 exactly on the correct schema: the cross-section is 2 and
both of them are the constants. Run 6 is the four-empty-sources case, and it is
where the old leaderboard would have thrown `Reduce of empty array with no
initial value` — one unnamed TypeError in place of four named causes.

## Three findings that fall out of the runs, not fixed here

1. **This clone's `server/data.sqlite` is at migration `000_legacy_schema`.**
   `schema_migrations` holds exactly one row while `server/migrations/` holds
   63 files. Tables created by 012, 023 and 024 — `nfl_teaser_executions`,
   `nfl_teaser_execution_legs`, `nfl_execution_opportunities`,
   `nfl_candidate_findings` — are therefore absent, and
   `run-purged-evaluation.mjs` dies in step 1 of 4 with
   `no such table: nfl_candidate_findings`. **A first reading of that error as
   "the repository cannot build these tables" was wrong**, and is recorded here
   because it is the same mistake in a different coat: a missing precondition
   reported as a data fault. The generators have no migration check; a database
   63 migrations behind is indistinguishable, from their output, from a schema
   that does not exist.
2. **The data, unlike the schema, really is absent.** On the fully migrated
   copy, `audit_registry`, `nfl_candidate_input_audits` and
   `nfl_candidate_robustness_audits` all exist and all hold **0 rows**. The
   committed report's 55 registered trials came from a database this clone does
   not have; the same backfill produces 27 here, all from sources that are
   literals in `backfill-historical-trial-registry.mjs` rather than reads.
3. Therefore **the committed `31.785` and everything beside it cannot be
   re-derived from anything in this repository**, migrations applied or not.
   Whether those numbers are statistically sound is a separate question and
   belongs to the Auditor; this is only the observation that nothing here can
   regenerate them. Per the allocation, the committed numbers were not touched.

## Defect injection

Baseline `scripts/lib/evidence-report.mjs` sha256 `66e092c4a36b…c718cab1`,
8/8 in `test/evidence-report-guard.test.js`; generators `c048af4810b6…` and
`410e99075a47…`, 4/4 in `test/evidence-generators-guard-write.test.js`.

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| M1 | zero counts as real (`v > 0` → `v >= 0`) | `83080c3328ec…` | **6 pass / 2 fail** | `an empty required source refuses the write…`, `the error names every empty source…` |
| M2 | only the first required source is checked | `1661849c57b3…` | **6 pass / 2 fail** | `the error names every empty source…`, `a required source that is absent entirely counts as empty` |
| M3 | assert AFTER the write instead of before | `3c13d924b0bc…` | **7 pass / 1 fail** | `an empty required source refuses the write, and writes nothing at all` |
| M4 | an absent source is treated as fine | `9e6baa870f71…` | **7 pass / 1 fail** | `a required source that is absent entirely counts as empty` |
| M5 | `--out` swallows the next flag as a directory | `153f40051f3d…` | **7 pass / 1 fail** | `resolveOutDir honours --out, and falls back when it is not usable` |
| M6 | stamping overwrites `registry_summary` instead of merging | `dbb4724a4a6b…` | **7 pass / 1 fail** | `a report built from real sources is written, with the source counts stamped in` |
| M7 | control: a comment above `isRealCount` | `d24a5e93ccbd…` | 8 pass | — (no-op by construction) |
| G1 | purged: a second, unguarded `writeFileSync` beside the guarded one | `d2c490ab9abc…` | **3 pass / 1 fail** | `run-purged-evaluation.mjs writes its report only through the guard` |
| G2 | leaderboard: the same | `4e1492ca39c7…` | **3 pass / 1 fail** | `run-historical-leaderboard.mjs writes its report only through the guard` |
| G3 | purged: drop `resolveOutDir`, hardcode the path again | `6e16ee5d9d6d…` | **3 pass / 1 fail** | `run-purged-evaluation.mjs takes --out…` |

Nine mutations, nine killed, each by a test written for it. M3 is the one the
whole design turns on: a guard that asserts after `writeFileSync` has already
published the artifact it was guarding. G1 and G2 exist because a structural
test that nothing can break is not a test — they confirm a second write beside
the guarded one is caught.

M7's checksum differs from the baseline while its result does not, so no green
row here is the harness failing to apply an edit. Every file was restored to its
baseline checksum afterwards and re-verified.

## An assertion that was written wrong twice, recorded because the shape recurs

The test for "the error names every empty source" first asserted
`doesNotMatch(err.message, /sequence_length/)` — that a healthy source appear
nowhere in the message. That is wrong: the message dumps every declared source
with its count, and that dump is the useful half, because `sequence_length: 26`
is exactly what tells a reader the problem is elsewhere. The second attempt
sliced the message on `--` to check only the cause clause, which is the
fixed-window parse this thread has spent the night removing from other people's
code: `split('--')[1]` keeps the entire tail, so it re-reads the whole message
and proves nothing. Both were dropped. The cause list is compared exactly as
`err.emptySources`, which is structured data and needs no parsing at all.

## What this does not prove

The structural test asserts the generators route their write through the guard.
It does **not** prove the counts they pass are real row counts rather than
literals; a script could pass `{ x: 1 }` and satisfy it. That is settled by the
four runs above and by nothing in the suite, stated here so the structural test
is not quoted as more than it is.

## The five questions

- **Well built?** The guard is on the write path by construction rather than
  beside it, it fails before creating anything, and it names every cause at once.
  Twelve tests; nine mutations killed.
- **Stats or made up?** Measured. Six real runs, quoted from their own output,
  with the source database and both committed reports checksummed unchanged
  before and after each one, and the two decisive runs repeated on a properly
  migrated schema. The seeded rows are labelled synthetic and no number from them
  is quoted as a result.
- **How do we know?** The injection table, plus runs 3 and 6 — this project's
  own database reproducing, today, the exact silent case the old code had no
  answer for.
- **Pointed anywhere else on the platform?** Yes. Six of the eight committed
  script-written artifacts had producers no test ran; two are closed here, the
  `inventory.mjs` pair was closed earlier, and the rest were routed to their
  owners. The three findings above are inventory work and go back to item 5.
- **How does it unify?** Same lesson as the fixed-window class: a fallback that
  keeps a pipeline running past an empty input is a decision to publish a number
  nobody measured. CLAUDE.md names this exact failure — a layer goes inert and
  the surface keeps printing numbers as if nothing had happened. A constant in
  the source file is a layer going inert that never even had to fail.
