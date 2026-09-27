---
name: trade-brain-transactions-as-of
description: The manager/signals payload now serves when its transactions were collected, and why the as-of must come from the table's own stamps rather than sync_log.
metadata:
  type: project
  modified: 2026-09-20T03:00:00.000Z
---

Shipped 2026-09-20 on `claude/project-thread-3xqh5l-accessor-hold`, head
**eaa91ef**: manager read 21b449a (RED 9a2f108), the two trade-path consumers
e51f23f (RED 788193d), the priced luck term eaa91ef (RED 56a02f1). No PR on that
branch — the GitHub freeze.

**What.** `GET /api/trades/:leagueId/managers/signals` now carries a
`transactions` block: `as_of` = `MAX(last_seen_at)` for that league-season,
`rows`, `first_seen` = `MIN(first_seen_at)`, the collector named, and a `reason`
when empty. `transactionsCollected()` in `manager-signals.js`. An absent table
and an empty table are different reasons, never a borrowed stamp.

**Why not `sync_log`:** the collector catches a per-league failure and
continues, so the job stamp can say "ran at 04:15" while one league's cookies
expired and its rows are days old — a measurement of the job, not of the league.

**Second half, already being served.** `SIGNAL_SOURCES.tx.refreshed` said
`'every refresh tick'`, and `signalRowsFor` interpolates it into the `why` on
**every tx signal row** — the false cadence reached the client once per metric.
Lesson: a "documentation" string inside a served registry is a served claim.

**Finding 7 confirmed independently**: the only writer is
`scripts/collect-league-transactions.mjs:34`, spawned only from
`scripts/refresh-live-data.mjs:99` (off-server by its own header); `fly.toml` has
no `processes` block. Nothing on the deployed app has ever written a row.

**DONE on the trade path too** (e51f23f): `timingRead`, `vetoClimate` and
`selfRead` all carry the same block from the same accessor. The two placements
that were the real bug: `vetoClimate` sets it BEFORE its `!tx.length` early
return, and `selfRead` BEFORE its `me == null` return — both returns are where
"nothing collected" looked identical to "no history". G5d3 asserts the three
reads are `deepEqual`, which is the only assertion that catches a surface
re-rolling its own MAX() and drifting: test the unification, not three
individually plausible values.

**CORRECTION, mine**: `manager-archetypes.js` does NOT read
`league_transactions_raw` — one header comment at `:20` names it, no `FROM` or
`JOIN` in the file. I routed it as a consumer from reading a comment in a
filename grep as a query. 21b449a already covered every served consumer.

**SECOND STORE, same defect, worse (eaa91ef).** `luck_self_view` is a TERM IN THE
TRADE PRICE (factor cap 0.05, multiplies into `their_value`) and comes from
`manager_archetypes`, written only by `scripts/build-manager-archetypes.mjs` by
hand. `archetypesBuilt(leagueId, season)` beside `transactionsCollected`, same
shape; the stamp rides the `luck` reading and `add()` puts it on the priced
factor AND the inert entry. NOT `manager_signals.computed_at` — that is when the
signal build COPIED the value and advances while the measurement sits still.

**THE GENERAL RULE, and the one to quote:** a served or priced value must carry
the stamp of the process that MEASURED it, never the stamp of a process that
merely copied, scheduled or reported it. `sync_log` for transactions and
`manager_signals.computed_at` for archetypes are the same mistake, and both were
the convenient one.

**Open after the merge**: chat sync's archetype as-of (their hold 6ceb5c7:
`as_of`/`career_as_of`/`jev_as_of` per member) and my `archetypesBuilt` are two
accessors on one store's stamp — the duplication this rule warns about. Mine is
narrower (league-season, `draft`+`outcome` only). Wants one accessor once both
land.

The trade path's three clamps, and which one the audit means:
[[gridiron-trade-price-clamps]].
