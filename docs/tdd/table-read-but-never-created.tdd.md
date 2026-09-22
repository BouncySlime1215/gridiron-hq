# A table that nothing creates was invisible to the map

RED `866032e` · GREEN this commit · `scripts/wiring-map.mjs`, `scripts/inventory.mjs`, `test/table-read-but-never-created.test.js`

## What was wrong

Every table rule in this map starts from a CREATE statement, so it can only
describe a table that exists somewhere. The scanner built `tableUniverse` from
the CREATEs and then dropped every read whose table was not in it — one line:

```js
if (!tableUniverse.has(e.table)) continue;
```

A table created somewhere and read wrongly was tracked. A table created
**nowhere** was not there at all: no finding, no inventory row, not even
`unclassified`. That is the worst case of the category the honest inventory
exists for, and it was the one case the map was built not to see.

Found by the model-evidence audit thread by hand, not by this map.

## The filter is the rule

A bare "read but never created" sweep returns 60 names on this repository, 44
with a non-test reference, and almost none are findings. Each exclusion is a
category, and each is pinned by a test:

| exclusion | why, and the case that named it |
| --- | --- |
| views | `nfl_news_signals_current` is a `CREATE VIEW` at `server/migrations/053_nfl_news_signals_versioning.js:118`, read by `server/routes/news.js:230`. A rule that does not know views reports a working route's view as a phantom. |
| CTEs | `WITH ranked AS (…) … FROM ranked` reads a name its own statement defines. |
| DROP targets | `auction_sales`, `auction_settings`, `manager_profiles_legacy` — gone on purpose. Reporting them asks someone to restore what a migration removed. |
| builtins | `sqlite_master`, `sqlite_sequence`, `json_each`, `pragma_*`. |
| foreign handles | a read on another database's handle. Same reasoning `table-in-another-database` already applies to the chat corpus. |
| test-only | a name no product file reads is a fixture's business. |
| prose | an English string that merely uses SQL words. |

**Prose is handled at the source, not by a word list.** `sqlEdges` now blanks
SQL comments before matching, because `-- one row per capture run` is not a
query: this repository's `--` lines were producing table reads named `the`,
`a`, `successes`, `THIS`, `would`, `afterward` and single letters. Blanked to
spaces rather than deleted, so every line and column offset still points where
it did.

Three names survived even that, all English in non-SQL template literals — an
LLM prompt in `server/routes/players.js` beginning "Select a 2026 redraft
verdict", a claim string in `scripts/model-lab`, and a sentence in **this
scanner** explaining `INSERT … SELECT *` which read "FROM a JavaScript array"
and produced a table called `a`. The filter for those is on the STATEMENT:
a query carries `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, a qualified
JOIN or `ON CONFLICT`; a sentence does not.

**The filter that was deliberately NOT used:** "a table name must contain an
underscore". It would have killed all the prose in one line. Six real tables
here — `leagues`, `players`, `drafts`, `users`, `messages`, `reports` — have no
underscore, so that filter would have blinded the rule to every table named
their way. There is a test for it.

## What it found: 7 names, and only 3 are phantoms

| name | sites | reading |
| --- | --- | --- |
| `league_draft_picks` | `manager-archetypes.js:526`, `backfill-league-history.mjs:149` | **app-DB phantom.** Nothing creates it, and its readers are ordinary product code. |
| `play_by_play`, `pbp_participation` | `td-features.js:188`, `:310` | **phantom in a dead module.** `td-features.js` is `module-imported-by-nothing` with empty wiring, and `buildTdFeatures({ appDb, nflDb })` takes its handle as a parameter nothing supplies. |
| `adv_team_week`, `roster_weekly`, `snap_counts`, `player_value_weekly` | `nfl-weekly-feature-store-v2.js` | **not phantoms.** Every reader opens a satellite database — `SATELLITES` at `:81-85` names `data/line-history/nflverse.sqlite`, `line_history.sqlite` and `data/derived/player_value.sqlite`. Their schema is not this repository's to create. |

The satellite four are emitted as `kind: 'context'`, weight 0, saying so —
because the hand-off finding that reaches them is
`data-file-not-in-the-image`, which already reports that this image ships none
of those three files, and because the module itself degrades honestly: "A
missing satellite degrades the vector, it does not break the store" at
`nfl-weekly-feature-store-v2.js:99`.

**This corrects the finding as it was relayed.** It arrived as "neither table
is created anywhere in the tree — so the existing weekly feature store is an
inert path". The conclusion is right and the mechanism is not: the weekly
feature store's tables live in a satellite database, and acting on the stated
reason would send someone to write migrations for tables that belong in another
file. Acting on the real reason sends them to the deployment. It is the same
distinction already recorded for the chat corpus, where a table created by an
off-server Python script is not `referenced_but_never_created`.

## Effect

880 rows, up from 873. `referenced_but_never_created` 7 → 10, `unclassified`
538 → 541 (the satellite four, minus one that moved).

One other status moved and it is worth reading, because it was not intended and
it is a fix. `off_team_season` went `unclassified` → `half_done`. Before, the
map had it reachable from **25 route families, 8 jobs and 40 scripts**. That
entire reach came from one false reader, `server/db/schema/mlb-model-misc.js:329`
— prose in a comment inside a SQL string, the same comment that was producing a
table named `his`. With comments blanked, its only real reader is
`server/services/nfl-team-strength.js:141`, which is itself `module-only-tested`
with empty wiring. So the table is read by no live surface, which is what
`half_done` says. Two tables changed wiring in total; the other is
`player_metrics`, 25 route families to 22.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/wiring-map.mjs`.
Baseline green `6151bc2deaa9c32b`, 11 pass / 0 fail.

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| V1 | drop the `views` exclusion | `fa768aaa8ed8771d` | KILLED 10/1 | *a view is not a phantom* |
| V2 | drop the structural-clause filter | `673b35a8cc8ad5da` | KILLED 10/1 | *an English string with SQL words in it is not a query* |
| V3 | drop the foreign-handle filter | `cdbebba097081122` | KILLED 10/1 | *a read on a foreign database handle is not this repository's to create* |
| V4 | drop the CTE exclusion | `c63920afb4efd429` | KILLED 10/1 | *a CTE name read back in the same statement is not a table* |
| V5 | drop the DROP-target exclusion | `1b126fd5e37ebeaa` | KILLED 10/1 | *a dropped table is gone on purpose, not missing* |
| V6 | stop blanking SQL comments | `eac7e23d36855197` | KILLED 10/1 | *SQL comments inside the query are not read as tables* |
| V7 | control, comment text only | `c8467e0e73639917` | SURVIVED 11/0 | — |

V7 as first written edited a string that does not occur in the file, so it
changed nothing and its tree hash was identical to the baseline. A mutation
that does not mutate is not a control, it is a no-op that proves nothing, so it
was rewritten against text that exists and re-run. Recorded rather than
quietly replaced.

## The five questions

**Well built?** One new rule, one new filter, both behavioural: the tests build
file entries and read what comes back, and two of them run against the real
source of the files in question rather than a fixture.

**Stats or made up?** Measured. 60 raw names, 44 non-test, 7 after the filter,
3 phantoms and 4 satellite. 880 inventory rows, 2 tables' wiring changed, 1
status moved.

**How do we know?** `node --test test/table-read-but-never-created.test.js` —
0/9 at RED `866032e`, 11/0 at GREEN. Six injections killed with the killing
test named, one control, and the control's own first attempt recorded as the
no-op it was.

**Pointed anywhere else on the platform?** Yes, and that is the finding. Three
of the seven names are in code nothing reaches, so the inert path was already
covered by `module-imported-by-nothing` and `data-file-not-in-the-image`. The
one that is not is `league_draft_picks`, read by `manager-archetypes.js`, which
no other rule flags.

**How does it unify?** The map could describe what exists and not what is
missing. An inventory that only enumerates what was created cannot answer "what
is silently broken", because the most broken thing in a codebase is a read of
something that was never built.
