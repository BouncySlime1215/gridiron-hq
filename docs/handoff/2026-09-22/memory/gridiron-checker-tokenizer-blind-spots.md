---
name: gridiron-checker-tokenizer-blind-spots
description: Two confirmed blind spots in scripts/wiring-map.mjs where the tokenizer saw a construct but lost what was read out of it, and the rule that catches the next one
metadata:
  type: project
  modified: 2026-09-20T01:29:54.770Z
---

`scripts/wiring-map.mjs` has now been confidently, silently wrong twice in the
same shape: **the tokenizer sees the construct, loses what was read out of it,
and every rule built on that view is capped without saying so.**

1. **Template literals** (fixed 2026-09-19, `docs/tdd/wiring-map-template-literal-uses.tdd.md`).
   `scan()` blanks a literal's whole body, correct for SQL, which made
   `value-computed-never-used` miss `${...}` interpolations. 95 findings -> 23;
   76% were false. See [[gridiron-checker-template-literal-blindness]].
2. **Namespace imports** (fixed 2026-09-20, `docs/tdd/wiring-map-namespace-imports.tdd.md`,
   #36 at `2e8cff3`). `moduleEdges` understood
   `const { x } = await import(...)` and `import(...).then(m => m.fn())` but not
   `const ns = await import(...)` (195 sites) or `import * as ns from` (8 sites),
   across 128 files. It recorded the file edge and no names, so
   **212 exports were reported `export-imported-by-nothing`** — 176 are
   test-only, 36 are imported by production code, e.g.
   `nfl-sim-policy.js#gameScriptPassRate` called at `nfl-drive-sim.js:293`,
   server to server. 2242 findings -> 2196.

**Why this matters more than the counts:** neither rule gates, so no build ever
failed and no PR was ever blocked. The damage is that
"exported and never imported" reads as *delete this*, and the map said it about
212 live exports, including `lineup-posture.js#SPREAD_SCALE`, which another
thread is actively re-fitting. A checker that is wrong in the severe direction
is worse than one that is silent.

**How to apply:**
- **When a rule counts uses of a name, enumerate which syntactic forms of "use"
  the extractor can see before trusting the count.** Both bugs were exactly this
  question left unasked.
- **Neither was found by attacking the tool.** Five attacks designed against it
  found neither. Both surfaced from **running it against another thread's
  branch** — the standing audit is what earns its keep, not inspection.
- **The finding that contradicts its siblings is the one to chase.**
  `reapAbandonedRuns` read as dead while four sibling exports in the same file
  read correctly. Same audit, two answers, therefore the tool, not the code.
- **Assert exact sets, not `.includes()`.** The first attempt at the namespace
  fix scanned the `text` view, which still carries string bodies, so
  `'./scheduler.js'` contributed a member named `js`. Only an exact-set
  assertion caught it. A second mistake — the static form landing as a
  duplicate import record, leaving the original nameless one first — was caught
  the same way.
- The member scan is deliberately one-directional: it over-claims a name as
  imported, which can only suppress an orphan finding, never invent a missing
  feed or fail a build.

Related: [[gridiron-wiring-map]] · [[gridiron-failure-modes]] ·
[[gridiron-tdd-defect-injection]] · [[gridiron-author-is-the-worst-reviewer]]
