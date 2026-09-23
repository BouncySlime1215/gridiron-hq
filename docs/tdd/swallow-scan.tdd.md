# The enumeration tool, and the two ways it was quietly incomplete (2026-09-22)

`scripts/swallow-scan.mjs` is the sweep that found three real defects on this
branch's lineage: the veto climate reporting `n: 0` for a table that does not
exist, the counterparty data key giving two different absences one word, and the
self-read telling Nick his league has no transaction history when the capture had
never run.

It ran from an uncommitted scratch file. That made the sentence "29 candidates,
8 real" a claim nobody could check, which is the same defect as a served number
with no provenance — the thing this whole branch lineage exists to stop. So the
tool is committed, and the two ways it was wrong are tests rather than a
paragraph.

Both were raised by the evidence auditor as gates before it could land.

## Gate 1 — the try it matches must be the try that matches

The first version found the nearest preceding `try` by scanning lines upward. A
closed inner `try {} catch {}` between the outer `try` and its `catch` steals
that match, and it steals it in two different directions:

| Shape | What the line scan does |
|---|---|
| read, then a closed inner `try/catch`, then the outer `catch` | the block considered starts **after** the read — the site is lost |
| a closed inner `try/catch`, then the read, then the outer `catch` | the block happens to span the read anyway — survives |
| the read **inside** the inner `try` | charged to the inner catch **and** the outer one |

The auditor's worked example was the second row, which is the one ordering the
textual scan survives. Recording that plainly: the gate was right about the
defect and its example did not reproduce it. The first row is the real miss and
the third is a real inflation, and both are now tests (`S1a`, `S1c`), with the
auditor's own ordering kept as `S1b` so the fix cannot break it either.

The fix is not a bigger lookback. `tryBlocks` matches braces on masked source,
so a try block is its own span and nothing else, and a read belongs to the
**innermost** try that contains it.

That required a real masker rather than a comment stripper. `/^[a-z_]{1,64}$/`
at `llm-budget.js:48` and a template literal holding `` `${a ? ` (${b})` : ''}` ``
at `port-guard.js:51` both carry braces that are not code, and counting them puts
every try block after them in the wrong place. `mask()` blanks comments, string
bodies and regex literals to spaces, keeps newlines so line numbers survive, and
carries a stack because `${…}` inside a template is code that may open another
template. This repo does that on at least five lines.

## Gate 2 — no fixed lookback

The cap was 25 lines. The true maximum span between `try` and `catch` in
`server/` is 122, and 26% of sites exceed 12. A cap does not make the scan
cheaper; it makes it report fewer sites than exist, and a floor presented as a
total is exactly the kind of number this branch is about.

## What the fix changed on the real tree

Not a thought experiment — both scanners run over `server/`, same tree:

```
RED sites 27    GREEN sites 27

FOUND ONLY BY THE FIX
  + server/services/polymarket.js:204  polymarket_quotes

DROPPED BY THE FIX
  - server/betting/nfl/forecast/python-artifact.js:52  python
```

**The miss.** `polymarket.js` opens its `try` at line 167 and closes it at 204 —
a 37-line span, so the 25-line cap never reached it. The catch is
`catch { /* one bad book must not stop the sweep */ }` sitting over a read of
`polymarket_quotes`. That table **is** created by `db/schema/mlb-model-misc.js:562`,
so it is not in the unmigrated set and not a defect of this family; the point is
that the enumeration could not see it at all, and nobody looking at the old
output would have known to ask.

**The false positive.** `python-artifact.js:52` is
`catch { resolve(unavailable('invalid JSON from Python scoring worker')); }`.
The string is in the **catch body**, not in the try block, and it contains the
words "from Python" — which `FROM\s+([a-z_]\w*)` reads, case-insensitively, as a
table named `python`. The old version included the catch line in the block it
searched. The new one takes strings from `[open, close)` of the try block only,
so a catch's own prose can no longer invent a table. This is also why the
string-literal filter alone was not enough: the earlier fix assumed English
prose only appears in comments, and here it was in a string.

## The set it reports today

On `e3bca56` (PR #94's head, this branch's base):

```
tables a migration or schema file creates: 273
bare catches over a literal SQL read: 27
  of those, reading a table with NO migration: 6

server/services/counterparty-pricing.js:817  league_transactions_raw
server/services/counterparty-pricing.js:934  negotiation_profiles
server/services/league-chat-sync.js:105      messages
server/services/nfl-ensemble-rank.js:656     nfl_ensemble_rank_reports
server/services/nfl-rebuild-progress.js:13   nfl_rebuild_progress
server/services/nfl-rebuild-progress.js:17   nfl_rebuild_checkpoints
```

Six, not the eight the scratch sweep reported, because the two `trade-tactics.js`
sites are fixed on this base (`c56be56`). The two `counterparty-pricing.js` rows
are fixed on PR #100 and are not on this base.

`migratedTables` is committed with it, because the scratch sweep took that set
from a hand-built file holding **62** names. The real count is **273**. A filter
that thinks 211 real tables are unmigrated over-reports risk, and over-reported
risk is how a sweep gets ignored. It reads `CREATE TABLE` out of both
`server/migrations` **and** `server/db/schema` — the second is the easy one to
forget, and `leagues` lives there. Its test asserts both, and asserts that
`league_transactions_raw` is **absent**, which is the fact the whole sweep exists
for: that table is created by a script and by no migration.

## The blind spot, stated rather than closed

A query built by concatenation or interpolation — `'SELECT … FROM ' + table`,
`` `FROM ${table}` `` — has no literal table name, so this scan cannot see it.
`counterparty-pricing.js:922` was exactly that shape, and the auditor was right
to call it a scanner gap; it is already fixed in code on PR #100, but the scanner
still would not find its like. Every site this reports is real. The set it
reports is a floor.

Five interpolated sites were read by hand and are **correct**, so a future
version that closes this gap must not flag them: `contingency.js:552` and `:563`,
`compute-cache.js:56` (tests for the missing table and re-throws),
`nfl-experiments.js:81` (marks unavailable), `llm-budget.js:395` (rolls back,
then throws). The discriminator is missing-table versus every other error.

## How we know

RED `91c6c14` (test: RED — the enumeration tool, against the two ways it was
wrong) — 9 tests, 6 pass, 3 fail: `S1a`, `S1c`, `S2`.
GREEN `08c729e` (feat: GREEN — the sweep matches braces instead of counting
lines, 9 of 9) — 9 of 9.
(The shas above were `8b95516` and its GREEN before a rebase rewrote them; the
content is unchanged.)
The RED scanner is re-runnable from the commit, which is how the table above was
produced: `git show 91c6c14:scripts/swallow-scan.mjs` against the same tree.

Liveness, re-run 2026-09-23 after merging `origin/main` (`a3e2bf3`): the RED
scanner restored over `scripts/swallow-scan.mjs`, current tests unchanged —
`# tests 9 # pass 6 # fail 3`, `not ok 1 - S1a`, `not ok 3 - S1c`,
`not ok 4 - S2`; S1a's assertion: `+ []  - [ 'league_transactions_raw' …`.
GREEN scanner restored — 9 of 9.

## The set on the merged tree (2026-09-23)

The table above is historical, measured on `e3bca56`. On this branch after
merging `origin/main` `a3e2bf3`, `node scripts/swallow-scan.mjs` reports:
276 tables created, 25 bare catches over a literal read, 4 reading a table with
no migration — `counterparty-pricing.js:1056` `league_transactions_raw`,
`:1173` `negotiation_profiles`, `league-chat-sync.js:142` and `:149`
`manager_chat_profile`. Main moved; the scanner did not.
