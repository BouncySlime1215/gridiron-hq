# Every paired comparison in the model chain is clustered, or it refuses

2026-09-20. `server/services/nfl-offseason-change.js`, `server/services/nfl-team-strength.js`,
`test/clustered-comparison-callers.test.js`. On the arm-alignment branch, off `main`.

## The defect this pins is not hypothetical, it has shipped

`pairedBootstrapDiff` degrades quietly by design. It takes `groups` as an option; when the array
it is handed does not line up with the comparison, it falls back to an **ungrouped** resample and
returns an interval anyway. On week-correlated games that interval is narrower than the truth —
`backtest-significance.js` documents that failure mode in its own header — and **nothing in the
returned object distinguishes it from a clustered one.** A caller that meant to cluster and
silently stopped clustering reports more confidence than it has.

That is not a worry about the future. It shipped in `offseason-model.js`, where a lazily built
arm made one value array shorter, the `groups.length === n` guard was satisfied *by the shorter
array*, and the clustered branch ran on a pairing that compared one season's rows against
another's. It inverted the verdict rather than blurring it: a probe on `main` reports the
challenger winning by 0.8 with a 90% interval of [−0.8, −0.8], significant, on a fixture where
the challenger is 0.1 **worse**. `docs/tdd/pooled-arm-alignment.tdd.md` has that measurement.

`clusteredDiff` is the same comparison with the accident removed: it refuses two value arrays of
different lengths, and it **throws** when clustering was asked for and declined, instead of
returning an interval that reads identically to a clustered one. A caller with a genuine reason to
want the ungrouped resample still has `pairedBootstrapDiff`. What it no longer has is the
accident.

## All three call sites are correct today, which is the reason to pin them

Stated plainly, because the alternative is letting a reader think a bug was fixed here. **No
misaligned comparison was found in either file.** Every site builds its error arrays and its
`groups` in lockstep from one source array:

- `nfl-offseason-change.js:297` — `errU`, `errA` and `groups` are all `rowsOut.map(…)`, so they
  are the same length by construction. `:302` is the same shape over `movers`.
- `nfl-team-strength.js:352` — `errA`, `errB` and `groups` are `push`ed together inside one loop
  over `testIdx`, one entry per test game.
- `nfl-team-strength.js:371` — the pooled arrays are extended together at the end of each
  season's block.

The lockstep is one careless `.filter()` away from the shape that already inverted a verdict
elsewhere, and the failure is silent when it happens. A comment asking the next editor to keep
three arrays in step is not a guarantee; a function that throws is.

## Why the test reads the code and not the import line

This project has already been bitten by the weaker version. An earlier test asserted which name
a file **imported** and was satisfied by a file that imported it and then did not use it — a bare
`0.92` with a correct import passed. So this test strips comments and asserts the identifier
`pairedBootstrapDiff` does not appear in either file's **code**, which matters because the prose
in both this file and the test header discusses `pairedBootstrapDiff` by name at length.

`C7` in the table below is that exact shape, kept as a row: add the old import back beside the new
one and change no call. It fails.

## Mutations

Base `nfl-offseason-change.js` = `837e60041816`, `nfl-team-strength.js` = `cb655d262a1c`. Each row
applied alone from the clean base, hashed before and after, before/after text printed by the
runner, both files restored to base at the end.

| # | file | mutation | hash after | result |
|---|---|---|---|---|
| C1 | offseason-change | revert the all-players comparison to the degrading primitive | `80d3914e3b32` | 1 fail |
| C2 | offseason-change | revert the movers comparison | `55e445064329` | 1 fail |
| C3 | offseason-change | drop `groups`, so it would resample ungrouped | `9b40956b8204` | 1 fail |
| C4 | team-strength | revert the per-season comparison | `472fdeafdbee` | 1 fail |
| C5 | team-strength | revert the pooled comparison | `cd53f247300f` | 1 fail |
| C6 | team-strength | drop `groups` from the pooled comparison | `ce3f2448d94c` | 1 fail |
| C7 | offseason-change | keep the guarded import, add the old one back beside it | `6c2efe4590be` | 1 fail |

C3 and C6 are caught by the second test rather than the first: the call still goes through
`clusteredDiff`, which would throw at run time — but only on a path that needs real history to
reach, so the run-time throw is no use to someone editing the file. That test fails at test time.

## Numbers

RED: 4 tests, 2 passed, 2 failed. `offseason-model.js` already passed, having been moved to
`clusteredDiff` with the alignment fix; `nfl-offseason-change.js` and `nfl-team-strength.js` were
the two that did not. GREEN: 4 passed, 0 failed.

Targeted, run the way the harness runs: 68 tests, 61 passed, 0 failed, 7 skipped across
`clustered-comparison-callers`, `nfl-team-strength`, `nfl-offseason-cycle`, `offseason-model`,
`pooled-arms` and `paired-bootstrap-clustering`. The 7 skipped are the fitted-model checks that
report a disposition when real history is absent, via `test/helpers/requires-real-history.js`.

**A false failure worth writing down, because it will catch the next person.** Running
`test/nfl-team-strength.test.js` directly reported **3 failed** — team resolution, the preseason
projection column, and the Rams alias. None of them is a regression and none is caused by this
change: `git stash` and the identical three fail on the clean base. The cause is that `npm test`
sets `GRIDIRON_DB_PATH` to a fresh `mktemp` path and a bare `node --test` does not, so the run
falls back to this container's partially populated database. `realHistoryDisposition` then sees the
tables *present*, declines to report a disposition, and the fitted-model assertions fail on
incomplete data. This is the same family as CLAUDE.md's rule about `npm ci` before trusting any
suite number: **the authoritative figure is `npm run check`, and a standalone `node --test` on a
file that touches fitted models is not comparable to it.**

Full local check `npm run check`: exit 0 — 2,965 tests, 2,924 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database (32 teams). CI is not
consulted: the Actions allowance is spent and the workflow is off.

## The five questions

**Is this well built?** It removes a choice rather than documenting it. There is one guarded
comparison, the callers that need clustering cannot get an unclustered interval by accident, and
the one that genuinely wants the ungrouped resample still has the primitive by its own name.

**Is this based on stats, or is it made up?** The statistics are the whole argument: an ungrouped
resample of week-correlated games understates the interval, and a paired bootstrap on unpaired
rows is not a weaker measurement but not a measurement at all. The inverted-verdict figure quoted
above was measured on `main`, not reasoned about.

**How do we know?** Seven mutations, all failing, including the two that keep the guarded call and
remove only `groups`, and the one that imports the guarded function and uses the old one anyway —
the shape that defeated an earlier version of this kind of test in this repository.

**Should this data be pointed anywhere else on the platform?** Yes, and it is the honest limit of
this change: these are the three call sites allocated to me. Any other caller of
`pairedBootstrapDiff` in the model chain deserves the same treatment, and the test is written as a
list precisely so adding a file to it is one line. Whether a surface should *show* that an
interval was clustered is a separate question and is not answered here.

**How does it unify?** Three hand-rolled comparisons now share one guarantee, expressed once, and
the guarantee is enforced by the function rather than by three comments asking the next editor to
be careful.
