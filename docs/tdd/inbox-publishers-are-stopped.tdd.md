# Two engines stop writing to an inbox with no reader and no routes

## The decision this implements, and its dependency

The Decision Inbox is retired end to end. Its four routes and its mount are
removed by the wiring map's `caac88a`, which is an ancestor of `4389a7a` on
`claude/wiring-map-8f96ur-route-gate-hold`: `server/index.js` no longer imports
`decisionInboxRouter` and no longer mounts `/api/decision-inbox`.

That premise was verified here rather than accepted, because this commit deletes
the only writers to a table and a wrong premise would make a data layer go inert
quietly — the failure class CLAUDE.md names and this project has already shipped
twice:

```
git show caac88a -- server/index.js        → removes exactly the import and the mount
git merge-base --is-ancestor caac88a 8307d09 → exit 0
git show caac88a:server/routes/decision-inbox.js | grep 'r.get\|r.post' → nothing
                                            publishRecommendation survives at :95
```

**This commit depends on `4389a7a`.** That commit rebuilds
`test/decision-inbox.test.js`, removing the two sections that assert these very
publishes, and narrows `test/decision-inbox-retired.test.js` from "these files
contain the string `publishRecommendation`" to
`typeof publishRecommendation === 'function'`. Without it, the suite after both
merge would fail on assertions pinning behaviour that was removed by decision.
This commit is off `main` and touches neither file.

## Why the table had to lose its writers

- Nothing serves it: the routes are gone.
- Nothing ever read it from the client: `decision-inbox` does not appear anywhere
  under `client/src`.
- The rows it did hold point nowhere: the waiver publisher wrote
  `link: '/brain'`, and `client/src/App.tsx` has no `/brain` route, so it fell
  through to the `NotFound` catch-all at `App.tsx:156`.

Two writers, no reader, and rows pointing at a page that does not exist.

The table and migration `020_decision_recommendations` are untouched. Dropping a
table is a migration and a separate decision; this is a change of writers.

## What was removed

- `server/services/waiver-brain.js` — the import and the 30-line publish block at
  the end of `waiverUpgrades`.
- `server/services/trade-engine.js` — the import and the 42-line block in
  `lineupDiff`, **including its `else` branch**, which expired its own previously
  published row with a hand-written `UPDATE decision_recommendations`. Removing
  the publish and keeping the UPDATE would have left a writer behind under
  another name.
- `import { run as dbRun }` in `trade-engine.js`, whose only remaining use was
  that expiry branch. `pickInventory` also reads as unused in that file, but it
  read that way on `main` before this change too, so it is left alone.

## What makes a zero mean anything here

"No rows were written" is the emptiest assertion available: it passes when the
table is missing, when the fixture produced nothing worth publishing, and when
the code under test never ran. All three are ruled out **before** the zero is
asserted:

1. The migration is asserted applied and the table asserted present.
2. A row is written by hand with `publishRecommendation` and counted, proving the
   table still accepts one — and proving the function itself survives, since it
   is the callers that stop, not the publisher.
3. The fixture's top upgrade is asserted above `0.75`, the exact threshold the
   deleted publish was gated on, and `waiverUpgrades`' return value is asserted
   intact. So the suppressed row is one the old code *would* have written, and
   the function demonstrably ran.

## RED

5 tests, 3 failing at `791b131`. Commit `d059c8d`.

The two that passed are the three guards above — they are meant to pass at RED,
because they describe the world rather than the change.

## GREEN

```
# tests 5
# pass 5
# fail 0
```

## Injections

| # | Injection | Applied | Result |
|---|-----------|---------|--------|
| 1 | The waiver publisher restored, import and call | APPLIED | 3 pass / **2 fail** |
| 2 | The helper stays gone but a `decision_recommendations` reference remains | APPLIED | 4 pass / **1 fail** |
| 3 | The lineup expiry's table reference comes back in `trade-engine.js` | APPLIED | 4 pass / **1 fail** |

### Injection 1 was malformed on its first run

The first form put `const { publishRecommendation } = await import(...)` inside
`waiverUpgrades`, which is not an async function. The module failed to parse and
the run came back `0 pass / 1 fail` — a load error, not a caught mutation.

A mutation that prevents the module loading proves nothing about the assertions:
every test fails for one reason that has nothing to do with the change. It was
re-run as a real restoration — the import at the top, the call in the function,
`node --check` confirming the module parses — and it fails 2 of 5 on the two
assertions that should catch it.

Recorded because `0 pass / 1 fail` looks like a very strong catch and is in fact
no catch at all.

## The five questions

**Is it well built?** It removes code and adds none. The one import dropped with
it is dropped because the removal orphaned it, and the one that was already
orphaned on `main` is deliberately left for whoever owns that finding.

**Is it based on stats, or made up?** No numbers are involved. The reachability
claims each name a file and line, and the load-bearing one — the routes being
gone — was read out of the commit rather than taken from a description of it.

**How do we know?** Three injections, each printed APPLIED, each caught, with the
first re-run after it turned out to be a parse error rather than a mutation. Plus
the three guards above, which exist so the central assertion cannot be vacuous.

**Should this data point anywhere else?** The question the retirement raises and
does not answer: `lineupDiff` computed a genuine "start X over Y" with a fitted
`p_right`, and that is now computed and shown only on the lineup page. Whether
that decision deserves a surface of its own is a product question on Nick's list,
not something to settle by keeping a writer to a dead table.

**How does it unify?** It removes a second answer rather than adding a third —
the same principle as the retired trade tombstones at `routes/trades.js:155`.
A capability with no surface is either given one deliberately or retired; what it
must not do is keep writing where nobody looks.

## Not in this commit, deliberately

`waiverUpgrades` itself is retired per the master plan's own decision
(`docs/FANTASY-ENGINE-MASTER-PLAN.md:489` — cut `waiver-brain` to its shared
helpers, `waiverBoard` on `/lineup` is the one waiver answer). It is **not**
removed here: `server/routes/trades.js:35` on `main` still imports it, so
deleting it from a branch off `main` breaks `main` if this merges ahead of the
route cut. It is a separate commit once that lands.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XL5WQkomfhtJ925G1wZ9yr
