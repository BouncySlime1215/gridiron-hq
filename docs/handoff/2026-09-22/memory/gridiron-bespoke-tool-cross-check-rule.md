---
name: gridiron-bespoke-tool-cross-check-rule
description: Rule (Auditor R32-R33, 16:32Z) — a figure from a bespoke tool isn't carried until one independent cross-check by a different mechanism has run against it
metadata:
  type: feedback
  modified: 2026-09-22T16:47:56.638Z
---
**Rule:** a figure produced by a bespoke, purpose-built tool (e.g. a custom reachability/inventory script) is not treated as carried/canonical until at least one independent cross-check, by a genuinely different mechanism — a grep-based count, a hand count, a different tool entirely — has been run against it and matches or reconciles. Re-running the SAME tool a second time does not count as a cross-check, even if the number repeats.

Origin: Opportunity's inventory tool had a namespace-import (`import * as ns`) blind spot that made every "importers of symbol" figure a lower bound; Auditor's own earlier prediction (R29.5, "bottom below 112") failed when checked, which is what prompted registering this as a standing rule rather than trusting either tool's output on its own.

**Also from this round:** inventory figures are **tree-dependent** — every reachability/inventory number must carry the commit/tree it was measured on, since a later commit can change what's reachable.

**Canonical example of what does NOT count (added 16:43Z):** after the fix, Opportunity's first "checker" for its own tool was a re-implementation of the tool's own logic — it re-derived the same figure the same way and called that confirmation. It validated nothing. Only the independent grep-based count was a real cross-check, and it caught 3 real misses (plus 2 grep false positives of its own, a comment and a template literal, which had to be reconciled too). A cross-check must use a mechanism that can fail differently than the thing it's checking.

**Corollary (16:45Z):** when two independent mechanisms disagree, that disagreement is a QUESTION to resolve, not a verdict for either side — do not default to trusting the newer, the bespoke tool, or the grep, on disagreement alone.

**Fleet tool 19:15Z:** `/mnt/project-files/mutate-run-v1.sh` — Feature audit's generic mutation sweep (six-line-per-mutant spec; reports NOT-APPLIED when an anchor matches more than once, e.g. `const season =` ×3 in aggregates.js, so a "survived" that is really "not applied" is visible). Cross-check per this rule: every run includes one known-killable mutant; a run with zero kills is a tool failure until that control dies. [[gridiron-state-1300-2026-09-22]]
