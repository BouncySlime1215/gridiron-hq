# Running the rules the registry publishes

**Date:** 2026-09-22
**Branch:** `claude/project-thread-o3wt2p-freshness-evaluator`, off `a24692d` (PR #96)
**Files:** `server/services/source-registry.js`, `test/served-table-verdicts.test.js`

## The claim, in one sentence

`servedTables()` publishes a current-data rule for each of the seventeen tables
the app serves; nothing ran them, and the one consumer written against them read
a field the registry does not emit, so the freshness banner reported **fresh**
on the exact data it was built to call **stale**.

## How the defect was found, and measured

Not by reading. A tree was assembled with this registry at `a24692d` and the UI
thread's consumer (`server/services/data-freshness.js` and
`server/routes/data-freshness.js` at `3d92ccb` on
`claude/project-thread-xiezr0-data-freshness`), a real migrated database, and the
type specimen the whole feature exists for: `player_week_usage` holding 2021-2025
and nothing for the season being served, asked about 2026 week 3.

| registry in play | verdict | rule sentence shown |
| --- | --- | --- |
| the consumer's own one-entry fallback (this PR absent) | `stale` | yes |
| `servedTables()`, 17 entries (this PR present) | **`fresh`** | none (`current_rule: null`) |

Same database, same specimen, opposite answers. The full verdict on the specimen:

    { "table": "player_week_usage", "status": "fresh", "row_count": 15,
      "earliest": 2021, "latest": 2025, "current_rule": null }

Across all seventeen entries every rule read NULL, which makes `stale`
**unreachable** — the status that separates "the pipeline stopped" from "it never
started" could no longer be produced at all.

### Why it failed open

The registry emits `current_rule.{sql, params, text}` — a whole query returning
1 or 0. The consumer reads `current_rule.{predicate, bind, description}` — a
WHERE fragment. Neither field exists in the other's shape, so `predicate`
resolved to `undefined`, an empty predicate fell through to "count every row in
the table", and the consumer's placeholder guard was satisfied because zero
placeholders matched zero binds. Every guard on the path was individually
reasonable and the composition of them was a pass.

### Why the fix is not "also emit a predicate"

The tempting fix is for this registry to emit `predicate`/`bind` as well,
changing nothing of the consumer's. All seventeen rules were enumerated against
that shape and **two cannot be expressed as a row-matching WHERE fragment at
all**, because they are universals rather than existentials:

- `roster_players` — `MIN(fetched_at) >= datetime('now','-1 day')`, every NFL
  team refreshed within a day. A fragment matching one row answers "at least one
  team is fresh", which is *weaker than a plain row count*.
- `gamescript_model` — `COUNT(DISTINCT target) >= 2`, both of its targets
  fitted. A fragment matching one row answers "at least one target is fitted",
  which **is** the half-fitted-model bug the rule was written to catch.

Those two are precisely the rules worth having over a count. A fix that quietly
weakens them to make the other fifteen work is worse than the mismatch, so the
contract stays the shape that can carry them and the evaluator ships beside the
rules it evaluates.

## RED

`131ff61` — nine tests, 9 fail, all on `evaluateServedTable is not a function`.

`4f69011` — RED corrected. Two of the nine were also failing for a fixture
reason: the roster assertions inserted `league_id` and `player_id` into
`roster_players`, and neither column exists — the table is keyed on
`team_id REFERENCES nfl_teams(id)`, so it holds NFL team rosters, not fantasy
league rosters. That makes the first RED unusable as evidence for those two.
Rewritten against the real schema and re-run: still **9 of 9 failing**, all now
on the missing function.

Two further fixture facts surfaced by that correction, both of which changed the
test rather than the claim:

- `league_roster_snapshots` is created by migration **058**, and a harness that
  only opens the database gets the legacy schema. Test 3 failed with `no such
  table` until `runMigrations()` was added. Six of the seventeen served tables
  are migration-created, so a harness without it measures a database production
  never has.
- `nfl_teams` is migrated but **not seeded** — zero rows — so the roster test
  creates the two teams it needs rather than selecting them.

## A wrong sentence in the registry, fixed in the same commit

`roster_players`'s rule text read *"League rosters are current when every
connected league was refreshed within the last day"*. That table has no league
column; it references `nfl_teams`. The sentence is the one a user reads in the
panel, so it now says *"Team rosters are current when every NFL team was
refreshed within the last day"*, and states why it is a `MIN` rather than a
`MAX`: one team pulled an hour ago does not make the other thirty-one current.

## GREEN

`evaluateServedTable(entry, { season, week, database })` runs one rule and
returns `{ table, current, rule, grain, reader, error }`. It **throws** on every
rule it cannot run: no SQL, a placeholder count disagreeing with the bind list,
a bind name outside `['season','week']`, a query returning no row, or a value
that is not 0 or 1. A freshness check that cannot answer must not answer "fine".

`servedTableVerdicts({ entries, season, week, database })` evaluates all of them
and reports a rule that threw as `current: null` with `error` carrying the
reason. Three states, and the third is the point: a panel that silently dropped
a table whose rule threw would be the same lie by a quieter route, because the
reader counts what they can see and concludes that is everything. This is not a
bare catch — the error becomes a reported value on the response, which is the
only place a user could learn of it, and `evaluateServedTable` still throws for
any caller that wants the fault.

**11 tests, 11 pass, 0 fail.** Test 3 is the contract self-test the registry
never had: all seventeen published rules run against a fully migrated database
and each returns a boolean with a non-empty sentence.

## Mutation sweep — 8 applied, 8 killed

| # | injection | result |
| --- | --- | --- |
| 1 | an absent rule returns `current: true` instead of throwing | killed (test 4) |
| 2 | the placeholder/param count check is disabled | killed (test 5) |
| 3 | an unknown bind name is bound as `undefined` | killed (test 6) |
| 4 | `current: value === 1` becomes `value !== null` | killed (tests 1, 7, 8 — 4 failures) |
| 5b | a rule that threw is dropped from the result instead of reported | killed (test 7) |
| 6 | the reason a rule failed is replaced with `null` | killed (test 7) |
| 7 | a query returning no row becomes a quiet `current: false` | **survived first**, see below |
| 8 | the 0-or-1 check is disabled | **survived first**, see below |

**Two survived, and both meant the test was wrong.** 7 and 8 guard cases no
shipped rule can reach — all seventeen are aggregates, so none can return zero
rows, and none returns a count. They exist for the next rule written, which is
exactly the kind of guard someone removes after checking that the suite still
passes. Two tests were added to pin them, and both injections are killed on
re-run.

**One mutation is recorded as invalid rather than as a survivor.** The first
attempt at 5 changed `entries.map` to `entries.flatMap`. That passed all nine
tests because `flatMap` over object returns is identical to `map` — it was a
no-op, a badly chosen injection and not a gap in the suite. Re-run as 5b, an
actual drop, it was killed. Recorded because a sweep that quietly discards its
own bad injections is not a sweep.

## The five questions

**Is it well built?** Two exported functions, one appended block, no existing
behaviour altered — the registry's data is untouched apart from one corrected
sentence. The evaluator is pure over its inputs: it takes the database and the
season and week to bind, so nothing here depends on the wall clock or on
whichever database the container happens to have.

**Is it statistics or is it made up?** Neither. It runs developer-authored SQL
and reports 1 or 0. No estimate is computed and no number moves.

**How do we know?** A measured before-and-after on a real migrated database with
the type specimen loaded, the table above; eleven tests including a self-test
over all seventeen published rules; eight injections, all killed, two of them
only after the suite was corrected for letting them through.

**Is it pointed anywhere else?** Directly, yes, and this is the open item. The
consumer in `server/services/data-freshness.js` must delegate to
`servedTableVerdicts` instead of reading `current_rule.predicate`. **That file
belongs to the UI thread under the one-editor rule, so it is not changed here.**
Until it does, `servedTables()` reaching the consumer is a regression and
**#96 must not merge before that change lands** — together, or consumer first.
Nothing else reads `servedTables()`: `grep -rn servedTables server client` finds
only this file and the consumer.

**How does it unify?** It is the honesty rule this project keeps arriving at from
different directions: a layer that has gone inert must say so on the surface
rather than keep printing numbers. Here the inert layer was the freshness check
itself, and the failure mode was the one the codebase has shipped twice — a
silent catch, or in this case a silent default, deleting the answer while the
surface kept reporting health.
