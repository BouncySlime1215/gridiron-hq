# symbol-reach.mjs — the namespace-import hole

**Commit measured on:** the commit titled *"test: RED — a namespace import is a
reach, and symbol-reach cannot see one"* (RED) → the commit titled
*"feat: GREEN — resolve namespace imports, so a scheduler job counts as a
consumer"* (GREEN). On this branch as pushed those are `9383c873` and
`28b801b8`.

Named by subject first and sha second on purpose. This pair has been
rebased twice — once when #99 merged and once when main moved again — and
each rebase rewrote both shas. An earlier revision of this file cited
`b885db2b`, which is not reachable from this branch at all: a reader
following it would have found nothing. A sha is worthless without its
tree, and a subject line survives a rebase.

**Reproduce:** `node --experimental-test-module-mocks --test test/symbol-reach-two-counts.test.js`

## What was wrong

`importersOfSymbol` read two binding forms — `import { name }` and the
`const { name } = await import()` destructuring — and nothing else. Three
forms were invisible:

```js
import * as ns from './defining.js';                       //  static namespace
const ns = await import('./defining.js');                  //  dynamic namespace
const ns = await import('./defining.js').catch(e => ...);  //  settled-promise chain
```

A symbol only ever called as `ns.name()` reported **zero** importers while
having real ones.

## How it was found

Not by a test. By being wrong in front of the Auditor.

Asked for the importers of `dispatchTriggeredCapture`, the tool answered
none. There are two — `polymarket-lines.js:269` and
`nfl-espn-line-watch.js:125` — and both call it through
`const dispatch = await import('./nfl-capture-dispatch.js')`. On that answer
a `dead` row would have been filed against a function the scheduler runs,
which is the exact false verdict CONTRACT.md's two-counts rule exists to
prevent. The tool built to stop bad rows was generating one.

Consequence, stated plainly: **every "importers of symbol X" figure this
tool produced before this commit is a lower bound** wherever a namespace
import exists.

## The rule, and the over-correction it must not become

`import * as ns` binds the whole module. Counting the binding alone would
make every export of that file look used by every importer — over-counting
as badly as missing it under-counts. The rule is that the property is
actually read off the namespace object: `ns.name`.

That negative rule was written in RED, where it **passed vacuously** —
nothing namespace-related was found then, so "not a reach" was true by
accident. Its comment says so. It earns its place at GREEN, as the guard
against the over-correction. The same trap the `enclosingDeclaration`
mutation walked into on this file: a fixture drawn from the bug is not
automatically a test of the fix.

## Rules added (4)

1. a namespace import whose property is accessed IS an importer
2. a namespace import is not a reach for a symbol it never touches
3. a settled-promise chain still binds the module: `await import().catch()`
4. smoke: `dispatchTriggeredCapture` has two non-test importers on this repo

## Mutations, all killed

| # | mutation | result |
|---|---|---|
| M1 | namespace binding counts without the property read | 1 fail — rule 2 |
| M2 | handle only static `import * as`, drop the dynamic form | 2 fail — rules 3, 4 |
| M3 | drop the `.catch`/`.then` chain unwrap | 1 fail — rule 3 |
| M4 | property read matches any name, not the symbol under test | 1 fail — rule 2 |

Restored: 18 pass, 0 fail.

M3 is the one worth noting. The `.catch` unwrap was written **before** any
rule covered it, found while reconciling against grep rather than from a
failing test. Rule 3 was added afterwards, specifically so the fix was not
carried on an untested line. Recorded rather than tidied away, because the
order was wrong even though the outcome was right.

## Independent cross-check, by a different mechanism

Per the rule that a figure from a bespoke tool is not carried until checked
by something that is not that tool: `grep -rnE` for the three binding forms
across `server/ client/src study scripts test`.

| source | count |
|---|---|
| grep | 189 |
| real code sites | 187 |
| grep false positives | 2 |

Both false positives are the parser being right and grep being wrong:

- `scripts/symbol-reach.mjs:190` — the form written inside a **comment** in
  this very fix.
- `test/offseason-model.test.js:631` — JavaScript inside a **template
  literal**, source text handed to a subprocess, not code in this file.

A regex cannot tell code from a comment or a string. That is the same
argument that put a real parser in this tool to begin with, and here it
scored against the checking mechanism rather than the tool.

**A caveat on the cross-check itself.** The first script written to count
sites re-implemented the tool's own detection logic rather than calling it.
A check that duplicates the code under test validates nothing — it agrees
with the bug. Only the grep is independent, and only the grep found the
three missing `.catch` sites.

## What this does NOT change

No file-level figure moves, and that is derivable rather than lucky.
`classifyImportEdges` in `reach-grade.mjs` builds edges from the **module
specifier** and never looks at the binding form, so a namespace import was
always counted there. Verified directly: both namespace callers of
`nfl-capture-dispatch.js` were already present in the file graph's deferred
edges before this fix.

So `183 wired`, the `116 / 67` split and the `53 / 14` line are unchanged by
this commit. The defect was strictly symbol-level.

## Still not covered

- `import('./x.js').then(m => m.name())` — the module binds to a callback
  parameter rather than a variable. No instance in this repo today.
- Re-export chains: `export * from './x.js'` then importing through the
  re-exporter.
- Property access through an alias of the namespace object
  (`const alias = ns; alias.name()`).
