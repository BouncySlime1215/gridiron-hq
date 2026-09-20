# Second readings: every thread's evidence file, re-run by someone else

The model evidence audit thread is standing second reader for the other
threads' `docs/tdd/` evidence files (coordinator, 2026-09-20). This is the log
of what was re-run and what came back. It exists because a mutation table is a
claim about a machine, and a claim about a machine is worth exactly as much as
the next person's ability to reproduce it.

## The five questions

**Is this well built?** It adds no code. It re-runs other people's evidence in
a detached worktree at their exact commit and writes down the numbers.

**Is this based on stats, or made up?** Neither — it is measurement. Every
figure below came out of a run on this machine, not out of the file being
graded.

**How do we know?** Because nothing here is taken on report. Where a thread
stated a number, the number was re-measured; where a thread stated a mutation,
the mutation was re-applied to a clean tree and its SHA-256 checked on both
sides. Where a reading of mine was wrong, the correction is in this file under
my name, not quietly dropped.

**Should this data be pointed anywhere else?** Yes, and it already is: each
finding went to the thread that owns the file, and the parts of the standard
these readings produced are now project-wide.

**How does it unify?** One evidence standard, applied the same way to ten
threads, so "tested" means the same thing on every surface of the platform.

## Method

Detached `git worktree` at the exact commit, `node_modules` symlinked from the
main checkout, `npm ci` never re-run into a graded tree. Mutations applied one
at a time by a runner of mine, not by the authors' scripts, which I did not
read; SHA-256 (first 12) recorded before and after, so a pattern that fails to
match is reported NO-OP rather than read as green. Every file restored and its
hash re-verified. No server file was edited on any branch: this thread edits
none, and every worktree was removed afterwards.

## Whole suites, re-measured

Each claimed by its own evidence file; each re-run here. **Every one matched.**

| commit | thread | measured: tests / pass / fail / skipped |
|---|---|---|
| a7ac178 | fantasy plan | 2,960 / 2,919 / 0 / 41 |
| b1ee48d | fantasy plan | 2,966 / 2,925 / 0 / 41 |
| ec13adb | Trade Brain | 2,954 / 2,913 / 0 / 41 |
| 52a55cc | wiring map | 2,969 / 2,928 / 0 / 41 |
| 775e339 | Opportunity | 2,961 / 2,920 / 0 / 41 |
| 9fce773 | fantasy plan | 2,975 / 2,934 / 0 / 41 |
| c6df372 | UI | 2,964 / 2,923 / 0 / 41 |
| f62896e | Coach | 3,093 / 3,052 / 0 / 41 |

Per-file counts re-run and matched: a7ac178 7/7 · b1ee48d 6/6 · 1ed7b79 12/12 ·
01645a0 9/9 · 52a55cc 6/6 (RED 6 / 0 pass / 6 fail at 84bae8a) · 9fce773's
availability-basis 9/9 · the outlook patch 5/5 (RED 5 / 1 / 4) · ec13adb 4/4
(RED 4 / 4 fail at 799e83f) · 775e339 8/8 · dd84efa 12/12 across two suites.

## Mutation tables, re-applied

Reproduced hash-for-hash and red-for-red: all seven B-rows at 9fce773 (base
`51fe1716`) · all six at 52a55cc (base `bca51a0250ee`) · six of eight at
775e339 (bases `28bffcd49d70`, `6de130fcae48`) · four of eight plus both
controls at dd84efa · two of five on the outlook patch (base `41f996e06dae`) ·
row 1 of 1e6a205 (`0d825e8efc97` → `a4b2a3e5`) · M4 at 761af34
(`51fe1716` → `9b794700`, 0 fail, as claimed).

Rows that did not reproduce by hash all did so for one reason: the row
described its edit instead of quoting it, so I wrote a different expression of
the same mutation. In every such case the fail count and the named red test
still matched. That is the whole evidence for the eighth part below.

## What the readings changed

Five additions to the evidence standard came out of these runs.

- **Sixth part** — an unkilled mutation is declared EQUIVALENT with its reason,
  or counted SURVIVING and named with the test that would kill it. Silence on
  one reads exactly like an untested line.
- **Seventh part** — the mirror: a test that no mutation turns red gets a
  killing row or a stated reason. From 52a55cc, where the killed-by union was
  {1,2,3,4,5} and test 6 was red for nothing. It is killable, so it was a
  missing mutation and not an untestable test: `if (usage_coverage.stamp_disagrees)`
  → `if (true)` (`bca51a0250ee` → `5dd1178ded6d`) gives 3 pass / 3 fail, red on
  4, 5 and 6. That matters because the check renders on every page through
  `DataSetupBanner`, so test 6 was all that stood between a healthy feed and a
  false "reports success but holds no rows".
- **Eighth part** — quote a mutation's exact before/after text, never describe
  it. Of 18 rows re-run independently by the Opportunity thread, 5 after-hashes
  were underivable from the description and 3 needed a second attempt; 3 of my
  8 rows at dd84efa diverged the same way. Every claim held. But a described
  edit can only be confirmed, never re-run, and re-running is what the hashes
  are for.
- **Two control kinds, named separately** — a KILL-CONTROL (must break
  something, proving the suite can fail) and a NO-OP CONTROL (a pattern that is
  absent, proving the harness can report a miss). Several files had one and
  called it the other.
- **Identify a test by its title, never its ordinal**, and name the test FILE
  beside the title where a table spans two suites.

## Findings raised against specific files

Each is stated **as of the commit named**. Several are already answered on hold
branches this log has not yet re-read; a finding here is a reading of one tree,
not a standing claim about the thread.

- **wiring map, `wiring-map-route-deletions.tdd.md`, as of 8307d09** — states
  `test/wiring-map.test.js 62/62` and reports its RED proofs by ordinal
  ("test 62 … fails; 61 pass"). At that exact commit the file is **64 tests,
  64 pass**: the RED was measured on a tree two tests behind the one cited.
  Re-run at head and name both by title.
- **fantasy plan, `player-week-memo-fit.tdd.md`, as of 9fce773** — byte-identical there,
  so its `2,966 / 2,925` line is stale against that head's measured
  `2,975 / 2,934`. A file carried unchanged onto a new head carries its old
  numbers with it.
- **Part 5 was the weakest-enforced part of the standard**, as of the heads read
  up to 2026-09-20 11:23Z — a full check with
  numbers, in the file, is missing outright in five files and stale in two.
  One sweep proposed: every thread states the numbers **and the commit they
  were measured on**. Adopted project-wide the same day, so this row is a
  record of what was found, not an outstanding complaint.

## Corrections to my own readings

Both found by re-running rather than by argument, and both recorded here
because a second reader who hides their misses is not a second reader.

- I reported the `u.disabled_at IS NULL` mutation at c986b80 as SURVIVING. It
  does not survive. Section 3 of that file has **three** tables: the first is a
  historical before-state measuring the suite as it stood, and the RED table
  below it closes the hole. Deleting the guard moves
  `server/platform/auth.js` `b816ff37cf3c` → `9afb499a0669` and gives 22 tests
  / 21 pass / **1 fail**, on the test that names it
  (`test/google-sign-in.test.js:361`). The fault was mine: I graded a section
  before finishing it, which is the exact failure this log exists to catch.
- I over-credited c986b80 on part 5. Its §6 states only that `npm run check`
  was "recorded with the commit", and neither its commit message nor
  da8ec48's carries a count.

## This log's own check

The rule this log applies to everyone else applies to it. Every figure above
names the commit it was measured on, per row. The log itself was written
against **861bbd8** on `claude/project-thread-w0gpjt-hold`, where `npm run
lint` is clean across 878 JavaScript files and `npm run typecheck` is clean.
No whole-suite figure is claimed *for this branch*: it adds documentation and
one script that reads nothing, and the suites quoted above are other people's
trees, each named.

Where a head is documentation-only over a code head, the suite figure is the
code head's and is reported against it. That is not an assumption here — it
was checked with `git diff --name-only`, which returns nothing outside `docs/`
for 1171d66 → c986b80 → da8ec48 → 511eed8, for 572e838 → 22bbd45, and for
e852884 → 64cb90e. The suite, build and smoke never read `docs/`, and lint
walks `server`, `scripts` and `test`.

## What this log does not cover

- **Cross-file mutation claims.** Where a table asserts that an edit breaks
  tests in other files, only the targeted suite was re-run here. The clearest
  case is memo-fit's M5, which cites 54 failures elsewhere; that number is
  unverified in this log.
- **The numbers a model produces.** This log pins whether a test can fail and
  whether a stated figure reproduces. It says nothing about whether a
  projection is any good — that is the model audit's job, in
  `MODEL-AUDIT-2026-09-20.md`.
