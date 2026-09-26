---
name: espn-player-market-dead-writer
description: syncEspnMarket has zero callers anywhere but is the sole writer of espn_player_market, which a live fantasy route reads at zero hops.
metadata:
  type: project
  modified: 2026-09-19T21:46:00.000Z
---

Re-verified in source on merged main `791b131`, 2026-09-19. Raised by the
wiring-map thread's `producer-with-no-caller` check; the item belongs to the
**feature-audit thread**, recorded here because the tail of
[[gridiron-fantasy-audit-findings]] is past the 4 KB recall cut and so this was
not retrievable.

**`syncEspnMarket` has NO callers.** `grep -rn syncEspnMarket server/ scripts/
test/` returns exactly one line: its own declaration at
`server/services/espn-market.js:18`. Not a route, not a job, not a test.

**It is the sole writer of `espn_player_market`.** So that table only ever holds
rows somebody put there by other means; nothing in the running app refills it.

**Readers, verified — and one is at ZERO hops, on a live fantasy surface:**
- `server/routes/aggregates.js:226` — `LEFT JOIN espn_player_market em ON
  em.espn_id = p.espn_id`, **read directly by a route**. This is the correction
  from the wiring thread: it is a fantasy surface, not betting scope, so it is
  IN scope under the fantasy-only priority.
- `server/services/preseason-model.js:336`
- `server/services/manager-archetypes.js:166` — "the only consensus we hold for 2026"
- `server/services/espn-market.js:69` and `:76`
- `server/services/consensus-weights.js:526` (live_rows count; `fittable: false`)
- **NOT a reader:** `draft-assist.js:590` is a provenance label string naming the
  table, not a query. An earlier note counting it as a read was wrong.

**Why it matters:** a table with a live route reader whose only writer never runs
is this project's signature failure — healthy-looking and not working. Whatever
is in it is stale by however long since it was last filled by hand.

**Status:** grandfathered in `scripts/wiring-map.mjs` source (not in
`annotations.json`) as of `2008d0a`, prints on stdout every run, and is listed
under `NEVER_BASELINE` so no accept-list entry can silence it. Retires when a
caller lands. See [[gridiron-wiring-map]], [[which-tree-is-production-running]].

**Caller decision settled 2026-09-19:** see [[espn-market-caller-decision]] —
one league by `MAX(season)`, skipped when that is not the current NFL season,
`{ limit: 1000 }`; the scheduler thread registers it. The `aggregates.js:226`
reader listed above is exactly why the rule keys on season.
