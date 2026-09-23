# A path in a string is an edge no import graph can see

Retroactive RED by injection. New report-only rule `source-reads-a-file-under-docs`,
written because another thread found by hand a fact this map had 2,331 findings and no
way of saying.

## The fact

`docs/CLAUDE-NEXT-STEPS.md` is not documentation. `server/services/nfl-research-lab.js:279`
reads it off disk and serves it, and `test/nfl-execution-integrity.test.js:258` compares
it byte for byte. Editing a markdown file changes what a route returns and turns the
suite red. It is application data wearing a document's clothes.

Before this rule, zero rows in `docs/wiring/wiring-map.json` mentioned that file.

## Why it was missed, which is more specific than "no file reads are modelled"

They are modelled. `runtimeFilePaths()` has parsed `path.join(BASE, '…')` since it was
written. It feeds exactly one rule, `data-file-not-in-the-image`, which asks whether the
Docker image copies that directory — and that rule requires `BASE` to be one of
`process.cwd()`, `ROOT`, `REPO_ROOT`, `PROJECT_ROOT`. `nfl-research-lab.js` joins a local
`root`, so the row was discarded before anything looked at it.

Even recognised, the only question asked would have been a deployment one. **The gap was
not a missing parser. It was a file read modelled as a deployment question and never as
a dependency edge.** That sentence is the finding; the rule is the consequence.

## What it finds, and one correction it forced

Nine rows on this tree. Two are server modules, which is one more than the hand count
and one more than this thread reported an hour ago:

| file:line | path | class | exists |
|---|---|---|---|
| `server/services/nfl-research-lab.js:279` | `docs/CLAUDE-NEXT-STEPS.md` | served | yes |
| `server/services/nfl-learned-shadow-explain.js:37` | `docs/betting-model/research/experiment-results/unified_margin_audit` | served | **no** |

The second was found by the rule, not by a person. It is betting-side and out of scope
for work, and it is guarded by an `existsSync` so it returns null rather than throwing —
but a server module builds a path under `docs/` that no commit has ever produced, and
nothing said so. The correction owed is to the sentence "CLAUDE-NEXT-STEPS.md is the only
file under docs/ that any server module reads at runtime": that is true of markdown
documents and false of `docs/` as a whole.

The other seven are `tooling` — scripts reading `docs/wiring/*.json`. Different class on
purpose: moving one of those breaks a report rather than a route, and a rule that merges
the two consequences teaches nobody which they are looking at.

## Mutations

Baseline GREEN `scripts/wiring-map.mjs` sha256 `c6435c3469b9`, 84 tests, 84 pass,
measured source-isolated on the tree that became the commit carrying this file.

| id | injected defect | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| E1 | the `path.join` arm removed; only bare read calls are seen | `e1eae92fed48` | 83 / 1 | *a source module reading a file under docs at runtime is an edge, and it is reported* |
| E2 | a script is classed as `served` | `768171164aba` | 83 / 1 | *a source module reading a file under docs …* |
| E3 | the test tree is in scope | `2db00b9412d3` | 83 / 1 | *a source module reading a file under docs …* |
| E4 | existence is assumed rather than checked | `2bd76445d068` | 83 / 1 | *a source module reading a file under docs …* |
| E5 | NO-OP CONTROL: one word of a comment changed | `322b873602f1` | 84 / 0 | none, correctly |

### The exact edits

**E1** — `docsRuntimeReads()`:
```
-    for (const r of runtimeFilePaths(f.text)) {
+    for (const r of []) {
```

**E2** — the class assignment:
```
-    const klass = f.tree === 'server' ? 'served' : f.tree === 'script' ? 'tooling' : null;
+    const klass = f.tree === 'server' ? 'served' : f.tree === 'script' ? 'served' : null;
```

**E3** — the tree filter:
```
-    if (!klass) continue;
+    if (!klass && f.tree !== 'test') continue;
```

**E4** — the existence check:
```
-        cited, klass, exists: index.has.has(cited) || fs.existsSync(path.join(ROOT, cited)),
+        cited, klass, exists: true,
```

**E5**, the control — a comment, no behaviour:
```
- * Two classes, because the consequence differs
+ * Two kinds, because the consequence differs
```

### A test no mutation kills, and why it stays

*the rule reproduces the runtime docs read that was found by hand* reads the committed
`wiring-map.json` rather than running the rule, so no edit to the source turns it red. It
is not coverage and is not offered as coverage. It is the trust test: a new checker is not
believed until it reproduces, without being told where to look, something a person already
found. If the committed map ever stops containing that row, it fails.

E3 is the row worth reading twice. This test file is full of `docs/` paths, and three
earlier rules in this family have each reported their own fixtures as facts about the
repository. The tree filter is the only thing standing between this rule and a fourth.

## The five questions

**Well built?** One function, two classes, report-only. It gates nothing, because
depending on a file is a fact rather than a defect.

**Stats or made up?** Neither — five checksummed injections and nine rows read out of the
generated map.

**How do we know?** Four of the five fail a test; the control passes. And the rule found a
second server-side read that no person had named, which is the only real evidence that a
checker is doing work rather than confirming a list.

**Pointed anywhere else on the platform?** `/research-lab/plan` serves one of these files
to a user. Every other thread's assumption that `docs/` is inert is wrong in two places.

**How does it unify?** A dependency is a dependency whether it arrives by `import` or by
`path.join`. The map now says both in the same place, in the same shape.
