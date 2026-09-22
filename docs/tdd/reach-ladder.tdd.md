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
check them (Independent Auditor §R51.3 — that ruling is the Independent
Auditor's, not the Evidence Auditor's; an earlier revision of this file
misattributed it). They were cited across this project for
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
docblock at `:728`; those lines hold on every services subtree this branch
has been measured on, `2c900fff` and `a8800fde` alike). An earlier draft cited `:714-721`, and
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

So the reproducible **edge bracket is 172 to at least 228** (the high end a
floor, per R66 below), and `178` joins
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

    git rev-parse c90d2834:server/services  -> 2c900fff...   (same on HEAD then)
    git rev-parse 9f0b5b66:server/services  -> a8800fde...   (same on HEAD now)
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
| `c90d2834` main | `2c900fff` (321 files) | 169/65/6/18/12/51 | 225/55/3/2/10/26 | 211 / 14 |
| `9f0b5b66` main, and this branch | **`a8800fde`** (321 files) | 169/65/6/18/12/51 | 225/55/3/2/10/26 | 211 / 14 |

The third row is the one that earns the method. Main moved again while this
branch was open (#124 landed, changing `server/services/league-history.js`),
so unlike the first two rows the measured subtree **did** change — and the
figures did not. That is the useful kind of stability: a hash that moves when
the code moves, beside numbers that only move when the reach does. Every
figure in this document is the `9f0b5b66` row; the earlier rows are kept so a
reader can see what changed and what did not.

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
| M1 | betting exclusion removed from `entrySplit`'s argument | **survived**, then killed by the `routeEntryPredicate` rule |
| **M1b** | **the call site itself: `routeEntryPredicate(mounted)` → `e => mounted.has(e)` at `reach-ladder.mjs:266`** | **SURVIVED 14/0 after M1 was called killed.** Killed only by rule 15, which runs `measure()` over a fixture repository. **Standing row: re-run this mutant on every change to `measure()`.** |
| M2 | column-sum check disabled | killed |
| M3 | unknown-grade check disabled | killed |
| M4 | parser swapped back for the substring matcher | killed (2 rules) |
| M5 | `ENTRY_AXIS.isBracket` set true | killed |
| M6 | toolchain gate disabled | killed |
| M7 | the `\u2265` bound label reverted to a bare `169-225` | killed by rule 16 |
| — | control, restored | 16 pass / 0 fail |

### M1b, and getting the same lesson wrong twice

M1 was recorded above as killed. **It was not.** Pinning
`routeEntryPredicate` directly proves the predicate is correct; it proves
nothing about whether `measure()` still *calls* it. Replacing the call site
at `reach-ladder.mjs:266` with `e => mounted.has(e)` left all fourteen rules
passing, and rule 14's own title — "the predicate the ladder actually
passes" — claimed a coverage it did not have. The Independent Auditor found
this (§R62) after this file had already been signed off once.

That is the **same defect as M1, one level up**, written by someone who had
just finished writing M1's lesson down. The lesson evidently does not
transfer by being understood; it transfers by being executed. So rule 15
injects nothing at all: it builds a real repository in a temp directory, runs
the real `measure()` over it, and asserts the split.

The fixture is built around the single case that discriminates — a service
reached by a betting route **and** by a `package.json` script. It grades
`wired` (the script is a non-betting entry), so it survives to the entry
split, and there the correct predicate calls it script-only while the mutant
calls it route-reached. That is the 227/1-against-214/14 disagreement in
miniature.

## What this does not establish

- **Not call reach.** Import reach only. An entry point that imports a module
  is not one that calls anything in it. The call-graph unit is separately
  pre-registered.
- **Not runtime.** Nothing here executes the app; a statically reachable path
  that is never taken still counts.
- **Not a verdict on `178`.** It establishes that 178 is not reproducible over
  the 319 population and that 172 is. If CONTRACT.md disagrees, the document
  is what changes.
- **The HIGH end is a lower bound, not a count (Independent Auditor R66).**
  Quote it as **≥225** on main and **≥228** on `500bab36`, never as a bare
  figure. The Auditor confirmed the cause at `scripts/reach-grade.mjs:99` and
  counted **12 bare side-effect imports on `c90d2834`** — among them
  `clv-core.js:47`, `nfl-player-value.js:11-12`, `prop-feeds.js:35`. A missed
  edge can only ADD reach, so the true value is at or above what is printed.
  **The low end (172/169) and the population (319/321) are unaffected**:
  `classifyImportEdges` does see the bare form. The command now prints the
  bound, and rule 16 pins it, so the label cannot silently revert to a bare
  number.

  **Two further cells are unsettled, and that is the part worth reading
  (R67.1).** A second measurement of the same gap, restoring the bare edges
  and re-running the tally, reported **hand-run 11 / unreached 25** where this
  command reports **10 / 26**. It was summarised as "restoring them changes no
  cell". That summary is wrong on its own numbers: `wired` does not move, and
  **two cells that nobody was looking at do.** So the honest scope of the
  bound is not "the high end is a floor" but:

  > `wired` is a floor, and `hand-run-script` and `unreached` are unsettled,
  > until all twelve edges are restored and the tally re-run. Only
  > `wired-betting-only`, `wired-mlb-only`, `wired-offproduct-only`, the low
  > end and the population are settled.

  **The 12-versus-9 disagreement is itself a measurement defect, not a
  judgement call.** The two counts differ by exactly `clv-core.js:47`,
  `prop-feeds.js:35` and `signal-latency.js:30` — the three bare imports with
  a **trailing `// comment`**. A counter anchored at end-of-line misses those
  three and reports 9. So the grader PR's RED takes
  `import './x.js'; // note` as its contradiction test: a counter that returns
  9 on the real tree and passes that fixture has not been shown to work, and
  the fixture is the case that tells the two counters apart.
- **Not a graph this command builds.** Both graphs come from
  `scripts/reach-grade.mjs`, and they do not see the same edges. Found while
  building rule 15's fixture: `buildImporterGraph` matches `from '...'` and
  `import('...')` only, so a **bare side-effect `import '...'` is invisible to
  it**, while `classifyImportEdges` does see one. A fixture written in the
  bare form produced the impossible result of request+job reaching *fewer*
  files than request-only. On the real tree the effect is bounded by however
  many bare side-effect imports exist, and it can only **under**-count the
  high end of the bracket — 225 is a floor in that respect, not a ceiling.
  Not fixed here: it is a change to the merged grader, it would widen this
  PR, and the figures in this document are the ones the committed grader
  produces. Reported separately.
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
