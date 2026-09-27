---
name: measure-the-seam-do-not-read-it
description: When two threads build the producer and the consumer of a contract separately, run them together against the type specimen before either merges — reading both files agrees, running them disagrees.
metadata:
  type: feedback
---

**The rule.** When one thread publishes a contract and another consumes it, do
not verify the seam by reading both files. Assemble a tree with both sides and
run it against the **type specimen** — the input the feature exists to get right.
Do it before either side merges.

**Why.** 2026-09-22: `servedTables()` (Scheduler thread) published rules as
`current_rule.{sql, params, text}`; the freshness consumer (UI thread) read
`current_rule.{predicate, bind, description}`. Both files were well written, both
had headers explaining their shape, and both suites were green. Neither suite
imported the other side, so **nothing was red.** Run together on a real migrated
DB with the specimen loaded, the banner reported `fresh` on the exact stale data
it was built to report `stale` on. Detail: [[freshness-contract-seam-failed-open]].

**Why it failed open rather than loudly, which is the generalisable part.** Every
absent field had a reasonable default. `predicate` → `undefined` → `''`; `bind` →
`undefined` → `[]`; a placeholder guard counted 0 against 0 and passed; an empty
predicate fell through to a row count. **A chain of individually-sensible
defaults composes into a pass.** So:

1. A missing rule, config or predicate must be a **fault**, never a default that
   means "everything is fine". `throw`, or report a third state (`null` = "could
   not tell") — never silently the permissive answer.
2. A guard that compares two things which can both be zero/empty is satisfied by
   absence. Check presence first, then agreement.
3. A contract self-test belongs with the producer: run every published rule
   against the real schema and assert it returns the declared type. That one test
   is what surfaced this, and it also caught that 6 of 17 tables are created by
   numbered migrations rather than the legacy schema.

**How to apply.** Cheap recipe, ~10 minutes: `git archive <producer-sha> | tar -x`
into scratch, overlay the consumer's files from its branch with
`git show <sha>:<path>`, symlink `node_modules`, write a probe that loads the
specimen and prints the verdict, and run the same probe with the producer absent
as the **control**. Two opposite answers on one database is evidence nobody
argues with; two agreeing file headers are not.

Related: [[gridiron-suite-figure-rule]], [[test-seam-exports-stay]],
[[gridiron-failure-modes]].
