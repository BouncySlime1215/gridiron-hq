# TDD evidence: the Coach catalog and its read-only query layer (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "make sure the coach is properly built … make sure
coach is valid and doesn't hallucinate … train coach to pull all the data from the
entire data base and run calculations quickly to sense check things. Also any question
should be able to be asked."
**Slice:** 1 of the Coach rebuild — what Coach may read, and the one place it runs a
query it wrote itself. The answering loop, the grounding verifier, the fantasy tools and
the person profiles are later slices.
**Files:** `server/services/coach/catalog.js`, `server/services/coach/select.js`; tests
`test/coach-catalog.test.js`, `test/coach-select.test.js`.
**Commits:** RED `f3fa6ed`, GREEN `6a0fa7e`, this file and the two mutation-driven tests
after it.
**LLM spend:** $0. No Anthropic calls were made by this slice or by its tests.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0) before any suite number below. No production database is present: every
number here is from the schema the app creates on first import (215 tables) and from
fixtures the tests insert. Nothing was read from the live app and nothing was written to
it.

## 1. Audit: what Coach is today

There is no Coach. The budget line exists — `coach: 1.00` a day, with `coach:answer` and
`coach:route` documented as its sub-keys (`server/services/llm-budget.js:11-12,43`) — and
no call site uses it: the 24 `feature:` names in `server/` contain no coach. The
behavioural spec was written (`docs/COACH-PLAYBOOK.md`, 213 lines) and never implemented;
`docs/EXISTING-SYSTEMS-INVENTORY.md:39` says so and the grep it cites still returns
nothing.

What is actually mounted on every page is the betting desk's "what am I looking at"
assistant: `client/src/App.tsx:160` → POST `/api/betting/explain/page`
(`server/routes/betting-hub.js:902`) → `server/services/nfl-page-explain.js`.

Three ways it can state something untrue, each verified in this container:

1. **The vocabulary it is told to use does not exist.** `nfl-page-explain.js:26` reads
   `client/src/pages/betting/TERMINOLOGY.md`. That directory is gone — the 09-17 UI
   teardown removed it; `ls client/src/pages/betting` returns "No such file". Line 32
   catches and substitutes `"(glossary unavailable — explain conservatively and avoid
   disputed terms)"`, while the system prompt at :45-47 still says "using the glossary
   below" and "use these words and these meanings exactly; do not invent a synonym". A
   promised meaning that is not supplied is supplied from training. This is the silent
   inert layer CLAUDE.md forbids.
2. **No fantasy question has a retrieval path.** All six tools are betting tools
   (`page-explain-tools.js:24,41,59,70,85,96`). Four pages register what is on screen
   (`Lineup.tsx:64`, `TradeLab.tsx:66`, `TradeBrain.tsx:57`, `LiveDraft.tsx:372`);
   everywhere else the body is `{page_registered_visible_summary:false}`
   (`PageExplainAssistant.tsx:78`). Nick's own examples — who the depth is, the coach's
   scheme, the game script — land on pages with neither a summary nor a tool.
3. **Nothing checks the answer against what was retrieved.** `explainPage`
   (`nfl-page-explain.js:88-133`) parses `{paragraph, limitations}` and returns it. The
   only grounding is the prompt sentence at :60. Its sibling got this right:
   `/trades/:leagueId/sense-check` (`server/routes/trades.js:705-887`) runs a season
   simulation against the verdict and retries once when the numbers contradict it.

This slice removes the first two conditions for fantasy answers and lays the ground for
the third: a model cannot cite a table that is not in the catalog, and cannot read a
table the catalog does not describe.

## 2. What was built

**`catalog.js`** — 34 tables Coach may read. Each states what one row is, what it means
in words a person who does not read SQL can use, what refreshes it, whether it is
collected `auto` / `by_hand` / `derived` / `seed`, and which of its columns are withheld.
Columns are read live from `pragma_table_info`, never hand-copied. Absent from the
catalog means unreadable. `catalogCoverage()` reports the blind spot as a list: 215
tables exist in a fresh schema, 34 are catalogued, 181 are not, and Coach can say so
rather than guess at them.

`collection` is load-bearing, not decoration. Tonight's Finding 7 is that every manager
read in the app comes from rows a person collected by hand and no surface said so. A
`by_hand` table obliges an answer to show its age; an `auto` one does not.

**`select.js`** — one query, three independent guards:

1. a **read-only** `DatabaseSync` on the same file, so SQLite refuses a write at the
   storage layer even if every check above it were bypassed;
2. a **statement check**: one statement, `SELECT` or `WITH`, catalogued tables only, no
   withheld column mentioned anywhere. Which tables a statement reads is taken from
   SQLite itself (`StatementSync#columns()` names the real source table of every output
   column, seeing through aliases, subqueries and CTEs) and unioned with a token scan for
   tables that are joined but project nothing;
3. **bound parameters** (CLAUDE.md), so a value that looks like SQL is a value.

A policy refusal (`CoachQueryRefused`) and a SQLite error (`CoachQueryFailed`) are
different types, because retrying the first is pointless and the second is feedback the
model can act on. Neither is swallowed.

**A gap this found:** `leagues` carries the ESPN session cookies (`espn_s2`, `swid`) and
the cached payload in the same row as the league name and scoring. Coach must read that
table to answer any league question. Those three columns are withheld and cannot be
selected *or filtered on* — the filter case matters, because a `WHERE espn_s2 LIKE ?`
loop reads a secret a character at a time without ever projecting it.

## 3. RED, then GREEN

RED `f3fa6ed`: both suites written against modules that did not exist; both fail with
`ERR_MODULE_NOT_FOUND`.

GREEN `6a0fa7e`: 27 tests pass, 0 fail. After the mutation run below, three more tests
were added and the suites stand at **30 pass, 0 fail** (11 catalog, 19 select).

## 4. Mutation table — every injection APPLIED, by hash

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/catalog.json

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
| M1 | drop the readable-table check on the tables the text mentions | `select.js` | `8b72d33a` → `81a447e1` | 1 | `coach-select.test.js` — one catalogued table does not license an uncatalogued one beside it |
| M2 | drop the redacted-output check | `select.js` | `8b72d33a` → `9ef1f9ae` | 1 | `coach-select.test.js` — a redacted column cannot be selected, and the refusal names it |
| M3 | open the connection writable | `select.js` | `8b72d33a` → `a5cdd088` | 5 | `coach-select.test.js` — the connection itself is read-only, so the policy check is not the only thing standing there |
| M4 | drop the forbidden-keyword scan *(survived the first pass; the test in the last column was written for it)* | `select.js` | `8b72d33a` → `a01662d3` | 1 | `coach-select.test.js` — a forbidden keyword in the body of a WITH query is refused as policy, not left to SQLite |
| M5 | drop the one-statement check *(survived the first pass; the test in the last column was written for it)* | `select.js` | `8b72d33a` → `d8d2fbbf` | 1 | `coach-select.test.js` — a second statement is refused even when it is itself only a SELECT |
| M6 | never truncate | `select.js` | `8b72d33a` → `b0e1554c` | 1 | `coach-select.test.js` — more rows than the cap are truncated and say so, rather than being quietly cut |
| M7 | make a SQL error look like a refusal | `select.js` | `8b72d33a` → `7dfadc23` | 1 | `coach-select.test.js` — a broken query fails as a SQL error the model can act on, not as a refusal |
| M8 | stop stripping string literals | `select.js` | `8b72d33a` → `4175839c` | 1 | `coach-select.test.js` — a forbidden word inside a string literal is a value, not a keyword |
| M9 | catalogue a table that does not exist | `catalog.js` | `0e319c2e` → `0e1e4d29` | 2 | `coach-catalog.test.js` — every catalogued table exists in the schema |
| M10 | hand-copy columns instead of reading them live | `catalog.js` | `0e319c2e` → `b09ce81b` | 3 | `coach-catalog.test.js` — columns are read from the live database, not hand-copied |
| M11 | stop freezing the allowlist | `catalog.js` | `0e319c2e` → `190f430d` | 1 | `coach-catalog.test.js` — COACH_TABLES is frozen, so no caller can widen what Coach may read at runtime |
| M12 | drop the withheld-column list from leagues | `catalog.js` | `0e319c2e` → `ac6a676f` | 3 | `coach-catalog.test.js` — a table holding credentials declares them, so they can be withheld |
| M13 | mark every table as automatically refreshed | `catalog.js` | `0e319c2e` → `3cf2caa0` | 1 | `coach-catalog.test.js` — collection mode distinguishes hand-collected data, so an answer can show its age |
| NC-catalog | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `catalog.js` | `0e319c2e` → `ea721ff8` | **0** | none — and that is the assertion |
| NC-select | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `select.js` | `8b72d33a` → `2a07d544` | **0** | none — and that is the assertion |

**Two survivors, and what they proved.** M4 and M5 each changed nothing on the first run.
Both guards were real but redundant with a guard tested ahead of them: every write the
suite tried also failed the "first token must be SELECT or WITH" check, and every
multi-statement case had a forbidden keyword in its second statement. CLAUDE.md's rule is
that an injection the suite survives means the test is wrong, so two tests were added —
a forbidden keyword in the body of a `WITH` query, and a second statement that is itself
an innocent `SELECT` — and both mutations now kill. M8 was added for the same reason,
pinning the literal-stripping that makes `name = 'drop table players'` a value.

## 5. The five questions

**Is this well built?** It is the smallest thing that can carry the rest: a statement of
what Coach may read, and a gate that cannot be talked out of. Its enforcement is a
read-only SQLite handle, not a sentence in a prompt, and every guard in it is killed by a
mutation. The weak point is coverage, and it is stated as a number rather than hidden:
34 of 215 tables. Widening it is a deliberate edit to one file, which is the point.

**Is it based on stats, or made up?** Neither — this slice computes nothing and predicts
nothing. Every table's grain and meaning is read off its DDL and the service that writes
it (verified per table by grepping for its writer); every `collection` mode is read off
whether a scheduler job in `scheduler.js:1109-1428` refreshes it, a route writes it on
demand, a fit derives it, or it is seeded. Nothing here is a guess. Where a meaning is
summarised from the DDL rather than quoted from a service header, it is a description of
columns that exist, checked against the live schema by test.

**How do we know?** 30 tests, and 13 injections each stated above with the file's SHA-256
before and after it, all killed, beside one no-op control per source file that moves the
hash and kills nothing. The claims about today's assistant in section 1 were each re-run in this
container (the missing directory, the six tool names, the four registering pages, the
absent `coach` feature key), not taken from the inventory doc that also reports them.

**Should this data be pointed anywhere else on the platform?** Yes, and two places are
worth flagging to the threads that own them. (a) `catalogCoverage()` is a wiring-audit
input: 181 tables the app writes and Coach may not read is a different number from the
wiring map's uncalled-route count and measures a different gap, but it belongs beside it.
(b) The `collection: 'by_hand'` set is exactly the Finding 7 population — the tables whose
age a surface must show — and today the catalog is the only place that list exists as
data. If the as-of work lands elsewhere it should read this field rather than keep its
own copy.

**How does it unify?** Coach is not a second chat. The plan's own recommendation
(`docs/EXISTING-SYSTEMS-INVENTORY.md:196`) is to re-engineer the floating assistant
rather than add one, and this slice replaces the half of it that was betting-specific —
the glossary and the tools — while the mount, the round cap and the audit table stay.
The catalog will also front the existing services: later slices call `lineupCall`,
`waiverBoard`, `whoPlays`, `footballContext`, `seasonSim` and `counterparty-pricing` as
tools rather than re-implementing any of them, so one number has one source.

## 6. What this slice does not do

It does not answer a question. There is no loop, no verifier, no route and no UI yet, and
nothing in the running app imports either module — this is a foundation commit, and
`npm run check` passing is the only claim made about the app's behaviour. The grounding
contract (every claim cited to a retrieved row, a deterministic check that no number
appears that was not retrieved, one retry, then an honest refusal) is slice 2, and it is
the slice that actually removes hallucination rather than bounding it.
