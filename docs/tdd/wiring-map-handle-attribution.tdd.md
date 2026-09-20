# Which database a query ran on — RED, GREEN, and the byte in between

Branch `claude/wiring-map-8f96ur`, pushed to `claude/wiring-map-8f96ur-census-hold`.
RED `e39a024`. GREEN = the commit this file arrives in (a commit cannot record its
own hash).

## What was wrong

`docs/wiring/wiring-map.json` said `league_transactions_raw` had a create site on a
`chat` handle, opened on `chatFile`. It does not. The six create sites are
`scripts/collect-league-transactions.mjs:21` and five test fixtures, and the one the
map meant is `test/refresh-loop-steps.test.js:169` —

```js
run(`CREATE TABLE IF NOT EXISTS league_transactions_raw (league_id INTEGER, season INTEGER, ...`)
```

— a plain call on the **app** handle. The `chat` handle it was credited to is
declared at `:192`, twenty-three lines below, and creates `messages` and
`jev_chat_signals` and nothing else. The question that found this was "name the
chat-side create site and say whether its DDL is the same text as the app-side one".
There is no chat-side create site. The answer to the question was a defect in the
thing that produced the question.

## The three causes

**1. A literal backspace where `\b` was written.** `handleFor`'s second question read

```js
const viaHelper = before.match(/<0x08>([A-Za-z_$][\w$]*)\s*\(\s*$/);
```

No source file contains a `0x08` byte, so that match was **always null** and both
bare-call branches were dead from the commit that introduced them. `grep -P '\x08'`
over the whole tree finds exactly one occurrence outside binaries and it is that
regex. The shape is a `\b` eaten by a heredoc or an `echo -e` in an earlier edit.
Nothing ever went red, because the branch below returns `'app'` too and almost every
file in this repository is an app file — the fault was invisible everywhere except
the handful of files that hold a second handle.

**2. `foreignOnlyFile` read only static imports.** It tested
`/from\s+['"][^'"]*db\/index(\.js)?['"]/`. `test/refresh-loop-steps.test.js` takes
the app handle with `const { rows, run } = await import('../server/db/index.js')` at
`:31`, because it has to set `GRIDIRON_DB_PATH` first. A file demonstrably holding
the app handle was judged to hold none, and every unattributed query in it was
handed the first foreign name in the file.

**3. The order of the questions.** `rows` and `run` are app helpers AND the names
`server/services/league-history.js` gives its own foreign wrapper. So the foreign-only
question has to be asked BEFORE the app-helper one. Restoring the byte without moving
the branch reintroduces the false missing-feed on the sleeper-history tables that the
`foreignOnlyFile` branch exists to prevent — three tables with a writer sitting in
this repository, reported as written by nothing.

## The tests

| # | title | what it pins |
|---|---|---|
| 57 | a file with its own handle and no app-db import is foreign throughout | the ORDER (3) |
| 76 | the app handle is recognised when it arrives through a dynamic import | (2), and the real row |
| 77 | a bare call on a foreign handle is attributed to that handle, not the app | (1) |
| 78 | the checker source holds no control characters | the class of fault |

Test 57 already existed and **did not pin the order**: it passed `handleFor` the
offset of the SQL text rather than of the opening quote, one character later than
`build()` passes it, so the bare-call branch never matched in it and it could not
tell the two orders apart. It now asserts `f.text[at] === '`'` before it does
anything else. That correction is the reason M3 below kills something.

Test 78 is not decoration. A `0x08` renders as nothing in most editors and as an
invisible gap in a terminal. It survived every reading of that function, mine
included, and only a byte-level check catches it.

## Mutations

Baseline GREEN `scripts/wiring-map.mjs` sha256 `8d8bfba36af9`, 78 tests, 78 pass.
Each row is an edit applied to the GREEN file alone, the suite re-run, the file
restored. The checksum differs on every row, including the control, so a green
result cannot be the harness failing to apply the edit.

| id | mutation | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| M1 | put the `0x08` byte back in the `viaHelper` regex | `ed770da07307` | 76 / 2 | *a bare call on a foreign handle is attributed to that handle, not the app*, *the checker source holds no control characters* |
| M2 | `foreignOnlyFile` back to `from`-only imports | `20495962e792` | 77 / 1 | *the app handle is recognised when it arrives through a dynamic import* |
| M3 | app-helper branch back above the foreign-only check | `cd45f17c360b` | 77 / 1 | *a file with its own handle and no app-db import is foreign throughout* |
| M4 | NO-OP CONTROL: one word of a comment changed | `a8684f00d900` | 78 / 0 | none, correctly |

## What this table does NOT cover

`viaMethod` — the `x.prepare(` / `x.exec(` question — has no row here. It was never
broken, and it has no test of its own. That is an open item, not coverage.

**This paragraph was answered, and it was wrong in both directions. See the section
below.**

The `foreignDefault()` fallback takes the FIRST foreign handle in a file and does not
read which one is in scope at the offset. Every foreign-only file in this tree opens
exactly one handle, so no test can tell the difference, and the limit is written at
the call site rather than tested.

## Effect on the map

```
974 files, 325 -> 327 tables, 766 surfaces, 2236 -> 2236 findings, --check exit 0
```

Exactly one real row changed:

```
league_transactions_raw  create_handles ["app","chat"] -> ["app"]
                         create_handles_opened_with ["chatFile"] -> []
```

No finding moved. The two new tables are `zz_fixture_app_table` and
`zz_fixture_chat_table`, the fixtures of tests 76 and 77. They are named that way
because this file's SQL fixtures are read by the census like any other source: the
first draft of these two tests used the real names and handed
`league_transactions_raw` and `messages` a create site in `test/wiring-map.test.js`,
in a commit whose entire subject was that that row was wrong.

## The five questions

**Well built?** The fix is three lines of behaviour and one byte. The part worth
arguing about is the order of the branches, and it has a test that dies when the
order changes.

**Stats or made up?** Neither — this is attribution of a source edge, and every claim
in it is a file and a line in this tree.

**How do we know?** Four mutations with checksums, a control, and a before/after on
the generated map showing one row changed and no finding moved.

**Pointed anywhere else on the platform?** `handleFor` decides which queries count as
the app's, which decides `table-in-another-database` and every missing-feed verdict
that depends on it. The dead branch never changed a verdict, because its answer and
the fallback's answer agreed everywhere but here.

**How does it unify?** One question — "which database did this run on" — asked in one
place, in a fixed order, with the order written down.


---

# THE BRANCH THAT HAD NO ROW

The section above closed with an admission: `viaMethod`, the first of `handleFor`'s
three branches, had no mutation row, and the claim attached to it was that "no test
above would notice if its regex lost a byte the same way". Both halves of that turned
out to be worth checking rather than asserting, and checking them moved the answer in
both directions at once.

## Why the branch is worth a row at all

Not because it is broken. Because of what happens when it is deleted: nothing throws.

`audit.prepare(\`SELECT …\`)` with no method branch falls through to the bare-call
branch below it, which matches on the word `prepare`. `prepare` is not a foreign
handle and not an app helper, so the answer becomes `app` — a query on a second
database filed silently as the app's. That is the same wrong answer the `0x08`
produced, reached by a different road, and it is invisible for the same reason: a
wrong attribution does not print a wrong row, it merges into a right one.

## The claim was too strong

Baseline GREEN `scripts/wiring-map.mjs` sha256 `9bcf6ed6ab84`, 81 tests, 81 pass.
Same method as above: each row applied to the GREEN file alone, suite re-run, file
restored, checksum on every row including the control.

| id | mutation | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| M5 | the method branch deleted — `const viaMethod = null` | `402825759b6d` | 78 / 3 | *sqlEdges attributes a query to the handle that ran it*, *the app handle is recognised when it arrives through a dynamic import*, *a query handed to a handle by method call …* |
| M6 | `exec` dropped from the method list | `8321b2a976f1` | 79 / 2 | *the app handle is recognised when it arrives through a dynamic import*, *a query handed to a handle by method call …* |
| M7 | the `$` anchor dropped, so the method may sit anywhere in the window | `a7f7b64f5820` | 79 / 2 | *sqlEdges attributes a query to the handle that ran it*, *a query handed to a handle by method call …* |
| M8 | the method branch answers `app` where the file has no app handle | `ce9697fa8ad0` | 80 / 1 | *a query handed to a handle by method call …* |
| M9 | NO-OP CONTROL: one word of a comment changed | `d89023963069` | 81 / 0 | none, correctly |

Three of the five were already covered. *sqlEdges attributes a query to the handle
that ran it* and *the app handle is recognised when it arrives through a dynamic
import* catch M5, M6 and M7 between them, without the new test existing. So the
sentence "no test above would notice" was false, and it was written from reading the
tests rather than from running a mutation against them — the same shortcut this file
exists to argue against.

## The one that was genuinely uncovered

**M8 is killed by the new test and by nothing else.** A file that opens its own
handle and never imports the app's database module has no app handle to name, so an
unrecognised receiver in it cannot be `app`. The bare-call branch has asked that
question since the `0x08` fix; the method branch asks it too, on the line
`return file.foreignOnlyFile ? foreignDefault() : …`, and until now no test had ever
made it answer. 80 tests pass with that line gone.

That is the honest shape of this exercise: the open item was real, the reason given
for it was not, and the row that mattered was not the one the paragraph predicted.

## The five questions

**Well built?** No production line changed. One test was added over a branch that had
none, and one claim in an evidence file was retracted because a mutation contradicted
it.

**Stats or made up?** Neither. Five checksummed mutations with pass/fail counts from
the run.

**How do we know?** M8 fails one test and passes eighty. Delete the new test and the
defect ships green.

**Pointed anywhere else on the platform?** `handleFor` decides which queries count as
the app's, which decides `table-in-another-database` and every missing-feed verdict
downstream of it. All three of its branches now have rows.

**How does it unify?** The three branches answer one question in one order, and all
three orders are now written down as tests rather than as comments.
