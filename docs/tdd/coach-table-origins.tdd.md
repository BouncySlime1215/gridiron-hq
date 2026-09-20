# TDD evidence: how a table comes to exist (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "train coach to pull all the data from the entire
data base … Also any question should be able to be asked." And the standing wiring-audit
ask: everything wired in, all data verified present.
**Slice:** 8 of the Coach rebuild — the catalog says what brings each table into being,
the coverage report stops conflating "not built here" with "catalogued and wrong", and
the query layer explains an absent table instead of repeating SQLite.
**Files:** `server/services/coach/catalog.js`, `server/services/coach/select.js`; tests
`test/coach-catalog.test.js`, `test/coach-select.test.js`.
**Commits:** RED `b0cc306`, GREEN `6743c35`, the `splitAbsent` seam and this file in the
commit that carries them.
**LLM spend:** $0. Nothing here calls a model.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0).

## 1. Audit: "the entire database" is not one kind of thing

The catalog described 41 tables and implied a single fact about all of them — that they
are there. They are not all there, and the ways they fail to be there differ. Nineteen
tables of the app database are created by neither `server/db/schema/` nor a migration:

- **Three are created by the database layer itself**, at boot: `schema_migrations` and
  `db_health_checks` (`server/db/index.js`) and `schema_preflight`
  (`server/db/preflight.js`). Infrastructure, not data; not catalogued.
- **Seven are created when a service module is imported.** `manager_signals` and
  `manager_player_view` (`manager-signals.js:42,51`), `manager_archetypes` and
  `manager_archetype_jev` (`manager-archetypes.js:74,86`), `league_member_identity`
  (`manager-identity.js:17`), `coach_answers` (`coach/audit.js:14`) and
  `coach_person_context` (`coach/people/context.js:32`). They exist on every boot and
  in no migration. `manager-archetypes.js:71-73` says so in a source comment, which is
  the only place it was written down.
- **One is created on its first write.** `nfl_ensemble_rank_reports`, inside
  `saveRankReport()` at `nfl-ensemble-rank.js:630`. It is a betting-side diagnostic
  ledger and is deliberately **not** catalogued; it is named here so the list is whole.
- **Eight exist only if somebody ran a script.** `nfl_availability_rates` and
  `nfl_availability_role_rates`, whose DDL lives in `contingency.js:121,133` but is
  executed only by `scripts/fit-availability.mjs:54-55`; `coach_person_variables`, from
  `scripts/build-person-profiles.mjs:57`; **`league_transactions_raw`**, from
  `scripts/collect-league-transactions.mjs:21`; `league_season_teams` and
  `league_week_scores`, from `scripts/backfill-league-history.mjs:43,48`; and
  `nfl_rebuild_checkpoints` and `nfl_rebuild_progress`, from
  `scripts/nfl-2022-2025-rebuild.mjs` — rebuild bookkeeping, not catalogued. These are
  the tables that make a fresh clone behave differently from Nick's Mac.

**`league_transactions_raw` is the one that matters most**, and it sharpens Finding 7
rather than repeating it. Finding 7 established that every manager read, archetype and
counterparty price stands on rows a person refreshes by hand. This is worse by one step:
the table is not merely refreshed by hand, it is *created* by hand, so on a fresh clone
it does not exist at all — and until this slice the catalog did not carry it, so Coach
could not even say that the record of what a manager has actually done was missing.

**Five names outside the declared schema are in a different database and are correctly
absent from all of this**: `negotiation_profiles`, `jev_chat_signals` and `messages`
belong to `data/derived/league_chat.sqlite`, and the `sh_*` family to
`data/derived/sleeper_history.sqlite`. Two more (`default`, `statement`) are template
strings that the scan matched and are not tables at all.

**A correction carried into this slice.** The 06:27Z note that
`decision_recommendations` is "created at runtime by the decision-inbox service, outside
`server/db/schema`" is wrong. It is migration `020_decision_recommendations.js`;
`routes/decision-inbox.js:7` points at that migration in its own header and the route
file contains no `CREATE TABLE`. Half of the note is true and much narrower: it is not
in `server/db/schema/`, which is also true of every other migration's table. It is
catalogued here as an ordinary table and names no creator.

Why this matters rather than being bookkeeping: without it Coach writes a perfectly
legal `SELECT` against `coach_person_variables`, SQLite answers `no such table:
coach_person_variables`, and that sentence reads to a model exactly like a misspelling.
The next move is an apology and a guess at a different name — a wrong answer produced by
a correct query. The truth is more useful and completely different: the question was
fine, the data has not been built here, and a specific script builds it.

## 2. What was built

**`created_at_runtime_by`**, null for a table the declared schema or a migration
creates, and otherwise a sentence naming what creates it and when. It is prose because
the interesting part is *when* the table appears — at import, on first write, or only if
somebody runs something — and a enum would flatten that. The paths inside the prose are
checked by test, so the sentence cannot rot into a lie about a file that was renamed.

**Fourteen tables catalogued**, 41 → 55: the five people tables, Coach's own answer
audit, the person context and person variables, the two availability fits, the three
league-history tables a script writes, and the Decision Inbox. They are the tables behind
"who is this person", "what has this manager actually done", "what has the app already
told me", and "will he actually play" — questions Nick asked Coach to answer and for
which it could not retrieve a single row. The five left uncatalogued are left so on
purpose and named in section 1: three database-layer tables, two rebuild ledgers, and
`nfl_ensemble_rank_reports`.

**`coach_answers` is readable, its blobs are not.** `answer_json`, `ledger_json` and
`plan_json` are withheld. The audit columns — did it verify, did it retry, how many
numbers were checked, what it cost — carry no football number and make "how often does
Coach fail its own check" answerable from the app's own rows. The blobs are different in
kind: letting a generated `SELECT` read a previous turn's ledger would let a number from
that turn arrive in this one dressed as retrieved evidence, which is precisely the
pooling hazard `verify.js` exists to stop, one level up and harder to see.

**Coverage reports two buckets where it reported one.** `missing_from_database` now
means "catalogued, absent, and nothing is known to build it", which is a defect;
`not_built_yet` means "catalogued, absent, and a script builds it", which is a machine
where nobody ran the script. Collapsing them hides both: the defect looks routine and
the routine case looks like a defect.

**The query layer explains the absence.** `explainAbsentTable()` turns SQLite's wording
into the catalog's sentence, and only for a table the catalog carries. An uncatalogued
name keeps the old message deliberately: the creator sentence says something about how
this app is built, and a name Coach does not read should learn nothing from asking.

## 3. RED and GREEN

RED `b0cc306`: four failing tests, 32 pass / 4 fail across the two suites.
GREEN `6743c35`: 16 pass / 0 fail in the catalog suite, 21 / 0 in the select suite, 160 /
0 across the whole Coach set.

Two things went differently from the plan, both recorded because they changed the work:

**The first RED was measured against the wrong definition.** The test asked whether a
*migration* creates the table, and `draft_picks` failed it — because the base schema at
`server/db/schema/core-and-fantasy.js:128` creates it, not a migration. The property is
"the declared schema does not create it", where declared means the schema files *and* the
migrations. The test was fixed before any implementation was written, which is the point
of running it red first.

**One existing test was changed rather than the implementation**, which CLAUDE.md
permits only when the test is wrong, so the argument is here rather than in a commit
message. "Every catalogued table exists in the schema" was true of 41 tables and is not
true of these three, and the alternatives were worse: drop them from the catalog and
Coach cannot say they exist at all, or assert something false. It now exempts exactly the
tables a script creates. The hole that opens is closed by the two new tests, and the
mutation table shows it: a fabricated table with no creator still fails, and a fabricated
creator fails the file check. M71 — which drops the field entirely — takes four tests
down with it, including that one.

**A seam was extracted to make a mistake visible.** `splitAbsent()` is exported and
tested with a list of its own, because `catalogCoverage()` can only ever be called
against whatever this database happens to hold: a bucketing error would be invisible
there on any machine where the buckets happened to line up. M73 and M74 are both killed
by that one test and by nothing else.

## 4. Mutation table — every injection APPLIED, by hash

Every row was re-measured at this head, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/creators.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. The SHA-256 pair is the
point of the row: a diffstat says something changed, a hash pair says exactly which bytes
the suite was run against. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — which happened to both controls on the first
run here, because their anchors had been written from the reworded text rather than the
source, and is exactly the failure the controls exist to expose.

**The last two rows are NO-OP controls**, one per source file. Each rewords a sentence of
the file's own header: the hash moves, so the harness demonstrably applied it, and no
test fails, so a zero in the "Red" column is a real result rather than a silent
non-match.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M70 | every table claims a runtime creator, including the ones a migration creates | `catalog.js` | `be236c57` → `a8873005` | 2 | `coach-catalog.test.js` — a table the declared schema does not create says who does, and one it creates says nothing |
| M71 | catalogEntry drops the creator, so nothing downstream can see how a table appears | `catalog.js` | `be236c57` → `732342c8` | 4 | `coach-catalog.test.js` — every catalogued table exists, unless only a script creates it |
| M72 | Coach's own stored answers, ledgers and plans become readable by a generated SELECT | `catalog.js` | `be236c57` → `3ea69501` | 1 | `coach-catalog.test.js` — the audit of Coach's own answers is readable, but the answers themselves are withheld |
| M73 | every absent table is filed as not-built-yet, so a wrong catalog entry reads as a script nobody ran | `catalog.js` | `be236c57` → `8c85b6c5` | 1 | `coach-catalog.test.js` — an absent table is sorted by whether anything is known to build it |
| M74 | a catalogued table that is absent and names no creator is reported as nothing at all | `catalog.js` | `be236c57` → `20770f70` | 1 | `coach-catalog.test.js` — an absent table is sorted by whether anything is known to build it |
| M75 | an absent catalogued table keeps SQLite's wording, which reads like a misspelling | `select.js` | `560ad857` → `1b155a37` | 1 | `coach-select.test.js` — a catalogued table that has not been built yet fails with who builds it, not SQLite's wording |
| M76 | the creator sentence is offered for a name the catalog does not carry | `select.js` | `560ad857` → `4c81e649` | 1 | `coach-select.test.js` — the friendlier wording is only for catalogued tables, never a name Coach does not know |
| NC-catalog-2 | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `catalog.js` | `be236c57` → `518976d3` | **0** | none — and that is the assertion |
| NC-select-2 | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `select.js` | `560ad857` → `e909903a` | **0** | none — and that is the assertion |

## 5. The five questions

**Is this well built?** The part worth defending is that the field is checked rather than
described. A comment saying "this table is made by a script" rots the first time the
script is renamed; a sentence whose paths are verified to exist and to contain the
`CREATE TABLE` cannot. The weak part is that the sentence is prose, so a reader can write
something true about the wrong table and only the path check would catch it — that is a
real gap, and it is narrow because the path check also requires one of the named files to
hold that table's own DDL.

**Is it based on stats, or made up?** It is not a statistic at all; it is a reading of
the source, and every claim in section 1 is line-cited and was read in this container
rather than taken from an inventory. The nineteen were found by scanning every
`.js` and `.mjs` under `server`, `scripts` and `client` for `CREATE TABLE` and
subtracting what `server/db/schema/` and `server/migrations/` declare, and each creation
site was then opened and read — which is how the DDL-in-one-file, executed-in-another
split for the two availability tables was found, and how the first, narrower scan was
caught being wrong.

**How do we know?** 16 tests in the catalog suite, 21 in the select suite, 7 injections
each stated above with the file's SHA-256 before and after it, all killed, and two no-op
controls that move the hash and kill nothing.

**A count in the first draft of this file was wrong, and the way it was caught is worth
keeping.** It said eleven tables sit outside the declared schema, from a scan of
`server/services` and `server/routes`. A repo-wide scan — every `.js` and `.mjs` under
`server`, `scripts` and `client`, minus the schema files and migrations — returns
twenty-nine names, of which nineteen are app-database tables, five belong to two other
SQLite files, two are template strings and three are the database layer's own. The
eleven were the ones I had looked for rather than the ones that are there, and the whole
`league_transactions_raw` finding above was inside the gap. The number in this file and
in the source comment is now the scan's, and the scan is a one-liner anyone can re-run.

The honest limitation: none of the eleven
was queried through Coach against real data, because three of them do not exist on this
machine and the rest are empty here. What is proven is that the catalog describes them
correctly and that an absent one produces the right message; what is not proven is that
the rows are useful, which needs Nick's database.

**Should this data point anywhere else?** The list itself should, and it is the wiring
map's more than Coach's: a third bucket beside the migration-only and test/script-only
ones, with the three-way split above rather than one "runtime-created" label. The
`decision_recommendations` correction goes with it. `splitAbsent()` is also the shape any
wiring audit wants — "absent and explained" and "absent and wrong" are different rows on
a report, and today no surface distinguishes them.

**How does it unify?** It gives one answer, in one place, to a question the platform has
been answering inconsistently: what does it mean for a table to be part of this app. The
catalog now says how each of its 52 tables appears, and the same field is what makes an
absent table produce a sentence a person can act on instead of a database error.

## 6. What this slice does not do

It does not catalogue `nfl_ensemble_rank_reports`, the two rebuild ledgers or the three
tables the database layer creates for itself. The first is a betting-side diagnostic that
nothing reads to make a forecast, the rebuild ledgers are bookkeeping for a one-off
backfill, and the database-layer three are infrastructure; the catalog's stated exclusion
covers all six. They are listed in section 1 so the nineteen is not silently thirteen.

It does not make the import-created tables appear in a database nobody has booted. The
catalog test imports the five service modules, which is what the server does at boot; a
tool that reads the schema of a cold file will still not see them, and that is a property
of the app, not of this slice.

It does not backfill the missing migrations. Seven tables being created by an import is
a real oddity — `manager-archetypes.js:71-73` already says a migration would be the
tidier home — but moving them is a schema change with a deploy behind it, and this slice
is the honest description of what is there today.
