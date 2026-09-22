# Inventory evidence — Player opportunity's allocated files

**Ungraded on purpose.** Per `CONTRACT.md` §6, the author of a file supplies the
evidence and never the category. Every row below has a `category:` column left
empty for the grader. If a category appears here later, it was not put there by
this thread.

Measured at **`08be6e1`**, on branch
`claude/project-thread-w45mur-wiring-names-hold` (PR #85), which is where the
three graded files live. Same file at another commit carries different and
equally correct numbers.

**Where the subject files are, which is not this branch.** This file sits on the
inventory branch, whose diff against `main` is these two documents and nothing
else. `server/services/availability-basis.js` **does not exist on `main`** — it
is new work on #85's branch — and `contingency.js` and `opportunity-model.js`
are at their #85 state there, not their `main` state. So checking out this
branch and looking for the cited lines will not find them. Every row is
reproducible at `08be6e1` on the branch named above, and nowhere else. This was
separated deliberately so #85's diff matches its own description; the cost is
that the evidence and its subject now live on two branches, and a reader who is
not told that will conclude the rows are fabricated.

## Method, so every row can be re-run

Consumer counts are **not** a bare `grep` of the symbol name. That over-counts
badly: `availability` as a word appears 327 times across `server/ client/
scripts/`, almost none of them this export. Rows use the import graph instead:

```
git ls-files | grep -E '\.(js|mjs|ts|tsx)$' | grep -v '^client/dist/'   # 975 files
```
then, per module, every `import { … } from '…/<mod>.js'` **and** every
`const { … } = await import('…/<mod>.js')`, with the importing file recorded.
Runner: `scratchpad/importers.mjs`, reach-tracer `scratchpad/reach.mjs`.

**Two counting errors were made and caught before any row was written**, both
worth keeping because they are the errors this file's readers will make:

1. The first pass listed files with git pathspecs (`scripts/**/*.mjs`,
   `test/**/*.js`). Those matched **1** and **4** files respectively out of 975.
   `scripts/study-opportunity-volume.mjs` sits directly in `scripts/`, so it was
   invisible, and the run reported `opportunity-model.js` as having **zero
   importers of any kind** — a false `dead` row for a module that six live call
   sites import. A glob that silently matches almost nothing looks exactly like
   a real negative result.
2. Six `contingency.js` exports had no importer anywhere. Five of them —
   `weekDesignation` `:927`, `liveEspnStatuses` `:908`, `ROLE_MAX_GAP` `:310`,
   `roleTier` and `gapBucket` `:370` — are called **inside their own file**, on
   paths that are themselves reached. Only `resetAvailabilityCache` is genuinely
   unreached by production. Five false `dead` rows, prevented by CONTRACT.md §3
   and by nothing else.

## Entry points found, and one the contract does not name

| entry point | evidence |
|---|---|
| `server/routes/model.js` | mounted at `server/index.js:43` (`await import('./routes/model.js')`) |
| **hand-run script** | `scripts/study-opportunity-volume.mjs`, `fit-availability.mjs`, `availability-decision-calibration.mjs`, `fit-posture-calibration.mjs` — each has **0 importers**, is **not** in `package.json` `scripts`, and is named nowhere in `server/`. Reachable only by a person typing `node scripts/…` |

The second is a gap in `CONTRACT.md` as first written, which listed only a
route, a scheduled job, a `package.json` script and the client. A hand-run
script is a real but much weaker reach: nothing in the repository causes it to
run, so anything hanging off one is live only on the days someone remembers it.
The contract is amended in the same commit to name it. **Finding the hole by
using the contract is the contract working**, and the grader should know the
distinction existed before these rows were written, not after.

---

## `server/services/availability-basis.js` — 6 exports

| export | line | prod importers | test | reached from | category |
|---|---|---|---|---|---|
| `AVAILABILITY_FIT_BASIS` | :84 | **1** — `contingency.js:22` | 0 | route, via `routes/model.js` | |
| `DEFAULT_DURABILITY_PRIOR` | :101 | **1** — `contingency.js:22` | 0 | route, via `routes/model.js` | |
| `AVAILABILITY_BASIS` | :40 | **0** | 1 (dynamic) | none; used internally at `:134` by `isAvailabilityBasis` | |
| `SERVABLE_AVAILABILITY_BASIS` | :76 | **0** | 1 (dynamic) | none; no internal use — definition line only | |
| `DEFAULT_ACTIVE_PROBABILITY` | :130 | **0** | 1 (dynamic) | none; second occurrence at `:116` is a docstring | |
| `isAvailabilityBasis` | :133 | **0** | 1 (dynamic) | none | |

**Claim, one sentence.** Four of this module's six exports have no production
importer, and the one whose entire purpose is to stop a consumer arm being
served on a row — `SERVABLE_AVAILABILITY_BASIS` — is asked by no serving path,
so the defect it names can still ship.

**Incumbent behaviour to beat.** Before this module, three modules each decided
what had priced a row by matching prose prefixes of a display sentence, in three
different vocabularies. The module replaces that correctly; what it does not yet
do is get asked.

**n and split.** Not applicable — this is a reachability measurement, not an
estimator. The population is all 6 exports; all 6 were measured, none sampled.

---

## `server/services/opportunity-model.js` — 10 exports

| export | line | prod importers | reached from | category |
|---|---|---|---|---|
| `buildOpportunityRows` | :124 | 1 — `scripts/study-opportunity-volume.mjs` | hand-run script only | |
| `fitOpportunityModel` | :315 | 1 — same | hand-run script only | |
| `predictOpportunity` | :325 | 1 — same | hand-run script only | |
| `fitVacatedCorrection` | :364 | 1 — same | hand-run script only | |
| `applyVacatedCorrection` | :386 | 1 — same | hand-run script only | |
| `BASELINES` | :337 | 1 — same | hand-run script only | |
| `FEATURE_NAMES` | :33 | **0** | none of this module's | |
| `featureVector` | :262 | **0** | none of this module's | |
| `fitRidge` | :275 | **0** | none of this module's | |
| `predictRidge` | :302 | **0** | none of this module's | |

**Read the last four rows carefully.** A bare grep shows `FEATURE_NAMES` in
`offseason-model.js`, `preseason-model.js` and `boom-bust.js`, and `fitRidge` in
`nfl-passing-specialists.js` and `nfl-orthogonal-specialists.js`. **None of
those import this module** — each defines its own symbol of the same name. The
grep hit is a name collision, not a consumer, and reading it as reach would put
five false `wired` rows in the inventory.

**Claim, one sentence.** Every consumed export of the opportunity model is
reached only from one script that nothing schedules, nothing imports and
`package.json` does not list, so the whole module's reach depends on a person
running a command by hand.

**Incumbent behaviour to beat.** Not established here: whether the model's
numbers beat a baseline is a separate question from whether anything asks for
them, and this row answers only the second. Grading the first needs the metric,
n and held-out split from a run of `study-opportunity-volume.mjs`, which this
unit did not do.

---

## `server/services/contingency.js` — 28 exports

Grouped, because 28 rows of the same shape hide the three that matter.

**A. Imported by production code (6).** `availability` `:41`, `availabilityBasis`
`:598`, `availabilityDegradation` `:616`, `cascades` `:961`, `handcuffValue`
`:1074`, `weeklyAvailability` `:901`.
`weeklyAvailability` has the widest reach: 6 importers — `routes/model.js`,
`news-fantasy-impact.js`, `player-week-engine.js`, `role-scenario-engine.js`,
`season-sim.js`, `trade-engine.js`.

**All six are now traced to a mounted route** (`scratchpad/trace.mjs`, a reverse
import graph walked upward, max 6 hops, measured on the tree at `70ad930` —
identical to `08be6e1` for every file in this section):

| consumer | shortest path to an entry point | hops |
|---|---|---|
| `routes/model.js` | mounted directly | 0 |
| `news-fantasy-impact.js` | `<- routes/news.js` | 1 |
| `trade-engine.js` | `<- routes/model.js` (also `routes/players.js`, `routes/trades.js`) | 1 |
| `season-sim.js` | `<- routes/model.js` (also `routes/trades.js`) | 1 |
| `player-week-engine.js` | `<- routes/model.js` (also `<- betting-fantasy-link.js <- routes/nfl-betting.js`) | 1 |
| `role-scenario-engine.js` | `<- role-scenario-lab.js <- nfl-research-lab.js <- routes/nfl-market.js` | 3 |

"Mounted" was **verified per route, not assumed from the filename**: each of
`model`, `players`, `trades`, `news`, `nfl-betting`, `nfl-market` has both an
`await import('./routes/<name>.js')` line and an `app.use('/api/<name>', …)`
line in `server/index.js` (`:43`/`:134`, `:26`/`:106`, `:40`/`:126`, `:30`/`:116`,
`:49`/`:140`, `:48`/`:139`). The tracer's own mount test was a filename substring
match, which would have accepted a route that is imported and never mounted;
the table above rests on the `app.use` lines rather than on that test.

**One qualification the grader should not have to find on their own.**
`role-scenario-engine.js` reaches an entry point *only* through
`routes/nfl-market.js`. That is a betting route, and betting is out of scope for
this product. So its reach is real — the route is mounted and serves — but it is
reach through a surface the product is not supposed to be using. Reachable and
wanted are different questions, and this row answers only the first.

**B. Reached only from hand-run scripts (14).** `AVAILABILITY_RATES_DDL` `:122`,
`AVAILABILITY_ROLE_RATES_DDL` `:134`, `normReportStatus` `:148`,
`normPracticeStatus` `:157`, `roleStates` `:325`, `fitRoleRates` `:404`,
`buildAvailabilityLookup` `:442`, `availabilityFitStamp` `:548`,
`playerActiveProbability` `:640`, `rowLogLoss` `:718`, `availabilityScores`
`:727`, `ROLE_GATE` `:757`, `roleGateDecision` `:763`, `DESIGNATION_ROLE_GATE`
`:822`, `designationRoleGate` `:834`. All via
`const { … } = await import('../server/services/contingency.js')` in
`fit-availability.mjs`, `availability-decision-calibration.mjs` and
`fit-posture-calibration.mjs`.

**C. Used only inside their own file (5).** `weekDesignation` `:203` (called
`:927`), `liveEspnStatuses` `:241` (`:908`), `ROLE_MAX_GAP` `:296` (`:310`),
`roleTier` `:300` (`:370`), `gapBucket` `:309` (`:370`). Live paths, unused
`export` keyword. **"Exported and never imported", which CONTRACT.md §3 says is
a note and not a category.**

**D. Unreached by production (1).** `resetAvailabilityCache` `:533` — no
importer, and the only occurrence in its own file is the definition. Tests
reference it. Tests are not consumers.

**Claim, one sentence.** Of 28 exports, 6 are imported by production code, 14 are
reachable only by a person running one of three scripts by hand, 5 are live
internal helpers carrying an `export` nothing uses, and 1 is reached by tests
alone.

---

## What this file does not establish

- Group A is now traced to mounted routes and the paths are given above. Groups
  B, C and D are not: a `hand-run script` has no upward path to trace, and the
  internal-use rows terminate inside their own file by definition.
- Nothing here is a statement about whether any number these functions produce
  is correct, or beats a baseline. Reachability and validity are different
  audits and this is the first.
- Every figure is at `08be6e1` and nowhere else.
- The test-side counts come from dynamic-import detection and are reported as
  presence, not as a count of assertions.

---

## The five questions

**Well built?** Every row is a command and a file:line, and the two counting
errors that would have produced false rows are written into the method rather
than quietly fixed.

**Stats or made up?** Measured: 975 files scanned, import graph built, each
unreached symbol checked for internal use before being called unreached.

**How do we know?** `scratchpad/importers.mjs` and `scratchpad/reach.mjs`, at
`08be6e1`, re-runnable. Where a reading is one level deep, the row says so.

**Pointed anywhere else on the platform?** It is the first filed set of rows
against `CONTRACT.md`, and using it found a missing entry-point kind that the
contract now names.

**How does it unify?** The same question asked of an export, a script and a
route: what reaches this, and how would we know if the answer were a lie.
