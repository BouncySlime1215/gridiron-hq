---
name: gridiron-transaction-collector-never-runs
description: The deployed Gridiron HQ app never collects ESPN league transactions — the collector runs only from an off-server loop on Nick's machine, against a 3-day window, so the only data that could anchor the trade-acceptance band is lost daily.
metadata:
  type: project
  modified: 2026-09-20T01:35:49.505Z
---

Found 2026-09-20 on `origin/main` at **791b131**, while auditing "what will they
accept". Routed to the coordinator as a platform decision, not a model one.

**Every table behind the counterparty half has exactly one writer, and it is a
manual script.**

| table | only writer | scheduled on the server? |
|---|---|---|
| `league_transactions_raw` | `scripts/collect-league-transactions.mjs` | **no** |
| `league_week_scores` | `scripts/backfill-league-history.mjs` | **no** |
| `manager_archetypes` | the `manager_archetypes` job | yes, but `tier: 'heavy'` (`scheduler.js:1373`) |

`collect-league-transactions.mjs:8-12` states the constraint itself: ESPN's
`mTransactions2` answers only for the last **~3 days**, *"Anything not captured
inside that window is gone, so this runs every refresh tick."* The tick it means
is `scripts/refresh-live-data.mjs:99`, which spawns it — and that file is, by its
own header, an **off-server** loop (`--loop 900`), written because the in-server
scheduler pegged the web process. **Nothing in `fly.toml`, `package.json` or
`scheduler.js` runs it**, and `fly.toml` is a single web process with no worker.

So on the deployed app the collector never runs. Every day that loop is not up
on Nick's own machine is a day of proposals, accepts and declines lost for good
— and `league_transactions_raw` is the only table in the repo that could anchor
the acceptance band, feed `manager-signals.js`'s `tx` source (`:167-169`), or
supply the bluff detector.

**This is why the acceptance band reads 2.5%-57.5%** (measured by calling
`acceptanceBand` directly with no counterparty data): not because the method is
weak, but because the data never arrives. `trade-acceptance.js` is candid about
this — its header's third line is "Nothing here is fitted."

## Two live consequences

- **`luck_self_view` prices nothing today.** Chain: `league_week_scores` →
  `scripts/luck-panel.mjs` (spawned by the archetype build, not read as a table)
  → `manager_archetypes` (`source: 'outcome'`, `metric: 'luck_wins'`) →
  `manager-signals.js:264-276` → `counterparty-pricing.js:452-457`, a capped term
  on what a package is worth to that manager. `counterparty-pricing.js:55-56`
  documents the inertness, but the `if` at `:452` has **no `skip()` branch**
  (unlike `perception_delta` in `trade-acceptance.js`), so it never reaches the
  object and no page can say "we have no luck read on him". Same shape as
  [[basis-fields-served-never-rendered]], one layer earlier.
- **The posture calibration cannot be refreshed without a human.**
  `lineup-posture.js:131` and `trade-horizon.js:47` cite `league_week_scores` in
  **doc comments**, not at serving time — so a stale table is a calibration
  nobody can re-run, **not** a stale number. Keep that distinction; it is the
  chat-sync thread's and it is right.

Fix is Nick's call: a Fly worker process, or a cron on his machine. Nothing
safe to do from a session. See [[gridiron-model-audit-2026-09-20]].
