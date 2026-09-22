---
name: gridiron-findtrades-cache-fixture-hole
description: findTrades' cache ignores an in-place tradeability edit, so the common test idiom silently returns the first search's deals and can pass against unfixed code.
metadata:
  type: project
  modified: 2026-09-22T17:44:56.528Z
---

`findTrades()`'s cache is fingerprinted by `tradeIdeasFingerprint`
(`server/services/trade-engine.js:1478`) on `manager_profiles`' row **COUNT**
and **MAX(updated_at)** — `fingerprint()` at `server/services/compute-cache.js:48-68`
reads exactly those two and nothing else.

The fixture idiom used across `test/trade-evidence.test.js` to "bust the search
cache" between two `findTrades()` calls:

```sql
INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (?,?,'fair')
ON CONFLICT(league_id, roster_id) DO UPDATE SET tradeability='fair'
```

moves **neither** once the row exists — the UPDATE changes no row count and
never touches `updated_at` (which is `DEFAULT (datetime('now'))`, written at
insert only, `server/migrations/015_manager_profiles.js`). The second
`findTrades()` therefore returns the *same object* the first one returned.

**Why this matters:** on 2026-09-22 two new end-to-end tests passed against
UNFIXED code this way. A test comparing two searches can be fully trivial and
look green.

**How to apply:** in any test that runs two `findTrades()` calls and compares
them, (1) bust the cache by writing a strictly newer `updated_at` on the same
row at the unchanged `'fair'` tier — `datetime('now')` is second-resolution and
is NOT reliably distinct, so write an explicit increasing literal; and (2)
assert **reference inequality** of the two results (`assert.notEqual(a, b)`).
Reference identity is the only liveness check a fix cannot satisfy by itself —
a text or field comparison can be satisfied by the very bug under test.
The helper is `reSearch()` in `test/trade-evidence.test.js` (PR #130).

Worth auditing anywhere else in the repo that compares two cached searches.
Related: [[gridiron-local-gate-includes-wiring-rule]],
[[gridiron-bespoke-tool-cross-check-rule]].
