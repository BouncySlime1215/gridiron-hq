# Honest-inventory contract

Phase 0 item 5. This file says **what a row in the inventory must mean and what
evidence it must carry**. It does not grade anything. Grading is done per
`docs/inventory/` rows by a thread that does not own the file being graded.

The inventory this replaces the vocabulary of is
`docs/EXISTING-SYSTEMS-INVENTORY.md` (2026-09-18), whose `Quality` column uses
*Live / Orphaned / Broken / stale / dead branch* ad hoc. Section 5 maps those
words onto these categories so its rows can be migrated rather than re-derived.

---

## 1. The unit of a row is a path, not a file

A file is almost never one thing. `server/routes/tradelab.js` holds orphaned
routes **and** `analyzeLeague`, which is live through `trade-engine.js:93`
`rosterContext`. A row that grades the file grades neither correctly.

So: **one row per exported symbol, route, job, table or branch** — the thing a
consumer can reach — and the row names its reachable entry point. If two symbols
in one file differ in category, that is two rows.

`scripts/reach-grade.mjs` answers the file question and is the **ceiling** for
this one: a symbol cannot be more reachable than the file it lives in.
`scripts/symbol-reach.mjs` answers the symbol question, and it is the one a row
is filed against:

    node scripts/symbol-reach.mjs server/services/<file>.js [symbol ...]

It reports **both counts of §3 every time**, names the declarations a symbol is
used inside, and counts test importers separately from production ones. Worked
case: `contingency.js` grades `wired` as a file, and of its 28 exports only
**6 are `wired`** — 15 are reachable only through `scripts/fit-availability.mjs`,
a hand-run script, 6 are `internal-only`, and 1 is `unused-in-code`. Grading
those 28 rows by the file they live in would have called every one of them
wired.

## 2. The five categories, each with the test that separates it from its neighbour

A category is a claim about **reachability from a real consumer**, not about
code quality. Take them in order; the first that fits, wins.

### `wired`
A consumer outside the defining file reaches it, and that consumer is itself
reachable from a route, a scheduled job, a script in `package.json`, or the
client.
**Test:** name the caller with `file:line`, then name *its* caller, until you
land on an entry point. One level is not enough — a live function called only by
an orphaned route is not wired.

**`hand-run-script` is a reach, and it is not this one.** A script with no
importer, absent from `package.json` `scripts`, and named nowhere in `server/`
runs only when a person types `node scripts/…`. Nothing in the repository causes
it to happen, so a row reached only that way is live on the days someone
remembers it and not otherwise. Record it as `reached from: hand-run script`,
never as `wired`, and let the grader decide what it is. Found by filing the
first rows against this contract: every consumed export of
`server/services/opportunity-model.js` hangs off exactly one such script.

**"Named nowhere in `server/`" means not *called* from `server/`.** A grep for
the script's name hits comments and error strings too, and those are not
reaches. `scripts/fit-availability.mjs` is the measured case: it has no
`package.json` entry and no importer, and `contingency.js` names it five times
— in a comment, in an assertion message, and in a `fix:` string telling a
person to run it. It is hand-run, and the mention that reads most like wiring
is `contingency.js:516`, which says the script **has never run**.

### `wired-betting-only`
Reachable, and reachable **only** through a betting surface. Betting is out of
scope for this product, so a row here is genuinely served and served somewhere
the product is not meant to be using.

**The betting surfaces are this list, and the list is the test:**

| route file | mounted at | why |
|---|---|---|
| `nfl-market.js` | `/api/nfl-market` | the NFL market board |
| `nfl-betting.js` | `/api/nfl-betting` | "NFL betting API" |
| `betting-hub.js` | `/api/betting` | "the betting home page's data" |
| `wong.js` | `/api/betting/wong` | "the Wong teaser desk… a ledger of what was taken" |
| `execution-slate.js` | `/api/execution-slate` | the shopping board, teaser execution and the staking gate |

**A mount path is evidence for adding to the list, never the test.** Both
directions are live here: `wong.js` sits under `/api/betting` and
`execution-slate.js` sits outside it, and both are betting. A prefix rule
catches the first and misses the second, so it is not the rule. Adding a surface
means adding a row above with its reason, quoted from the file's own header, and
re-running the sweep.

**Test:** trace every path to an entry point, not the first one. The grade
applies only when *all* of them terminate in a betting route. One non-betting
path is enough to make the row `wired`.

**Counted separately, and never in the fantasy `wired` total.** That is the
whole point of the grade: a `wired` count that silently includes betting-only
reach overstates how much of the fantasy product is actually connected, and the
overstatement grows with exactly the rows a reader is least likely to check.

Worked example, both halves: `betting-fantasy-link.js` reaches an entry point
only as `<- routes/nfl-betting.js`, so it takes this grade.
`player-week-engine.js` also has a betting path
(`<- betting-fantasy-link.js <- routes/nfl-betting.js`) but reaches
`routes/model.js` directly as well, so it stays `wired`.

**The first half of that example used to name `role-scenario-engine.js`, and it
was wrong.** It reaches `scripts/build-role-scenario-lab.mjs`, which
`package.json` runs as `build:role-scenario-lab` — a script in `package.json`
is an entry point by this section's own `wired` test. The row was written from
a trace that found the betting route and stopped, which is the exact mistake
this grade exists to catch, caught here by the grader rather than by a reader.
`scripts/reach-grade.mjs` is that grader and
`test/reach-grader-all-paths.test.js` pins it; a rule with no consumer that can
detect its violation is decoration, by this contract's own test.

**The sweep this implies.** Any row already graded `wired` whose paths were
traced only far enough to find the first entry point has not been tested against
this grade. Re-trace those to *all* entry points before the `wired` total is
quoted anywhere. Run:

    node scripts/reach-grade.mjs server/services/<file>.js

**First sweep, 2026-09-22.** Across the 319 tracked files in `server/services/`
and `server/modeling/`: **233 `wired`, 55 `wired-betting-only`, 10
`hand-run-script`, 21 `unreached`.**

That is the five-surface list. On the three-surface list it was 237 / 51 / 10 /
21; adding `wong.js` and `execution-slate.js` moved four files —
`execution-slate-reasoning.js`, `nfl-teaser-execution.js`, `nfl-teasers.js` and
`staking.js` — out of the fantasy `wired` total, which is what they were doing
wrong there.

**A known under-count, named rather than folded in.** `/api/props` and
`/api/props-tickets` are an MLB prop research board and its saved slips, and
`/api/mlb` is MLB. They are not betting surfaces as this grade defines them, and
they are not the fantasy product either, so a row reachable only through them is
also overstating the `wired` total. Counting those three as well would give
228 / 60 / 10 / 21 — five more files. **That is a separate grade and it has not
been made**; this note exists so the 233 is read as an upper bound on fantasy
reach rather than as a settled figure. So roughly one file in six that a
first-path trace would have called `wired` is reachable only through a betting
surface. That is the overstatement this grade was added to prevent, measured
rather than asserted.

**Read those four numbers as an upper bound on `wired`, not as inventory rows.**
The grader grades a *file's* reach; §1's unit is a symbol. `routes/tradelab.js`
grades `wired` as a file and §1 already says why that answers nothing about its
orphaned routes. A file graded `unreached` is settled — nothing inside it is
reachable. A file graded `wired` means only that *something* in it is.

**`unreached` has one known false negative, and it is large.** The graph is
built from literal import specifiers. `server/db/migrate.js:35,49` loads
migrations with `readdirSync` plus a computed `import()`, so **62 of
`server/migrations/`'s 63 files grade `unreached` while running on every boot.**
Across all 458 tracked files under `server/`: 303 `wired`, 54
`wired-betting-only`, 10 `hand-run-script`, 91 `unreached` — of which 62 are
those migrations. Before filing any `unreached` row, check for a directory
load, a re-export chain, or a namespace import.

**All 31 route files are mounted** — 28 `wired`, 3 `wired-betting-only` (the
three betting surfaces themselves). An earlier reading of 19 orphaned routes was
a defect in the grader, not a finding: the walk never tested whether the subject
was itself an entry point, so a mounted route graded `unreached`. Fixed, and
`test('a module that is itself an entry point is reached, by itself')` pins it.

### `half-done`
The code is correct and reachable in principle, and the last hop was never
built. The producer exists, the consumer does not, or the writer exists and
nothing schedules it.
**Test:** the missing hop is nameable in one sentence. `buildManagerSignals`
(`manager-signals.js:160`) writes two tables correctly and **no route, job or
script calls it** — that sentence is the row.

### `dead`
Nothing reaches it, and nothing is going to without new code being written.
**Two sub-kinds, and the row must say which:**
- *dead in code* — no caller exists anywhere.
- *dead in data* — a caller exists and its condition is never true against real
  rows. `trades.js:466` takes news items with `importance = 3`; all 914
  `news_items` have `importance` 2. The branch is live code and a dead path.
  A grep can only find the first kind. The second needs a query, and the row
  carries it.

### `silently broken`
It runs, it returns, and what it returns is wrong or empty while the surface
presents it as fine. This is the most expensive category and the only one that
is invisible to every consumer count.
**Test:** the output is indistinguishable, to a reader, from the working case.
Canonical rows: the "data healthy" banner, which checks the **connection** and
not the **rows**; `manager_profiles` with 0 rows, so tier logic silently prices
every manager as "fair"; and the shape CLAUDE.md names, a bare `catch {}` that
deletes a whole data layer while the page keeps printing numbers.
A row here must name **what a reader would have to do to notice**.

### `decoration`
It exists, it is correct, and nothing in the running app asks it. Tests do not
count as consumers.
**Test:** production consumers = 0 with the defining file excluded, and the
thing is not reached internally either (see §3). A high test count reads like
wiring and is not: `server/services/availability-basis.js` has six exports, ten
tests, and **four exports with no production consumer at all**.

## 3. Two counts, always — the trap that produced a false row on 2026-09-22

Consumer counts are run twice and both are reported:

```
git grep -n "\bSYMBOL\b" <ref> -- server client scripts test          # is it used at all?
git grep -n "\bSYMBOL\b" <ref> -- server client scripts test | \
  grep -v "<defining file>"                                            # does anything import it?
```

Excluding the defining file is correct for the import question and **silently
wrong** for the usage question, because a symbol used where it is defined is
exactly the evidence the exclusion throws away. One filter, two incompatible
questions, identical-looking output.

Measured case: `SEASON_ENDING_RE` and `RELEASED_RE`
(`server/services/player-availability.js:19-20`) were reported dead on the
second count alone. They are called at `:77` and `:152`, inside two functions
that do have production consumers. The code path is live; only the `export`
keyword is unused.

**So `exported and never imported` is its own note, not a category.** It is a
tidy-up. `dead` is a deletion candidate. Never use the second word on the
first's evidence.

## 4. What every row carries

| field | rule |
|---|---|
| symbol / route / job | the reachable thing, not the file |
| file:line | of the definition |
| ref | the commit the row was measured at — a row without one is undated |
| category | one of the five, lowercase |
| consumers | both counts, as `with-defining-file / without` |
| reached from | the entry point, or `none` |
| evidence | the command, and enough output to re-run it |
| grader | the thread that graded it, which is never the thread that owns the file |

A row measured at one commit is a reading of **that tree**, not a statement
about `main`. Two commits, two correct and different figures.

## 5. Migrating the 2026-09-18 vocabulary

| old word | new category | what still must be checked |
|---|---|---|
| Live | `wired` | trace past the first caller to an entry point |
| Orphaned | `dead` or `decoration` | `decoration` if it is correct and unreached; `dead` if nothing will reach it |
| Orphaned route, live service | two rows | the split in §1 |
| "dead branch" | `dead` (in data) | the query, not a grep |
| Broken | `silently broken` only if the surface hides it; otherwise just a bug | what a reader would have to do to notice |
| stale | not a category | say what it predates, and grade it on reachability |

Rows from that file are re-measured at the current ref before they are carried
over. It was produced on a different machine, before the teardown commits, and
its own header already carries one correction made five minutes after writing.

## 6. Nobody grades their own rows

The author of a file supplies **evidence** for it — the counts, the commands,
the entry points — and never the category. A second thread assigns the
category from that evidence. An author's own grade is the one reading nobody
else checked.

---

## The five questions

**Well built?** The contract makes a row falsifiable: every field is a command
someone else can re-run, and the category is forced by a stated test rather than
by judgement.

**Stats or made up?** Every rule here comes from a measured case in this
repository — the `player-availability.js` false row, the `availability-basis.js`
four-of-six count, the `importance = 3` branch against 914 rows, the 0-row
`manager_profiles` tiers. No category was invented to be tidy.

**How do we know?** Each is cited to `file:line` or to a query, at a named ref.
The one row this document reports as wrong was withdrawn the same night, and the
rule that caught it is §3.

**Pointed anywhere else on the platform?** It governs every row of
`docs/inventory/`, and it reclassifies `docs/EXISTING-SYSTEMS-INVENTORY.md`
rather than leaving two vocabularies running at once.

**How does it unify?** One question — *what reaches this, and how would we
know if the answer were a lie* — asked the same way of a route, a job, a table
and an export.
