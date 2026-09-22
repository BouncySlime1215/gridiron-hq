# TDD evidence: reach grader (PR #99)

Source: `docs/inventory/CONTRACT.md` §2, which says a `wired-betting-only`
grade requires tracing **every** path to an entry point, not the first one.
Nothing in the repository could detect a violation of that. By the contract's
own test a rule with no consumer that can detect its violation is
**decoration**, so the rule was decoration until this unit. Nothing was
deployed, no live database was touched, no network call was made. LLM spend: $0.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-test-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test test/reach-grader-all-paths.test.js

New files only — `scripts/reach-grade.mjs` and
`test/reach-grader-all-paths.test.js` — so no one-editor-per-file collision.
The one edit to an existing file is `docs/inventory/CONTRACT.md`, written by
this thread.

**15 guarded rules, 6 mutations shown failing.**

## The assertions are about the algorithm, not about today's import graph

A test asserting "`player-week-engine.js` is wired" passes or fails on whether
somebody moved an import last week and says nothing about whether the grader is
correct. So the fixtures are synthetic and each one names the shape it pins.
Exactly one assertion touches the real repository, and it is a smoke check that
the graph builder still parses this codebase at all.

The regression the unit exists for is
`test('a first-entry-point-only walk mis-grades ...')`. It builds the wrong
implementation on purpose — a faithful breadth-first walk that returns as soon
as it has one entry point, which is what "trace to an entry point" reads like
if you stop before the next sentence — and shows it producing
`wired-betting-only` where the truth is `wired`.

The fixture uses the dangerous ordering rather than the real one: the betting
entry is **two** hops from the subject and the fantasy entry is **three**, so
any breadth-first walk meets the betting route first. The real
`player-week-engine.js` is the other way round (`routes/model.js` is one hop,
`routes/nfl-betting.js` two), which means the real case would have let the
wrong implementation pass by luck. Using it as the fixture would have produced
a test that proves nothing; it is the smoke assertion instead.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| CONTRACT.md §2 `wired-betting-only` | The rule is stated correctly and nothing enforces it. Every grade filed against it so far was traced by hand. | **Build the grader**, and make the contract point at it. |
| The contract's own worked example | It named `role-scenario-engine.js` as betting-only. The grader says `wired`: it reaches `scripts/build-role-scenario-lab.mjs`, which `package.json` runs as `build:role-scenario-lab`, and §2's own `wired` test counts a script in `package.json` as an entry point. The row was written from a trace that found the betting route and stopped. | **Corrected in CONTRACT.md**, with the reason left in place rather than tidied away — it is the mistake the grade exists to catch, caught by the grader rather than by a reader. Replaced with `betting-fantasy-link.js`, which is betting-only on a full trace. |
| `server/index.js` as an entry point | `dev:server` runs `node server/index.js`, so `index.js` is an entry by the package-script rule — and `index.js` imports every router, mounted or not. An orphaned route would therefore have graded `wired` **through server/index.js**, which is the same overstatement `mountedRoutes` was written to prevent arriving by a different door. | **Drop the `server/index.js` -> route-file edge** (`dropRouteBootEdges`). A mounted route is already an entry point in its own right, so the walk never needs that edge; an unmounted one is loaded at boot and its handlers never run. Found by running the finished grader, not by reading it. |
| `hand-run-script` | The contract already says a script with no `package.json` entry is not `wired` and must be recorded as `reached from: hand-run script`. A grader that only knows `wired` / `unreached` flattens that into `unreached`, which reads as "delete it". | **Its own grade.** `opportunity-model.js` is the live case: `unreached` before, `hand-run-script` (`scripts/study-opportunity-volume.mjs`) after. |
| A truncated walk | A depth cut-off under-reports entry points, and under-reporting is precisely what turns `wired` into `wired-betting-only` by accident. | **Refuse to grade it.** `grade: 'indeterminate'` with the reason, never a grade computed from a partial set. |

## First sweep

319 tracked files under `server/services/` and `server/modeling/`:

| grade | files |
|---|---|
| `wired` | 237 |
| `wired-betting-only` | **51** |
| `hand-run-script` | 10 |
| `unreached` | 21 |

Roughly **one file in six** that a first-path trace would have called `wired` is
reachable only through a betting surface. That is the overstatement the grade
was added to prevent, measured rather than asserted.

Read the four numbers as an upper bound on `wired`, not as inventory rows. The
grader grades a **file's** reach and CONTRACT.md §1's unit is a **symbol**:
`routes/tradelab.js` grades `wired` as a file, and §1 already says why that
answers nothing about the orphaned routes inside it. A file graded `unreached`
is settled — nothing in it is reachable. A file graded `wired` means only that
*something* in it is.

## RED -> GREEN, by mutation

Each row edits `scripts/reach-grade.mjs`, runs the file, then restores.

| Mutation | Result | Rules that caught it |
|---|---|---|
| Stop the walk at the first entry point found | 10 pass, **5 fail** | every reachable entry, not the first // the first-path mis-grade // both betting entries reported // truncation reported // repo smoke |
| `wired-betting-only` when **any** entry is betting | 13 pass, **2 fail** | the first-path mis-grade // repo smoke |
| A route counts as mounted because `index.js` imports it | 14 pass, **1 fail** | imported-but-unmounted is not an entry point |
| Keep the `server/index.js` boot edge on unmounted routes | 14 pass, **1 fail** | boot import of an unmounted route is not a reach |
| Grade a truncated walk instead of refusing | 14 pass, **1 fail** | a cut-off reports `indeterminate` |
| Collapse hand-run reach into `unreached` | 14 pass, **1 fail** | hand-run reach keeps its own grade |

The first mutation is the unit's reason for existing, and it is the one the
five failures cluster on.

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/reach-grader-all-paths.test.js` | 15 | every reachable entry point is returned, not the first; the wrong implementation is built in-test and shown mis-grading; order-independence; all-betting -> `wired-betting-only` with both entries named; no entry -> `unreached`; cycles terminate without hiding the entry behind them; a reported path is a real import chain step by step; a depth cut-off -> `indeterminate`; an imported-but-unmounted router is not an entry point; the boot edge is dropped; hand-run reach keeps its own grade and does not move a module that also has a real entry point; the three betting surfaces are exactly the ones the contract names; static and dynamic imports both count and `client/dist` does not; the repo smoke. |

## The five questions

1. **Well built?** The grade is computed from a set, not from a traversal
   order, and the test proves order-independence by reversing the fixture. The
   walk is breadth-first over the reverse import graph, linear in edges, and
   terminates on cycles. It refuses to answer rather than guessing when its
   walk was cut short.
2. **Stats or made up?** Neither — it is a graph reachability question with an
   exact answer, not an estimate. No constant is fitted and none is hand-set.
   The one judgement in it is the list of three betting surfaces, which is
   quoted from CONTRACT.md and pinned by a test.
3. **How we know.** Six mutations, each shown failing with the rules that
   caught it, in the table above; 15 rules green on the current tree; the sweep
   figures reproduce with `node scripts/reach-grade.mjs <file>`. **Reachability
   in code is not reachability in data** — a caller can exist whose condition is
   never true against real rows, and only a query finds that. Everything here is
   the code half, and a row graded from it alone should say so.
4. **Pointed anywhere else?** Yes, and this is the point of it. Every `wired`
   row already filed in `docs/inventory/` was traced by hand to the first entry
   point found, so none has been tested against this grade. `CONTRACT.md` now
   names the command for that sweep. `scripts/data-lineage-inventory.mjs`
   answers the data half of the same question and the two should be read
   together before a row is called `dead`.
5. **How it unifies.** One definition of "reachable" for the whole inventory,
   executable, so two threads grading two files cannot mean two different
   things by `wired` — which is what the vocabulary in
   `docs/EXISTING-SYSTEMS-INVENTORY.md` (2026-09-18) did before the contract.

## What this does NOT settle

- **Whether a reachable path ever executes.** A caller whose condition is never
  true against real rows is reachable in code and dead in data. See question 3.
- **Anything at symbol level.** The grader takes a file. Filing a symbol row
  still needs the `file:line` trace CONTRACT.md §2 asks for; the grade is the
  upper bound it must fit inside.
- **Whether the 51 betting-only files should exist.** That is a product call,
  and betting is out of scope for this thread.
- **Reflection and string-built specifiers.** The graph is built from literal
  import specifiers. A module loaded through a computed path is invisible to
  it, and would show as `unreached` while being live.
