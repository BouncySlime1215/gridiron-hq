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

**First sweep, 2026-09-22. Quote this as a BRACKET, not a point.** Across the
319 tracked files in `server/services/` and `server/modeling/`:

> **172–228 `wired` · 55–65 `wired-betting-only` · 3–6 `wired-mlb-only`
> · 2–18 `wired-offproduct-only` · 10–11 `hand-run-script` · 21–47 `unreached`
> — each column summing to 319**

**The ends are bounds, not alternatives**, and the bracket, never either end, is
what goes into the Phase A plan.

| | request reach only | request + job reach |
|---|---|---|
| `wired` (fantasy) | **172** | **228** |
| `wired-betting-only` | 65 | 55 |
| `wired-mlb-only` | 6 | 3 |
| `wired-offproduct-only` | 18 | 2 |
| `hand-run-script` | 11 | 10 |
| `unreached` | 47 | 21 |
| **total** | **319** | **319** |

Three things widen it, and each has its own section:

- **The script rule (§2a)** — 13 files whose grade turns on how a
  `package.json` script entry point is classified.
- **Request reach against job reach (§2b)** — **27 files with no request path
  at all**, re-derived exhaustively (see the method note there).
- **The off-product surfaces (§2c)** — `/api/mlb` is neither betting nor
  fantasy, and a module reached only from it was previously counted in the
  fantasy `wired` total.

**How the lower end moved, and why the earlier numbers were higher.** The
Auditor's §R17 put it at 205, derived by excluding paths through
`scheduler.js`. Measured by mechanism rather than by file name that became 196,
because a function-body import defers reach wherever it occurs. Adding the
`/api/mlb` label (§R18.1) takes it to **172**: 24 of the files the earlier
figures counted as fantasy `wired` on the request path reach no fantasy route
at all. Each revision moved the same direction, and each was a false fact
removed rather than a figure re-derived.

## 2c. Off-product surfaces (Auditor §R18.1)

Betting is not the only surface that is not the fantasy product. **`/api/mlb`
is neither**, and it is the most droppable category of the three, because MLB is
not in the approved product at all.

So the surface list carries a **label**, and `wired-betting-only` is not
renamed:

| surface | label |
|---|---|
| `nfl-market.js`, `nfl-betting.js`, `betting-hub.js`, `wong.js`, `execution-slate.js` | `betting` |
| `mlb.js` | `mlb` |
| every other mounted route | `fantasy` — **the default** |

Fantasy is the default so that a route nobody has classified counts as product
and a new surface cannot silently leave the total. The grades that follow:
**`wired`** (at least one fantasy entry point — one is enough, whatever else it
reaches), **`wired-betting-only`**, **`wired-mlb-only`**, and
**`wired-offproduct-only`** where there is no fantasy entry point and the
off-product ones are mixed. Folding an MLB-only module into
`wired-betting-only` would state a false fact the Phase A plan then reads;
leaving it in `wired` hides it.

**Route files, not route families.** The label is per mounted route file, so
there is no family to un-label and the "one unlisted sub-route unlabels the
whole hub" case cannot arise here. The mirror case can: a new router mounted
under `/api/betting` that nobody adds to the list defaults to `fantasy` — safe
for the total, and silent. `test('every route mounted under a betting surface
prefix is itself on the betting list')` makes it loud: it walks
`server/index.js`'s mounts and fails until somebody decides the new route's
label. Today `/api/betting` has exactly two mounts, `betting-hub.js` and
`wong.js`, both listed, and every route file in this app has exactly one mount
path.

**The residual hazard is the unit, and it is the unsafe direction.** A single
route file serving both betting and fantasy endpoints would be labelled wholly
betting, removing real fantasy reach. No such file exists today — every route
file has one mount path — but if one is ever added, the label has to move to the
endpoint and this section is where that starts.

## 2b. Request reach and job reach are two reaches, never summed (Auditor §R17.4)

**REQUEST REACH** — a handler can call in. **JOB REACH** — the module executes
because a scheduled job runs it. A row reached only the second way gets the
bucket **`job-reach only`**, and it is never added to the request-reach total.

**The bucket is named by mechanism, and the mechanism is in the syntax.** An
import at module scope runs when the module loads, so any handler that loads the
module has it; an import inside a function body runs only when that function is
called. This repo has **1,687 module-scope imports against 240 inside function
bodies**, and `scheduler.js:1064` is the live case: `await import('./nfl-auto-picks.js')`
inside `refreshNflDecisionLedger()`. Calling the bucket "via `scheduler.js`"
would encode one file where the mechanism is what matters.

**The 27 were re-derived exhaustively, and the method is the point (§R18.3).**
The earlier figure of 28 came from a proxy — excluding paths through
`scheduler.js` — and an earlier claim of mine generalised from the three
shortest paths to all thirteen, which was wrong. Both are replaced by the same
enumeration the route test uses: for each file, **every** entry point on the
request graph and **every** entry point on the full graph, with membership being
`full > 0 and request == 0`. No shortest path is consulted. **Removing an edge class and re-running
reachability is all-paths by construction** — the question "does ANY path avoid
these edges" is answered by whether the node is reachable at all once they are
gone, so no path needs enumerating. The Wiring map thread reached the same
construction independently by removing `scheduler.js` as a *node*; removing the
function-body edge *class* is the same argument one level more general, since it
catches deferred reach wherever it occurs rather than in one file. `nfl-candidate-findings.js`
is correctly **not** a member (§R18.2): it has request reach, from betting and
MLB surfaces. Every member of this bucket is a file the plan is told to ignore,
so the expensive direction of error is inclusion, and the enumeration is what
guards it.

**`SCHEDULER_DISABLED=1` is excluded from the criterion.** It is operational
state, not architecture, and it is not in `fly.toml`, so a deploy can drop it.
It is recorded beside the bucket as a live-state note and never inside the
grade: **26 files are `job-reach only`, and on the live app today the scheduler
is braked, so none of the 26 is executing there.**

**Worked case.** `nfl-candidate-findings.js` on request reach is `wired`
through `betting-hub.js`, `execution-slate.js`, `nfl-betting.js`,
`nfl-market.js` and `routes/mlb.js` — every one a betting surface or MLB, and
**no fantasy route**. That is the mechanism behind §R17.3's ruling that it is
not a fantasy reader.

The point figure the grader prints today, on the five-surface list and with
script entry points counted as non-betting, is **233 / 55 / 10 / 21**.

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
reach rather than as a settled figure.

**A second under-count, and a larger one: a `package.json` script has no route,
so this grade cannot classify it.** A script is a non-betting entry point by
default, because the betting test is a list of route files and a script is not
one. **14 of the 233 `wired` files reach no entry point except a
`package.json` script, and 13 of those 14 also have a betting path** — so for
those 13 the grade turns entirely on the script counting as non-betting reach.
The scripts in question are `nfl-blind-audit.mjs` ("the content-addressed
week-at-a-time NFL audit"), `build-evidence-dataset.mjs` ("one evidence dataset
from the quote tape"), `audit-passing-specialists.mjs`,
`diagnose-passing-components.mjs`, `run-news-event-impact.mjs` and
`build-role-scenario-lab.mjs`. By their own headers they are betting-model
tooling, but that has not been established file by file and no grade has been
changed on it. If all 13 were classified betting the sweep would read
**220 / 68 / 10 / 21**. Until a rule for classifying script entry points exists,
`wired` is an upper bound. It is not, however, the largest
reason — the next one is.

**Import reach is not call reach, and `scheduler.js` is where the two diverge
most.** This grader answers "can the module be loaded from an entry point",
which is an upper bound on "does the entry point call it".
`gamescript.js:21` imports one function, `recordSync`, from `scheduler.js`, and
that single edge pulls the whole scheduler graph — **357 modules** — into reach
from every route that transitively imports `gamescript.js`.
`scheduler.js:1064` then does a lazy `await import('./nfl-auto-picks.js')`
inside a job body, and `nfl-auto-picks.js:12` imports `promotedFindingVeto`
from `nfl-candidate-findings.js`, which reads `nfl_blind_audit_runs` at
`nfl-candidate-findings.js:249`. That is how a betting-audit table ends up
"reachable from `/api/trades`" — through a utility import and a lazy job-body
import, with no fantasy handler calling any of it.

**28 of the 233 `wired` files are `wired` only through a path crossing
`scheduler.js`.** Excluding such paths gives **205 `wired` / 81
`wired-betting-only` / 10 `hand-run-script` / 23 `unreached`**. Excluding them
is *not* proposed as the rule — the scheduler genuinely runs jobs at boot and
what it calls is genuinely reached — but the figure bounds the error, and two
facts sharpen it: the edge that carries most of it is a one-function import,
and `SCHEDULER_DISABLED=1` is set on the live app, so the jobs are not running
there at all. **No grade has been changed on any of this.**

*Correction, same day.* An earlier version of this paragraph said every fantasy
path to `nfl-candidate-findings.js` runs through `scheduler.js`. **Twelve of the
thirteen do; `routes/mlb.js` does not** — it reaches via
`nfl-auto-picks.js <- model-intelligence.js <- routes/mlb.js`. That is MLB, not
the fantasy product, so the conclusion is in fact stronger than the claim it
replaces: with scheduler paths excluded, `nfl-candidate-findings.js` reaches the
three betting routes and `/api/mlb`, **and no fantasy route at all.**

## 2a. Scripts: a script's reach is what it writes (Auditor §R16)

A route file's reach is its routes. **A script has no route, so its reach is
what it writes**, and the grade follows the readers of those writes.

**The header is quoted as INTENT and is explicitly not the criterion.** A script
headed "the NFL audit" may write a table a fantasy surface reads, and a script
that writes nothing cannot be betting-only however it describes itself.

**The default is that a script is NOT betting.** A script counts as betting-only
**only when every durable output has been traced and none is read by a fantasy
surface**. Untraced output defaults to `wired`, because a false
`wired-betting-only` silently removes a module from the Phase A plan's view,
which is the more expensive error.

Three sub-cases:

1. **No durable output at all, OR durable output that no surface reads** —
   stdout does not count, because nothing reads it, and neither does a file
   only its own writer opens. These go to a **third bucket,
   `no-surface-reach`**, reported separately and **never folded into
   `wired-betting-only`.** *(Widened by §R17.1: the first draft of this rule
   said "no durable output at all", which put `build-evidence-dataset.mjs` and
   `build-role-scenario-lab.mjs` in the wrong bucket — they write frozen
   artifacts that nothing in `server/` reads. Four of the six, not two.)*
2. **Output read only by another script** — follow it transitively. One hop is
   not enough.
3. **Output read by a fantasy surface** — `wired`, whatever the header says.

**The evidence bar, per script, before any grade moves.** (a) the invocation
path, `package.json` name to entry `file:line`; (b) every durable write
enumerated with `file:line` — DB tables and filesystem paths only; (c) for each
output, the reader at `file:line` and whether it sits on a fantasy surface,
traced the way the route test traces; (d) an explicit "no durable writes"
statement where that is true; (e) the header quoted as intent, marked not the
criterion.

### The six scripts behind the 13 disputed files

| script | (a) invocation | (b) durable writes | (c) readers | verdict |
|---|---|---|---|---|
| `nfl-blind-audit.mjs` | `audit:nfl` → `:5` | `nfl-blind-audit.js` `:223` `:926` `:940` INSERT `nfl_blind_audit_runs` / `_weeks` / `_week_performance`, `:866` `_retries`, `:937` `:955` UPDATE `_runs` | `nfl-audit-overview.js`, `nfl-profitability.js`, `nfl-research-lab.js` — all `wired-betting-only`; and `nfl-candidate-findings.js:249` | **`wired-betting-only` on request reach** (§R17.3: `nfl-candidate-findings.js` is not a fantasy reader), with the job-reach caveat of §2b recorded |
| `build-evidence-dataset.mjs` | `build:evidence-dataset` → `:18` | none in `data.sqlite`; files under `server/data/evidence-datasets` (`nfl-evidence-dataset.js:44`) | nothing in `server/` reads that directory except its writer | **`no-surface-reach`** (§R17.1) |
| `audit-passing-specialists.mjs` | `audit:nfl-passing-specialists` → `:1` | **(d) no durable writes.** Three lines; `passingSpecialistAudit()` to stdout | none possible | **`no-surface-reach`** |
| `diagnose-passing-components.mjs` | `diagnose:nfl-passing` → `:2` | **(d) no durable writes.** `passingComponentDiagnostic(…, { useCache: false })` to stdout | none possible | **`no-surface-reach`** |
| `run-news-event-impact.mjs` | `news:event-impact` → `:29` `:31` (dynamic, after `runMigrations`) | `nfl-news-events.js:83` `nfl_news_event_extraction_cache`, `:109` `nfl_news_events`, `:302` `:305` `:352` `:372` UPDATE `nfl_news_events`; `nfl-news-event-impact.js:324` `:325` `server/data/news-event-impact/{manifest,latest}.json` | `nfl-t60-packet.js:435` reads `nfl_news_events`; `nfl-research-lab.js:132` reads `latest.json` (`wired-betting-only`). `nfl-t60-packet.js` off the scheduler reaches the three betting routes and `/api/mlb`, **no fantasy route.** `trade-proposals.js:46` is a comment naming the cache table, not a query | **`wired-betting-only`** (§R17.2: the negative is proven, so the untraced-defaults-to-wired rule does not apply) |
| `build-role-scenario-lab.mjs` | `build:role-scenario-lab` → `:9` | files under `server/data/role-scenario-lab` (`role-scenario-lab.js:32`); header says read-only against `data.sqlite` | nothing in `server/` reads that directory except its writer | **`no-surface-reach`** (§R17.1) |

**Headers, as intent only, not the criterion:** "CLI for the content-addressed,
week-at-a-time NFL audit" (`nfl-blind-audit.mjs:2`); "Build and freeze one
evidence dataset from the quote tape (Package A)"
(`build-evidence-dataset.mjs:3`); no header (`audit-passing-specialists.mjs`);
no header (`diagnose-passing-components.mjs`); "CLI for Package E: typed
news-event extraction, the impact/timing model, and the three negative
controls" (`run-news-event-impact.mjs:3`); "Run and freeze one Package D
role-scenario research artifact" (`build-role-scenario-lab.mjs:3`). So roughly one file in six that a
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
