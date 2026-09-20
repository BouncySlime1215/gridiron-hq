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
Where a head is documentation-only over a code head, the figure is the code
head's and stands for the whole chain: 511eed8 is also a2e7f97, 1e8dddd,
da8ec48, c986b80 and 1171d66; 64cb90e is also e852884.

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
| dd84efa | Opportunity | 2,962 / 2,921 / 0 / 41 |
| 511eed8 | Google sign-in | 2,985 / 2,944 / 0 / 41 |
| 22bbd45 | chat sync | 3,002 / 2,961 / 0 / 41 |
| 64cb90e | scheduler | 3,054 / 3,013 / 0 / 41 |
| 00b4c28 | fantasy plan | 2,979 / 2,938 / 0 / 41 |

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
- **My own docs-only check was unsound**, and it took a false pass to show it.
  It was `git diff --name-only A B | grep -v '^docs/'` with the exit swallowed,
  so **an absent commit produced an empty diff and read as "docs-only"** — a
  check that cannot tell "verified clean" from "never ran", which is the exact
  fault this log exists to catch in other people's evidence. It now resolves
  both commits first and requires a non-empty diff. All twelve pairs vouched
  for before the fix were re-verified afterwards and every one holds, so no
  reported figure changed; the method was unsound even where its answers were
  right, and those are worth separating.
- I over-credited c986b80 on part 5. Its §6 states only that `npm run check`
  was "recorded with the commit", and neither its commit message nor
  da8ec48's carries a count.

## Coach at 4e93e98: every row sound, under half the suite covered

Coach's harness is the best in the project. `docs/tdd/sweeps/*.json` carries
each injection as literal `old`/`new` text, so its table rows are generated
from the exact patch rather than describing it; it reports **NOT APPLIED
(anchor xN)** when a pattern matches more than once, which is the failure mode
that produced a false "caught" elsewhere; and it restores by bytes and proves
the restore by hash. Twenty-two of its rows were re-run here against three of
its files and **every hash and every fail count reproduced exactly** — the
lexicon's five, the grading file's nine, the tool layer's eight.

Its prose is equally careful: three grading mutations survived a first pass and
say so, each with the fixture the new test needed, and M69 is recorded as a
deletion — a guard that could not be made to fire, removed rather than kept —
which is the sixth part applied better than anywhere else in the set.

**The gap is the seventh part, and it is systematic.** Union the tests each
sweep's rows turn red, subtract from the suite's own test list:

| sweep | tests | turned red by no row |
|---|---|---|
| grading | 12 | **2** |
| lexicon | 12 | **7** |
| tool layer | 17 | **10** |
| ask | 23 | **12** |
| catalog | 31 | **12** |
| ledger | 28 | **11** |
| person | 24 and 18 across two overlapping pairings | **21 distinct** |

Across the six sweeps that count cleanly, **54 of 123 tests are turned red by
nothing** in their own evidence file. Person is listed separately because
`coach-person-variables.test.js` appears in two of its rows' suite strings, so
its two lines share tests and cannot simply be added.

**Why the RED commits do not close this, and the point generalises.** The tool
layer's RED is recorded as "suite written against a module that does not exist;
0 pass, 1 file erroring on import". That is red for every test at once, for one
reason, so it shows nothing about any individual test's ability to fail on its
own terms. Coach builds new modules, so every RED it writes has that shape.
**Where the RED is module-absent, the injection table is not a supplement to it;
it is the only per-test evidence in the file**, and the seventh part therefore
applies to every test in the suite rather than only to the ones a row aims at.

**These are gaps, not equivalent mutants.** Checked rather than asserted, three
killing rows supplied, each red on exactly its own test:

- `toRows: nothing at all is no rows, not a row of nothing` — return a row of
  `null` instead of none for null/undefined: `e9a0aeca` → `79430a5c`, 1 fail.
- ``toRows: an array of scalars becomes a row each, under `value` `` — key the
  rows `item`: `e9a0aeca` → `adceb1c0`, 1 fail.
- `grading reports every computed variable, with the people behind each grade` —
  `n_people: pairs.length` → `n_people: String(pairs.length)`:
  `ef500418` → `ba61d7e2`, 2 fail.

**One test cannot be closed that way, and it is the sharpest finding in this
log.** `the split is on time, not on message count, and the report says where it
fell` names the headline decision of `grading.js`, whose docstring argues it at
length: a split by message count would put a chatty person's early half months
away from a quiet person's, so half the signal would be the calendar. The test
body asserts that `split` equals the 0.7 constant, that `split_at` is truthy,
and that it matches `/^\d{4}-\d{2}-\d{2}/`. A count-based split returns an ISO
timestamp too. Replacing the time cut with a genuine count cut moves
`ef500418` → `5de823f7` and gives **12 pass / 0 fail**: the suite survives the
exact thing the test is named to prevent.

The shipped code is correct in every one of these cases — `splitAt` is
time-based, `toRows` is right, `tools.js` is right. The claim is the narrower
one this log exists to make: these tests have never been shown capable of
failing. Closing them is writing rows, not fixing code.

## D34's fix, verified — and the guard that does not guard it

Fantasy plan fixed D34 at `5674cf1` while this log was being written. The fix is
right: a new `pooled-arms.js` keys every pooled row by `season|team|player_id`,
so the two arms come out equal-length and aligned by construction and the
offseason model cannot produce the D34 shape again. `comparison_basis` on every
interval and an `arm_coverage` report mean a reader can see which rows were
actually compared.

**The layer described as catching this does not catch it.** `clusteredDiff`
throws when clustering was *declined*; D34 is the case where clustering is
*granted* on a misaligned pairing, because `groups.length === n` holds when
`groups` is sized to the shorter array. Run against the fixed tree:

```
clusteredDiff(A = 60 rows, B = 30 rows, groups = 30)
  -> RETURNED, did not throw
     mean_diff -0.8  ci90 [-0.8,-0.8]  significant=true  clustered=true  n=30
  truth: the challenger is WORSE by +0.10 on the only season it ran
```

`pairedBootstrapDiff` was changed to *report* — `clustered` is now on every
return — not to *refuse*. No length-equality check was added. Today no caller
can reach it, since the offseason model goes through the new pooling layer, so
this is defence in depth and not a live bug. One line closes it for every future
caller: refuse when `valuesA.length !== valuesB.length`.

## Coach changed a test instead of the code, and it holds up

`CLAUDE.md` permits this only when the test is wrong, so it is the one change in
the set that needs a verdict rather than a reproduction. At `0b8e77d`, "every
catalogued table exists in the schema" became "…unless only a script creates
it", because three catalogued tables are genuinely absent until a script runs.

**The premise is enforced, not asserted.** A separate test requires that a table
the declared schema does not create says who does, and that one it does create
says nothing; the file check requires a named file that exists **and contains
that table's literal `CREATE TABLE IF NOT EXISTS <name>`**.

**Both escapes the exemption could open were tried here, and both are caught:**

- a fabricated table whose creator points at a real, existing script file —
  `be236c57` → `fc49c32c`, 1 fail, on the file check, because that real script
  carries no DDL for the invented name;
- a fabricated table naming no creator at all — `be236c57` → `cc5815d1`,
  3 fail, the changed test among them.

So the replacement is strictly stronger than what it replaced: the old test
caught "catalogued but absent", the new pair catches "catalogued, absent and
nothing builds it" and "claims a builder that does not build it". All nine of
that file's mutation rows reproduce exactly. **Verdict: the change stands.**

**A correction, mine.** The first M71 run here gave 3 red where the table claims
4. That was this harness, not their table: the spec names two suites and only
one was run, and the fourth red lives in the other. Re-run against both, it is
4. Recorded because a second reader's unexplained number costs more than the
check saves.

## This log's own check

The rule this log applies to everyone else applies to it. Every figure above
names the commit it was measured on, per row. The log itself was written
against **861bbd8** on `claude/project-thread-w0gpjt-hold`, where `npm run
lint` is clean across 878 JavaScript files and `npm run typecheck` is clean.
No whole-suite figure is claimed *for this branch*: it adds documentation and
one script that reads nothing, and the suites quoted above are other people's
trees, each named.

Where a head is documentation-only over a code head, the suite figure is the
code head's and is reported against it, checked with `git diff --name-only`
rather than assumed.

**"The suite never reads `docs/`" is false, and the correction matters.** Five
tests open a file under `docs/` at runtime: `deep-dive.test.js:26`,
`stat-table.test.js:22`, `stat-block.test.js:23` and
`design-system-tokens.test.js:28` all read `docs/design/design-system.md`, and
`nfl-execution-integrity.test.js:258` reads `docs/CLAUDE-NEXT-STEPS.md`. So the
rule is about two FILES, not about a directory: a documentation-only head
carries its parent's figure unless it touches one of those two.

```
git diff --name-only <parent> <child> | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'
```

Empty output means the child inherits. Every equivalence relied on in this log
was re-checked against that command and none touches either file, so every
carried figure stands. Lint walks `server`, `scripts` and `test` and matches
`.js`/`.mjs`, so its count is
`git ls-tree -r --name-only <commit> -- server scripts test | grep -cE '\.(js|mjs)$'`
— a bare repo-wide `ls-tree` gives a different, wrong number.

## A fault in this log's own harness, found and fixed

Measurements in this log run in detached worktrees driven by shell scripts that
queue one commit after another. Between 11:46Z and 12:17Z I repointed three of
those scripts onto new heads with `sed -i`, and told the coordinator the
repoints had landed. **They had not.** `sed -i` writes a new file and renames it
over the old one; a shell already executing the old one keeps its open file
descriptor and keeps reading the original bytes. The scripts on disk said one
thing and the running processes were executing another.

The tell was a result line: chain 5 reported `4e93e98`, which is where it
started, not the `0b8e77d` I had moved it to. Reading each process's own script
back out of `/proc/<pid>/fd/255` — the descriptor the shell holds open — showed
what each was really carrying:

| chain | on disk | actually held | started? |
|---|---|---|---|
| 6 | `ee923ae ef28768` | `6a8df0d ef28768` | yes — a full suite already spent on `6a8df0d` |
| 7 | merge target `23ed6da` | merge target `4389a7a` | no |
| 8 | `0fbba41` | `f61f5d4` | no |
| 9, 10, 11 | — | as on disk | — |

Chains 9, 10 and 11 were never edited mid-run; their descriptors are not marked
`(deleted)`, and that marker is how the three bad ones were told from the three
good ones. Seven and eight were stopped and relaunched from new files.

**No figure in this log is affected.** Every suite number here was reported with
the commit it was measured on, and that pairing came out of the run itself. What
was wrong was my account of what was still to come — a forecast, stated as a
fact.

The rule, on the record: **a running script is never edited in place.** A
repoint is a new file under a new name, and the target a process holds is read
back from its own descriptor, not from the disk.

## Pass A — control characters

Every `.js` and `.mjs` file under `server/`, `scripts/` and `test/`, at the head
of all 130 remote branches. Flagged `00`-`08`, `0b`, `0c`, `0e`-`1f` and `7f`;
tab, newline and carriage return excluded. 878 files per tree.

**One hit in the whole sweep**, and it is in the wiring map's own checker:

```
scripts/wiring-map.mjs
  claude/wiring-map-8f96ur            :246
  claude/wiring-map-8f96ur-census-hold:289
  claude/wiring-map-8f96ur-route-gate-hold (23ed6da):289
```

`od -c` on the line gives `( / \b ( [ A - Z a - z _ $ ]` — the character after
the opening slash is a single `0x08` byte, a literal backspace, where the two
characters `\` and `b` were meant. At the time of the sweep it was fixed on no
branch in the repository; the wiring map pushed the fix as `d38a65c` fifteen
minutes later, and that head is clean under the same sweep and carries the line
as `/\b([A-Za-z_$][\w$]*)\s*\(\s*$/` at `:304`. On every head that predates it
`viaHelper` is always `null`, and the two lines below it are dead:

```js
const viaHelper = before.match(/<BS>([A-Za-z_$][\w$]*)\s*\(\s*$/);
if (viaHelper && APP_HELPERS.has(viaHelper[1])) return { handle: 'app', where: null };
if (viaHelper && foreign.has(viaHelper[1])) return { handle: viaHelper[1], where: foreign.get(viaHelper[1]) };
```

Every query reached through an app helper falls through to "could not
attribute" instead of being attributed. That is a classification defect in the
tool that produced the route verdicts.

**Measured, both directions**, in a detached worktree at `23ed6da`,
`node --test test/wiring-map.test.js`, baseline `b36d8493f9d7` → **75 / 75 / 0**:

| row | injected | sha256 after | result |
|---|---|---|---|
| **M-D1** | both `if (viaHelper && …)` lines deleted outright | `717edb2d1121` | **75 pass, 0 fail** |
| **M-D2** | the `0x08` byte replaced by the two characters `\b`, i.e. the fix | `310daf1dbeeb` | **75 pass, 0 fail** |

Deleting the branches changes nothing and repairing them changes nothing, so the
helper-attribution path is invisible to the suite in **both** directions. The fix
needs a test that fails before it and passes after it, or it lands unwitnessed.

## The wiring map's re-measured table, graded

`docs/tdd/wiring-map-route-deletions.tdd.md` at `23ed6da`. The file answers the
earlier hard finding against it — the RED proofs that were measured two tests
behind the tree they cited, and named by ordinal. It re-measures by title, with
a checksum each side. Re-run here at `23ed6da` in a detached worktree.

The table cites `58e311e` as the tree it was measured on while the file ships at
`23ed6da`. Those are different commits, so the citation was checked rather than
assumed: `scripts/wiring-map.mjs` is `b36d8493f9d7` at both, and
`test/wiring-map.test.js` is `0fd0ef741089` at both. The table's tree and the
delivered tree agree on both files under test.

**Baseline reproduces exactly**: `b36d8493f9d7`, 75 tests, 75 pass, 0 fail.

| row | their claim | reproduced here |
|---|---|---|
| **A2** | `a564bc04561d`, 74 pass / 1 fail, *a call wildcard and a route parameter cannot excuse each other in opposite positions* | **exact.** `return !(routeVarOverCallLiteral && callVarOverRouteLiteral);` → `return true;` gives `a564bc04561d` to the digit, 74 / 1, that test red |
| **A1** | `63eebe1ffc5e`, 74 pass / 1 fail, *outboundUrlPaths sees a path that starts the string, not only one that follows a marker* | **result yes, hash no.** Both readings of "the six-line leading-literal scan is removed" give 74 / 1 with that exact test red — four code lines `6dda1739c3a1`, seven lines with the comment `4f600f939090` — and neither is `63eebe1ffc5e` |
| **A3** | `f69a77e681d8`, 75 pass / 0 fail, "one comment reworded" | **claim holds, label wrong.** A comment-only edit here moves the hash to `7529036609a5` and leaves 75 / 0, so the substance is right |

Two findings, both narrow.

**A1 is the eighth part earning its keep.** A2 was describable without ambiguity
and landed on their hash first try. A1 was described rather than quoted, and the
description does not fix how many lines go, so the row's *effect* is confirmed
and its *patch* is not reproducible. A hash whose input cannot be reconstructed
grades the same as no hash. Quote the patch.

**A3 is not a NO-OP control.** In this project a NO-OP CONTROL is a pattern that
does not exist, reporting `NO-OP — pattern not found` with the hash unchanged;
it exists to prove the matcher can fail to find something, which is the fault
the scheduler caught at 02:02Z — a baseline wearing a mutation's name. A3's hash
*changed*, so it applied. It is the other control kind: an applied edit that
correctly kills nothing. Their own prose gets this right ("a green result is not
this harness failing to apply an edit"); only the label is the wrong one of the
two. As it stands the set has no row proving the matcher can miss.

**And the diff is not comment-only.** I was told
`test/health-route-single.test.js` differs from `main` by twelve lines of block
comment inside an existing `/** */`, with no `test()` added. The `test()` count
is right — three at `791b131` and three at `23ed6da`. The rest is not. It is 27
added lines, the comment opens its own `/*` rather than joining an existing
`/** */`, and the body changed:

```
-    found.push(`${relative(ROOT, file)}:${line} → ${match[3]}`);
+    found.push(`${relative(ROOT, file)} → ${match[3]}`);
...
-    ['server/index.js:86 → /api/health'],
+    ['server/index.js → /api/health'],
```

The assertion no longer pins the registration's line. On the merits that is
defensible and their comment argues it well — a second registration still lands
as a second array element and still fails, and the line survives in the failure
message. But "comment-only" is the description under which a weakened assertion
passes a second reading unexamined, and this one is a weakened assertion.

## Pass B — regex alternation branches that match nothing

**Method.** Not one suite run per branch. A preload wraps `assert.match` and
`assert.doesNotMatch` and records every `(regex, subject)` pair that actually
reaches them, so one instrumented suite run captures every real fixture; each
alternation branch is then re-tested alone against the subjects its own
assertion saw. The pattern is walked character by character, honouring escapes,
character classes and nesting, so branches inside a group are found too, and a
group's `(?:`, `(?=`, `(?<!` prefix is carried onto each branch. Run on this
tree (`main` plus this log), **2,950 tests, 2,909 pass, 0 fail, 41 skipped** —
the instrument changes no result.

**25 assertion sites carry an alternation. 49 branches tested, 32 live, 17
dead.** Six `doesNotMatch` sites are excluded: there every branch matches
nothing, by design, so the method says nothing about them.

A branch is listed here when **no subject that assertion ever saw** matches it.
That is a statement about the test, not about the code: it means the suite never
exercises that branch, so deleting it would go unnoticed. Some are correct
hedges. This is a list, not a verdict.

| file:line | pattern | branch that matched nothing |
|---|---|---|
| `test/availability-honest-degradation.test.js:178` | `/pooled\|injury report/i` | `injury report` |
| `test/availability-honest-degradation.test.js:192` | `/not the fitted\|not running\|pooled/i` | `pooled` |
| `test/giacomini-white.test.js:117` | `/collinear\|no variance\|not finite/` | `not finite` |
| `test/model-integrity.test.js:845` | `/^(unavailable\|[a-f0-9]{40})$/` | `unavailable` |
| `test/nfl-execution-edge.test.js:441` | `/no_games_near_this_line\|no_qualified/` | `no_qualified` |
| `test/nfl-t60-packet.test.js:660` | `/mirror\|mismatch\|non-mirrored/i` | `mismatch` |
| `test/page-explain.test.js:138` | `/not staked\|not acting\|no real money/i` | `not staked`, `no real money` |
| `test/polymarket-fill-study.test.js:130` | `/discarded\|thrown away\|fetched by captureOrderBooks/` | `discarded` |
| `test/trade-acceptance.test.js:354` | `/0\.1\|less than\|below/i` | `below` |
| `test/trade-proposals.test.js:194` | `/could not be read\|malformed\|parse/i` | `malformed`, `parse` |
| `test/trade-proposals.test.js:477` | `/cut off\|ran out of (output )?room\|output limit/i` | `output limit` |
| `test/trade-route-retirement.test.js:61` | `/\/api\/\|trade-engine/` | `trade-engine` (5 subjects, all `/api/…`) |
| `test/valuation-map.test.js:433` | `/1 .*(week\|sample)\|below/i` | `sample`, `below` |
| `test/valuation-map.test.js:483` | `/manager signals\|no manager data/i` | `no manager data` |

At least one is a hedge that should stay: `model-integrity.test.js:845` accepts
either a 40-character SHA or the literal `unavailable`, and the second branch is
for a tree with no git. It is dead here because this tree has git. That is the
shape of a correct hedge, and it is why these go to owners as a list.

**What the pass does not reach.** Fourteen alternation sites use `.test(` or a
bare `RegExp` rather than `assert.match`, and the instrument does not see them.
Six `doesNotMatch` sites are out of scope for the reason above. And the run is
on `main`'s tests, so a thread's own new tests are covered when its head comes
through the queue, not here.

## The wiring map's backspace fix, graded

Pushed as `d38a65c` while pass A was being written up. Re-run here in a detached
worktree, `node --test test/wiring-map.test.js`.

**Baseline reproduces exactly**: `8d8bfba36af9`, 78 tests, 78 pass, 0 fail.

| row | their claim | reproduced here |
|---|---|---|
| **M1** | `ed770da07307`, 76 / 2, killed by "77, 78" | **exact.** Putting the `0x08` byte back gives `ed770da07307` to the digit and 76 / 2, red on *a bare call on a foreign handle is attributed to that handle, not the app* and *the checker source holds no control characters* |

The fix is real and it is now witnessed in both directions, which is what M-D1
and M-D2 above said it needed. Two things against the table, both about form.

**The killers are named by ordinal again.** "killed by 77, 78", "killed by 76",
"killed by 57". This is the finding that was raised against this thread's
`wiring-map-route-deletions.tdd.md` and fixed there — A1 and A2 now name their
tests by title. The new file reverts to the ordinal, and an ordinal moves the
moment a test is inserted above it. The titles are in the run above; they cost
nothing to write down.

**M4 is not a NO-OP control, for the same reason A3 is not.** "NO-OP CONTROL:
one word of a comment changed", hash `a8684f00d900`, changed from the baseline —
so it applied. A NO-OP control is a pattern that is *not found*, hash unchanged,
proving the matcher can miss; this is the other kind, an applied edit that
correctly kills nothing. The prose is right both times and the label is wrong
both times, which makes it a habit rather than a slip. Neither file currently
has a row proving its matcher can fail to find a pattern.

Their two declared open items — `viaMethod` has no row, and `foreignDefault()`
takes the first foreign handle in a file — are declared in the right form: an
open item, not a claim of coverage.

## What this log does not cover

- **Cross-file mutation claims.** Where a table asserts that an edit breaks
  tests in other files, only the targeted suite was re-run here. The clearest
  case is memo-fit's M5, which cites 54 failures elsewhere; that number is
  unverified in this log.
- **The numbers a model produces.** This log pins whether a test can fail and
  whether a stated figure reproduces. It says nothing about whether a
  projection is any good — that is the model audit's job, in
  `MODEL-AUDIT-2026-09-20.md`.
