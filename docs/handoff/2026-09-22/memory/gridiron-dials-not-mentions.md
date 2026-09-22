---
name: gridiron-dials-not-mentions
description: A path or symbol named in prose, a comment, an import line or a test message is not a caller — the distinction that decides every "is this dead" verdict in Gridiron HQ, and it has been got wrong in both directions.
metadata:
  type: feedback
---

**The rule.** Before calling anything unused, split its references into DIALS (the
path inside a call that fetches it, the symbol inside an expression that runs it) and
MENTIONS (prose, comments, assertion message strings, import lines, documentation).
**The verdict rests on dials only.** Keep a third bucket, `unclear`, for lines a
classifier will not call either way — it is a request to read the line, not a verdict.

**It has been wrong in both directions in one night (2026-09-20), which is why this is
a rule and not a preference.**

Missing a dial nearly deleted live code. `scripts/bootstrap-data.mjs:104` writes
`` `/api/edge/gamelogs/sync?season=${s}&limit=400` `` — literal first, interpolation in
the query string. The wiring map's outbound patterns both needed a marker to the LEFT
of the path, so **nine live routes** sat in `route-no-caller`, including
`POST /api/aggregates/refresh-all`, whose deletion stops a fresh install loading ADP,
market values and news.

Counting a mention as a dial invents callers. `/api/dev/llm-budget` appears once in the
tree, in `docs/tdd/llm-plumbing.tdd.md`, as a line recommending somebody BUILD that
route. `/api/dev/sources` has four references and not one is a dial: two docs, a
comment, and a message string. Treat `docs/` and comments as never-callers unless the
string is in an executable command line — a fenced `curl` in a run sheet counts, and
say so per hit.

**The same distinction at symbol level**, where it is easier to get wrong:
- A **comment** naming a function is not a call site. A paragraph describing a chain
  was read as a caller and a report concluded nothing was dead — on its own example.
- An **import line** is not a use. Matching a bare name picked up
  `import { positionLiquidity }` in the file whose handler was dying and counted it as
  a survivor; falling symbols went 36 to 0. Confident, specific, wrong.
- But matching `name(` is **too strict**: `requireAuthenticated` is express middleware
  and never has a paren after it. Match the bare name and exclude comments, imports and
  declarations. Over-counting a caller costs a missing row; under-counting it costs
  somebody deleting live code.
- `export const X =` is not a function unless a function follows. `export const db =
  new DatabaseSync()` has no `db(` anywhere, so the handle the whole server uses read
  as unreached, in a list where most rows were that shape.

Related: [[gridiron-failure-modes]], [[gridiron-checker-unreadable-output]],
[[gridiron-route-verdicts-one-source]].
