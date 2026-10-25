---
name: gridiron-data-loops-answer-0719-2026-09-22
description: The 07:19Z + 07:25Z five-point data-loops answer to Nick (freshness registry, trade-acceptance logging, transactions, news feed, weekly learning loop), moved verbatim out of MEMORY.md at 17:07Z
metadata:
  type: project
  modified: 2026-09-22T17:07:30.000Z
---
Moved verbatim from MEMORY.md at 17:07Z 2026-09-22 to keep it under 12,000 bytes. Some points are stale: #94 (ledger) is REAL and rebased, #86 (freshness endpoint) merged 7eca9a8, news importance path unchanged.

## Data-loops answer to Nick (07:19Z + 07:25Z)
1. Freshness registry — NOT live (main undeployed, SCHEDULER_DISABLED=1 on).
2. Trade acceptance logging — logs nothing; migration 067_outcome_ledgers + ledger only on unmerged PR #94 (e3bca56). Post-deploy: app_proposed/considered_only rows need only the deploy; `observed` rows need the ESPN cookie, today `state:'raw_table_absent'`. (Trade Brain's evidence, not Scheduler's.)
3. Transactions — not a pipeline: hand-run `scripts/collect-league-transactions.mjs`, no migration, sole caller on main `scripts/refresh-live-data.mjs:99` (off-server), cookie-gated per league, silently zero rows without a cookie (`manager-signals.js:580`). Scheduled-job commit 9c7cf68 unmerged on held branches. No run-log → "last successful run" unanswerable.
4. News feed — ingest RUNNING (914 `news_items` rows) but `trades.js:466` wants `importance = 3`, all 914 are 2 → live code, dead path.
5. Weekly learning loop — Auditor verdict above; code real and accepted, live status unverified.
**One live read (GET /api/leagues + the epoch-filtered query) settles cookie status AND the weekly-loop question. Trade Brain's attempt: blocked by its session's safety classifier (Fly token in Authorization header); needs Nick or a differently-permissioned session.**

