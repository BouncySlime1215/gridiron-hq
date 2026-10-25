---
name: archetype-as-of-accessor
description: archetypesBuilt() in manager-archetypes.js is the one shared freshness accessor for the archetype store — name, fields, and the four states it tells apart.
metadata:
  type: project
  modified: 2026-09-20T06:39:55.713Z
---

**One accessor, use it, do not write a second.** Branch
`claude/project-thread-sytruo-asof-hold`, head `f2f321b` (held, no PR, GitHub
freeze 2026-09-20). Evidence `docs/tdd/archetype-as-of.tdd.md`, Parts 1–4.

```js
import { archetypesBuilt, PRICED_SOURCES, ARCHETYPE_BUILDER,
         WHY_UNSCHEDULED, RUN_SHEET_ONLY_METRICS, RUN_SHEET_ONLY_REASON }
  from '../services/manager-archetypes.js';

archetypesBuilt(leagueId, season, memberId = null)  // frozen object
```

- `as_of` / `rows` — whole league-season, any source
- `career_as_of` / `career_rows` — the roll-up keyed (member, **0**, **0**)
- `priced_as_of` / `priced_rows` — `source IN ('draft','outcome')`, **no metric
  allowlist**. The trade path uses this one, never `as_of`.
- `stale_version_rows` — rows on the key from a SUPERSEDED build version
- `jev_as_of` / `jev_answers` — **only when `memberId` is passed**; omitted
  otherwise on purpose, since `null` would read as "no answers stored"
- `built_by`, `reason` (null when nothing to explain)

`archetypesFor()` puts the identical object on every manager card as `built`; a
`deepEqual` test pins card == direct call.

**Four states it keeps apart, which is the whole point:** never built · built
but nothing priceable · built by an older version (stale, not missing — names
both versions and says re-run) · current. Before this they shared sentences.

**The divergence Trade Brain must expect.** `priced_as_of` will NOT always
equal the `archetypes_as_of` served today from `manager-signals.js:271`
(`archetypeIndex`). That function updates its `asOf` **inside** the row loop,
after a `continue` dropping any metric absent from its own `ARCHETYPE_METRICS`
map — so today's value is "newest stamp among the metrics that module maps" and
it moves when someone edits the map. Where the two differ, the old one is
wrong. Not switched yet as of 06:40Z 2026-09-20.

**Still open, Trade Brain's file:** `counterparty-pricing.js:144` treats an
unavailable credibility map the same as an empty one; `bluff-detector.js` now
returns a `reason` for it to read.

Provenance detail (three stores, three write passes) in
[[archetype-card-provenance]]. Mutation-run lesson in
[[mutation-run-catches-duplicated-reads]].
