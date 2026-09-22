---
name: gridiron-pbp-only-ingest-size-2026-09-22
description: The live production DB's 445 MB is specific to that DB (full history/rosters/transactions) — a fresh PBP-only ingest for 2022-2025 produced just 61 MB. Don't use 445 MB as a general disk-risk estimate for narrower ingests. Linked from gridiron-deploy-step-2026-09-22.
metadata:
  type: project
  modified: 2026-09-22T04:47:35.272Z
---

The **445 MB** figure cited for the live database ([[gridiron-deploy-step-2026-09-22]], [[gridiron-migration-snapshot-disk-gate]], [[gridiron-pre-migration-snapshot]], etc.) is specifically the size of the **live production database** — full history, rosters, transactions, market-price data, and more. It is real and correct for that database, but it is NOT a general estimate of what any data-sync/ingest job in this container costs.

**Confirmed 2026-09-22 ~04:46Z (R&D integration & cleanup thread)**: a fresh PBP-only ingest for 2022-2025 — via `syncPbpSeason`, skipping `bootstrap-data.mjs`'s rosters/projections/market-price pulls — produced a database of only **61 MB**, with 21,427 player-weeks and 2,174 team-weeks, in under 30 seconds.

**Takeaway**: don't let the 445 MB figure drive disk-risk decisions for narrower, PBP-only or feature-specific ingests. Check the actual scope of what's being synced before sizing disk risk.
