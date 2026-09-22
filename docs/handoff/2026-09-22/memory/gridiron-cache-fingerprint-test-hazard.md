---
name: gridiron-cache-fingerprint-test-hazard
description: Lesson (Feature audit, 18:50Z) — findTrades' compute cache is keyed on manager_profiles COUNT + MAX(updated_at), so a test fixture that changes tradeability without bumping updated_at gets the previous search's cached objects back and passes on unfixed code
metadata:
  type: feedback
  modified: 2026-09-22T18:53:00.000Z
---
**Why:** while building #130, Feature audit found that the `findTrades` cache fingerprint (`trade-engine.js:1478` → `compute-cache.js:48-68`) is `COUNT(*)` + `MAX(updated_at)` over `manager_profiles`. A fixture that upserts tradeability alone leaves both unchanged, so the second `findTrades` call returns the first call's objects by reference — a test asserting on the second result passes whether or not the code under test changed ([[gridiron-state-1275-2026-09-22]]).

**How to apply:**
1. Any test that calls a cached search twice with a changed fixture uses a strictly-newer `updated_at` helper between calls (monotonic, not `Date.now()` which can collide within a millisecond).
2. Add a reference-inequality assertion (`assert.notStrictEqual(second, first)`) so a cache hit fails loudly.
3. When a "fixed" behaviour test passes on the unfixed code, suspect a cache before suspecting the assertion ([[gridiron-comment-right-assert-wrong-lesson]], [[gridiron-contradiction-test-rule]]).
4. Trade Brain sweeps its trade-engine tests for this shape; other owners check any test around `compute-cache.js`.
