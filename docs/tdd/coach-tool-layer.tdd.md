# TDD evidence: the Coach tool layer (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "the model parts are spread for different functions
in the app but coach is well integrated with literally anything. Any article. Any stat.
Any opportunity area etc. coach should be able to answer things like who depth are. What
the coach scheme is like. What the game script is looking like. And then defend those
answers with stats."
**Slice:** 3 of the Coach rebuild — what Coach can actually do, and the one shape
everything it does comes back in.
**Files:** `server/services/coach/tools.js`; tests `test/coach-tools.test.js`.
**Commits:** RED `b590c2a`, GREEN `a8c450c`, mutation-driven tests `e374ee6` and
`56ced08`, this file after them.
**LLM spend:** $0. The tool layer makes no Anthropic call; it is what the model calls.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0). Tests run against the schema `runMigrations()` creates in a temp file and
fixtures the tests insert. No live read.

## 1. Audit: the three questions Nick named, and who already answers them

Nick's three examples are not hypothetical — the app already computes all three, and
none of them was reachable from the assistant on screen.

| Question | Already answered by | Reachable from the page assistant |
|---|---|---|
| "who depth are" | `server/services/who-plays.js#whoPlays` | no |
| "what the coach scheme is like" | `server/services/football-context.js#coachingProfile` | no |
| "what the game script is looking like" | `server/services/football-context.js#footballContext` | no |

All six tools of the assistant that is mounted today are betting tools
(`server/services/page-explain-tools.js:24,41,59,70,85,96`). So the risk here was never
"can the app answer this" — it was that a model asked one of Nick's questions with no
retrieval path would answer it anyway, from training.

The second risk is the opposite one and it is the reason for this file's strongest rule.
Given a tool layer, the tempting move is to write a small scheme summariser here, because
it is a dozen lines and the service's output shape is not quite what a prompt wants. Do
that three times and the platform has two numbers for the same question and no way to
say which screen is right. `nfl-team-tendencies.js:1-21` already makes this argument for
its own page: it replaced a written paragraph with measured percentiles precisely so the
claim could be checked. A second implementation here would undo that.

## 2. What was built

**One shape.** Every tool result becomes rows with named columns and is recorded in the
ledger, so a claim cites a service answer exactly the way it cites a SQL row. `toRows`
flattens whatever a service returns: an array of objects is already rows; an array of
scalars becomes a row each under `value`; anything else becomes one row whose columns are
the dotted paths to its scalar leaves (`out.0.player`). That is ugly to read and exactly
right to cite — a cite has to land on a scalar or it is not evidence.

Two ceilings keep one result from swallowing the context window (400 columns, 60 array
elements) and both set `truncated`. A silently shortened answer is the failure mode this
whole service exists to remove, so the flag is not optional; M29 removed it and a test
now catches that.

**Never re-implement.** Each service tool declares the file and function it calls and the
tables that function reads:

```js
service({
  name: 'who_plays',
  source: 'server/services/who-plays.js#whoPlays',
  tables: ['nfl_injuries', 'nfl_news_signals', 'nfl_snaps', 'news_source_validation'],
  …
})
```

A test asserts every service tool carries a `source`, imports that file, and checks it
really exports a function by that name, so a tool that computes its own answer cannot be
added here behind a plausible-looking declaration. The declared tables
become the result's provenance, read from the catalog, so a service answer carries the
same freshness and collection mode a direct query would.

**Seven tools.** `catalog_lookup` (what Coach may read), `sql_select` (the guarded query
layer from slice 1), `compute` (the ledger's eight operations), and the four service
tools: `who_plays`, `team_tendencies`, `coaching_profile`, `football_context`.

**`catalog_lookup` is the one tool whose result does not enter the ledger.** What Coach
may read is metadata about Coach, not evidence about football, and a claim about the
world must never be able to cite it. M30 made it record and a test kills that.

## 3. RED and GREEN

RED `b590c2a`: suite written against a module that does not exist; 0 pass, 1 file
erroring on import.
GREEN `a8c450c`: 14 tests pass, 0 fail. The mutation runs below forced three more and
the suite stands at **17 pass, 0 fail**.

One failure during GREEN was a real defect in another file and is recorded here because
it was not mine to fix. `test/coach-tools.test.js` failed with `no such table:
nfl_news_signals_current`. The cause is `who-plays.js:61`, which reads a view created by
migration 053 and imports nothing that guarantees the view exists — on a database where
migrations have not run, the availability layer throws rather than saying it has no data.
The test was fixed by running `runMigrations()`, which is correct for the test; the
latent defect was routed to the thread that owns `who-plays.js`, and the agreed fix there
is a labelled absence rather than a throw.

## 4. Mutation table — every injection APPLIED, by hash

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/tools.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. The
SHA-256 pair is the point of the row: a diffstat says something changed, a hash pair says
exactly which bytes the suite was run against, so the row can be reproduced without
guessing at the injection. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — that happened once in this sweep (M12's
anchor had the wrong punctuation) and is the failure mode the control below exists for.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M27 | a tool that throws still leaves its half-record in the ledger *(survived the first pass; the test in the last column was written for it)* | `tools.js` | `e9a0aeca` → `05a66c7b` | 2 | `coach-tools.test.js` — a service tool records rows the same way a query does |
| M28 | the column ceiling on a wide service result is removed | `tools.js` | `e9a0aeca` → `6a04e7a2` | 1 | `coach-tools.test.js` — toRows: a wide result is capped and says it was capped |
| M29 | a capped nested array sets no truncated flag *(survived the first pass; the test in the last column was written for it)* | `tools.js` | `e9a0aeca` → `2f80aa64` | 1 | `coach-tools.test.js` — toRows: a long array inside a nested object is capped and says so |
| M30 | a catalog lookup enters the ledger, so a claim about football can cite it | `tools.js` | `e9a0aeca` → `d37b76ff` | 1 | `coach-tools.test.js` — catalog_lookup tells Coach what it may read without touching the ledger |
| M31 | a service tool declares a function that does not exist | `tools.js` | `e9a0aeca` → `105c186b` | 1 | `coach-tools.test.js` — every service tool names a function that really exists, so no second implementation can hide |
| M32 | a service tool stops declaring the tables it reads, so its result has no provenance | `tools.js` | `e9a0aeca` → `630baf30` | 1 | `coach-tools.test.js` — a service tool records rows the same way a query does |
| M33 | sql_select ignores the row ceiling it was asked for *(survived the first pass; the test in the last column was written for it)* | `tools.js` | `e9a0aeca` → `816527e6` | 1 | `coach-tools.test.js` — sql_select honours the row ceiling it was asked for, and says it truncated |
| M79 | nothing at all comes back as one row holding null, so an absence is citable as a value | `tools.js` | `e9a0aeca` → `79430a5c` | 1 | `coach-tools.test.js` — toRows: nothing at all is no rows, not a row of nothing |
| M80 | a list of scalars is keyed item rather than value, so the cite grammar shifts under the model | `tools.js` | `e9a0aeca` → `adceb1c0` | 1 | `coach-tools.test.js` — toRows: an array of scalars becomes a row each, under `value` |
| NC-tools | NO-OP CONTROL: reword a sentence of the file header, changing no behaviour | `tools.js` | `e9a0aeca` → `1de5e3b9` | **0** | none — and that is the assertion |

**M79 and M80 were supplied by Model audit**, not found here, and they close the two
`toRows` behaviours this table left uncovered: an absence becoming a citable `null`, and
a list of scalars changing the column the cite grammar lands on. Both reproduce at the
hashes they were sent with.

**M27 and M29, the first two survivors.** M27 records a placeholder entry before calling
the service, so a service that throws leaves a stray `r`-entry behind and the next cite
resolves against a ledger nobody wrote. Nothing tested that a failed tool leaves the
ledger untouched, so a test was added asserting exactly that. M29 removed the `truncated`
flag on a capped nested array — the rows were still shortened, so every assertion about
content still passed, and only the honesty flag was gone. A test was added for the flag
itself. Both commit `e374ee6`.

**A weak test found while writing this file.** The declaration check asserted only the
*shape* of `source` (`path#function`) and covered three of the four service tools. Shape
is what a re-implementation would satisfy for free. It now iterates every service tool,
imports the file it names and asserts the export is a function; M31 was re-run against a
declaration pointing at a function that does not exist, and kills.

**M33, the third survivor, found in the second pass.** `sql_select` accepts `max_rows`
from the model and dropping it silently returns the default 200. Every existing test used
the default, so the ceiling was never exercised. The new test inserts six rows, asks for
two, and asserts the row count, the `truncated` flag and that a row past the ceiling is
not citable. Commit `56ced08`.

## 5. The five questions

**Is this well built?** The part worth defending is the restraint: four of the seven
tools are thin adapters over functions that already exist, and the only new computation
in the file is `toRows`. The declared `source` and `tables` are asserted by test, which
makes "never re-implement" a rule the suite enforces rather than a comment. The
awkwardness is `toRows`' dotted columns, which read badly in a log; that is the price of
every cite landing on a scalar, and it is paid once here rather than in every caller.

**Is it based on stats, or made up?** Every number a tool returns comes from a service
that was already shipping it to a page. `whoPlays` joins the official injury report,
typed beat-reporter signals and snap share with an explicit precedence rule and reports
disagreement rather than averaging it (`who-plays.js:14-19,108-112`). `teamTendencies`
measures 20 tendencies from 5,278 team-weeks of play-by-play and states each as a
percentile against the same season (`nfl-team-tendencies.js:1-21,97-181`). Nothing here
re-derives either, and the tool layer adds no number of its own.

**How do we know?** 17 tests, and 7 injections each stated above with the file's SHA-256
before and after it, all now killed, beside a no-op control that moves the hash and kills
nothing; three survived the first pass and produced three new tests. The claim that the
assistant on screen has no fantasy tool is line-cited to all six of its tool definitions.

**Should this data be pointed anywhere else on the platform?** One finding should go to
the thread that owns `who-plays.js`: `who-plays.js:61` reads the migration-053 view with
no guarantee it exists, so on a database without that migration the availability layer
throws instead of reporting an absence. That is the inert-layer shape CLAUDE.md names,
and it is already routed. Separately, the `source`/`tables` declarations here are a
machine-readable map of which service answers which question, which is the same thing the
wiring audit builds by hand; it is worth reading rather than duplicating.

**How does it unify?** This is the slice that makes Coach "integrated with literally
anything" rather than a second brain: the existing services *are* the tools, so the answer
Coach gives about the scheme is the same number the X's & O's page shows, from the same
function, with the same provenance. Where a question has no service, Coach writes SQL
through the guarded layer rather than growing a model for it.

## 6. What this slice does not do

Four service tools is not "anything". News articles, opportunity areas, waivers, lineup
calls, trade pricing and the season simulation all have services and none is wired here
yet; each is a descriptor of about fifteen lines, and each needs its tables in the
catalog first. The tools also cannot write, by construction — there is no tool that
changes a lineup, proposes a trade, or touches the live database, and adding one would be
a different decision than this file made.
