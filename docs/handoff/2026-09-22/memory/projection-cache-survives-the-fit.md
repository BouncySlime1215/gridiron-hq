---
name: projection-cache-survives-the-fit
description: RETRACTED as an explanation of the weekly/season-long split (see projection-basis-split-by-recency) — but the cache hazard it describes is real: two projection memos are keyed without a fit id and a separate-process promotion reaches neither.
metadata:
  type: project
---

Found 2026-09-19 ~21:20Z by the UI-rebuild thread, checking a relayed claim
before building UI on it. **Read in source on `main` (ffe4e72); not reproduced
against the live process.**

## RETRACTED, 2026-09-19 21:40Z — read this first

The hypothesis below is **wrong as an explanation of the split**. The
opportunity thread answered the distinguishing question directly: the
comparison was computed **in-process**, with no HTTP and no `memo()` on the
path. And the source reading below was taken on ffe4e72, which predates #15 —
`activeKVectorFor` does not exist on that tree. The real mechanism is a
deliberate recency guard: see [[projection-basis-split-by-recency]].

**What survives is the cache hazard itself**, which the opportunity thread
agrees is real and which the sections below describe correctly: both projection
memos are keyed without a fit id, and a promotion run by a separate process
reaches neither. It does not bite tonight, because the guard withholds the
vector whether a memo entry is stale or fresh. Treat the restart advice as
hygiene, not a blocker.

## The claim

From the opportunity thread via the coordinator: the shrinkage promotion (step
8) "reaches only the weekly projection path" — Start/Sit and Trade Lab move,
draft board / ROS / season sim / playoff odds keep the old constants, **0 of
1,130 season-long projections changed**.

## Source reading that was wrong

Retracted: see the section above and [[projection-basis-split-by-recency]].

## The mechanism that fits the measurement

`routes/model.js:107-111`: `const cache = new Map()` with
`memo(key, fn)` — unbounded, no TTL, key `proj:${through}:${scoring}`, **no fit
id**. Once a season-long route is served, that Map holds pre-fit numbers for the
life of the process. The weekly engine caches too
(`player-week-engine.js:52`) but through `remember(..., MAX_ENGINE_CACHE = 32)`,
an LRU that evicts — so weekly entries recompute and pick the fit up.

That reproduces the asymmetry exactly with no path difference. **Hypothesis,
not measurement**: it holds only if the 1,130 comparison was taken over HTTP
against a warm process. The distinguishing question is exactly that one.

## Why it matters

The promote script is its own process (`fly ssh console -C`): it writes SQLite
and cannot reach the server's Maps. So an after-read from the running server
after a promotion may be cached — MEMORY.md's own "a cached answer reading as
'nothing changed'".

**No safe lightweight cache-bust exists.** `POST /dev/refresh-all`
(`dev.js:99`) repulls every source (heavy tier, wedge risk); the nfldata sync
route (`model.js:631`) is worse; `POST /api/leagues/:id/sync`
(`leagues.js:213`) clears it but **re-syncs `dynasty_values`** — tonight's
after-read control variable, which must not move. **The clean bust is a process
restart**, sequenced after the promotion and before the after-reads.

## The durable fix

Put the active fit id in both cache keys (`proj:${fitId}:…`, and the engine's
`cacheKey` carries it instead of the literal `'active'`,
`player-week-engine.js:164`). Needs an `activeFitId()` accessor —
`activeKVector()` reads the id and discards it.

## Consequence for the UI

Do **not** hardcode "these surfaces are on the older basis" into a page.
Whether a number is fitted depends on process state, not on which screen it is.
The label must be a served field or the UI states the wrong thing the moment
the world changes. See [[basis-fields-served-never-rendered]].
