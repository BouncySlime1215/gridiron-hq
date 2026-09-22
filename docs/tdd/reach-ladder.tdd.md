# reach-ladder.mjs — a command for a headline that had none

**Commit measured on:** the commit titled *"test: RED — the reach ladder has
no command, and these ten rules say what one must do"* (RED) → the commit
titled *"feat: GREEN — the reach ladder, by command, on two axes"* (GREEN).
Named by subject first because a rebase rewrites shas (R52.2).

**Reproduce:** `node scripts/reach-ladder.mjs` · rules:
`node --test test/reach-ladder.test.js`

## What was wrong

`docs/inventory/CONTRACT.md` published `183 wired`, a `116 / 67`
route-versus-script split and a `53 / 14` line. **No command produced any of
them.** The partition behind them was worked out per row inside a session and
written down only as prose, so nothing could regenerate them and nobody could
check them (Evidence Auditor §R51.3). They were cited across this project for
a day, including by this thread, in PR bodies and in an evidence file.

The contract's own test is that *a rule with no consumer that can detect its
violation is decoration*. Its own headline failed that test.

`CONTRACT.md:160-166` also printed `178` for request-only `wired` in a column
summing to **325** against a population of **319**. That arithmetic is the
whole evidence the figure came from no run over that population, and it is why
`ladderRow` refuses a row that does not sum rather than printing it.

## The crux: two axes, conflated

The replaced figures answered two different questions with one number.

| axis | question | shape |
|---|---|---|
| **EDGE MECHANISM** | does the import run at load, or only when a function is called? | a bracket — one population, two definitions of "reaches" |
| **ENTRY TYPE** | is the entry a mounted route or a package.json script? | not a bracket — one graph, two kinds of entry |

A reader handed one number assumes it answered theirs. So both print,
separately named, **edge bracket first**, and the entry table carries "not the
bracket" in its own words for anyone who reads only it. Three rules pin that,
including one asserting `ENTRY_AXIS.order > EDGE_AXIS.order`.

A third notion is kept separate again: **package.json scripts the scheduler
spawns as child processes** (`server/services/scheduler.js:737-742`, with its
docblock at `:728`, on services subtree `2c900fff` — main at `f620a120` and
`c90d2834` and this branch alike). An earlier draft cited `:714-721`, and
that cite was not invented: it is correct at `b0c1616d`, the falsification
tree, where those lines do hold the `execFile` call. It was simply carried
forward to a tree it no longer fits. **A line number is only a fact about the
tree it was read on**, which is the wiring gate's own warning and worth the
correction being visible here rather than silently repaired. That is not
"job reach" — job reach is the in-process scheduler's deferred `import()`
calls. Folding them would repeat the conflation this file exists to remove.

## The falsification test, committed in advance

`/mnt/project-files/w45mur-partition-script-PREREGISTRATION.md`, written
before any of this code existed, committed that the script must reproduce the
Auditor's §R54.1 run on `b0c1616d` — and that **any disagreement means the
script is wrong**, not the Auditor, because the grader and that run had each
been reproduced across two trees and two sessions.

Checked out `b0c1616d`, `git write-tree` = `500bab36774ca1264b5dbdc5f1e5d69445f19ff7`:

| definition | wired | betting-only | mlb-only | off-product | hand-run | unreached | sum |
|---|---:|---:|---:|---:|---:|---:|---:|
| request-only | 172 | 65 | 6 | 18 | 11 | 47 | **319** |
| request+job | 228 | 55 | 3 | 2 | 10 | 21 | **319** |

Every cell matches. Entry split on the same tree: **214 route / 14
script-only**, matching R54.2 condition 4's frozen figures.

So the reproducible **edge bracket is 172–228**, and `178` joins
`116 / 53 / 67 / 183` as unreproducible.

## On the current tree, and what 321 is a count of

**Correcting an earlier line in this file.** It said "on current main
(`write-tree 02096ca5`)". `02096ca5` is **not main's tree** — it is this
branch's, before the rebase. Main at `f620a120` has tree `6c00c129`. The
figure was right and the tree named beside it was wrong, which is the one
mistake this whole file exists to make impossible, so it is corrected here
rather than edited away.

**321 is main's population, not this branch's.** The three files this branch
adds are `scripts/reach-ladder.mjs`, `test/reach-ladder.test.js` and this
document. None is under `server/services/` or `server/modeling/`, so none can
enter the population. Checked rather than argued — the population subtree
hashes are byte-identical across main and this branch:

    git rev-parse f620a120:server/services  -> 2c900fff...   (same on HEAD)
    git rev-parse f620a120:server/modeling  -> 6bbd8e6a...   (same on HEAD)

Counting the same extensions over those two directories gives **321 at
`f620a120`, 321 at `c90d2834`, 321 here, and 319 at `b0c1616d`**. The +2
against `b0c1616d` is entirely main's own churn: `data-freshness.js`,
`league-history.js` and `player-advanced-stats.js` were added and
`trend-exploits.js` removed, three in and one out. So **169 / 225 are main's
numbers**, measured on a branch that does not change the thing being measured.

Because the population subtree is what the figures are a count of, this file
cites **that** hash rather than the commit `write-tree`. A `write-tree` moves
every time this document is edited, so a document citing its own `write-tree`
invalidates its own citation on the next keystroke; the subtree hash does not
move unless the measured code does.

| tree | population subtree (`server/services`) | request-only | request+job | entry split |
|---|---|---|---|---|
| `b0c1616d` | — (319 files) | 172/65/6/18/11/47 | 228/55/3/2/10/21 | 214 / 14 |
| `f620a120` main | `2c900fff` (321 files) | 169/65/6/18/12/51 | 225/55/3/2/10/26 | 211 / 14 |
| `c90d2834` main, and this branch | `2c900fff` (321 files) | 169/65/6/18/12/51 | 225/55/3/2/10/26 | 211 / 14 |

So the reproducible edge bracket on current main is **169 counting only
module-scope imports** and **225 counting module-scope and in-function imports
together**, of 321. Two answers to two questions, never one number.

## Two defects this found in itself

**The entry split was wrong on the first run, and the suite did not catch it.**
It reported **227 route / 1 script-only** against the frozen 214 / 14. The
cause: route-reach counted *any* mounted route, where the frozen definition
excludes betting entries. Thirteen files are reachable only through a betting
route.

Worse, fixing it was not enough. **Mutation M1 — deleting the betting
exclusion from the call site — survived the entire suite.** The `entrySplit`
rule injects its own predicate, so it pinned the unit and said nothing about
which predicate the ladder passes it. `routeEntryPredicate` is now exported
and pinned directly. A rule that tests a function taking a predicate is not a
rule about the predicate.

**The scheduler derivation was a heuristic wearing a command's clothes.** The
first version matched each script's basename as a substring of the scheduler
source and reported five scripts — including `server/index.js`, off the
substring `index.js`. It now parses with the TypeScript compiler and collects
string literals matching `scripts/<name>.mjs`, so a path in a comment cannot
count, and intersects with the package.json script entries. Result: **one**
script, `scripts/build-manager-archetypes.mjs`, which the scheduler genuinely
spawns. A loose matcher here would have been the original defect with a `.mjs`
extension, and harder to catch the second time because it would look like a
command.

## Mutations

| # | mutation | result |
|---|---|---|
| M1 | betting exclusion removed from the call site | **survived**, then killed by `routeEntryPredicate` rule |
| M2 | column-sum check disabled | killed |
| M3 | unknown-grade check disabled | killed |
| M4 | parser swapped back for the substring matcher | killed (2 rules) |
| M5 | `ENTRY_AXIS.isBracket` set true | killed |
| M6 | toolchain gate disabled | killed |
| — | control, restored | 14 pass / 0 fail |

## What this does not establish

- **Not call reach.** Import reach only. An entry point that imports a module
  is not one that calls anything in it. The call-graph unit is separately
  pre-registered.
- **Not runtime.** Nothing here executes the app; a statically reachable path
  that is never taken still counts.
- **Not a verdict on `178`.** It establishes that 178 is not reproducible over
  the 319 population and that 172 is. If CONTRACT.md disagrees, the document
  is what changes.
- **Not the scheduler's full reach.** `schedulerInvokedScripts` sees literal
  paths, not ones assembled at runtime from variables.

## THE FIVE QUESTIONS

**1. Is this well built?** It adds no grading logic — every grade comes from
`reach-grade.mjs`. A ladder that re-implemented the grader would agree with
its bugs, which a cross-check in this thread already did once.

**2. Is this based on stats, or is it made up?** Measured, over 319 and 321
files, with both ends of every bracket and every column sum printed. The
figures it replaces were made up in the specific sense that no command
produced them.

**3. How do we know?** By re-running it, on two trees, against an independent
run by a different party. Every cell of R54.1 reproduces.

**4. Should this data be pointed anywhere else?** It should replace
CONTRACT.md's headline. Any future ladder figure should cite this command and
its `write-tree`, which the output prints so a figure cannot be quoted
without it.

**5. How does it unify?** One question — what reaches this, and under which
definition of "reaches" — asked the same way twice, with the two answers kept
apart instead of averaged into one number nobody can reproduce.
