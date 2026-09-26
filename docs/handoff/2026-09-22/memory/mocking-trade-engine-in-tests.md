---
name: mocking-trade-engine-in-tests
description: Two traps that make a Gridiron HQ test using a mocked assetUniverse pass for the wrong reason — the circular import through waiver-brain, and roster entries that need id and defaultPositionId.
metadata:
  type: feedback
---

Hit 2026-09-19 writing PR #62's tests. Both failures are silent: the test goes
green while the fixture is nothing like the thing under test. Exactly the
project's own failure mode, inside a test.

**1. `mock.module` on trade-engine.js does not reach waiver-brain.js.**
`trade-engine.js:73` imports `vegasLift` from `waiver-brain.js`, so the usual
pattern —

```js
const real = await import('../server/services/trade-engine.js');   // loads waiver-brain too
mock.module('../server/services/trade-engine.js', { namedExports: { ...real, assetUniverse: () => assets } });
const { freeAgents } = await import('../server/services/waiver-brain.js');
```

— loads `waiver-brain.js` as a side effect of that FIRST import, binding it to
the real trade-engine before the mock exists. `freeAgents` then calls the real
`assetUniverse`, which on an empty test database returns an empty map. The
pattern works for `waiver-wire.js` (`test/decision-leftovers-waivers.test.js`)
because nothing pulls that in early. **Symptom: a pool of 0 with no error.**

**2. A roster entry needs `id` and `defaultPositionId`, or `loadRosters` matches
nobody and says nothing.** `{ playerPoolEntry: { player: { fullName } } }` is
not enough. With no match, `me.players` is empty, `bestLineup` scores 0, and
**every free agent shows a positive gain** — so a test asserting "a real upgrade
is still found" passes against a completely broken fixture.
Use `{ playerPoolEntry: { player: { id, fullName, defaultPositionId } } }`;
ids are QB 1, RB 2, WR 3, TE 4, K 5, DEF 16.

**How to apply.** Prefer the real pipeline for anything about the asset
universe: `seedIfEmpty()`, a week-1 `schedule_games` row per team, the
side-effect route imports, then `player_season_stats` rows with
`kind='projected'` — only projected players get `adj_ppg > 0` and reach a pool.
`test/decision-inbox.test.js` is the working example.

Mandatory either way: **print `pool_size` and the resolved owner once while
writing the test.** Both traps above are invisible in the assertions and obvious
in those two numbers. And run the test against the unmodified file — a test that
passes there is testing nothing.

See [[verify-the-consumer-not-the-producer]],
[[feature-audit-shipped-prs-55-57]].
