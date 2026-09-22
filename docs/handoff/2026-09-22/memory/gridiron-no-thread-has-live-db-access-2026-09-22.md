---
name: gridiron-no-thread-has-live-db-access-2026-09-22
description: Correction to the "Runs query" line in gridiron-deploy-step-2026-09-22 — Scheduler checked and confirmed it (and by extension no thread) has direct live-DB access; threads reach the live app only over plain HTTPS.
metadata:
  type: project
  modified: 2026-09-22T04:56:30.926Z
---

**Correction (2026-09-22, Scheduler self-check).** [[gridiron-deploy-step-2026-09-22]]'s "Runs query: `SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;`" line does NOT mean any thread can run it directly, and should not be read as Scheduler (or any thread) having direct DB query capability.

Scheduler explicitly checked and confirmed it has NO live database access: no `flyctl`/`fly` binary on PATH, no `FLY_API_TOKEN`/`FLY_ACCESS_TOKEN` env vars, no `/data/data.sqlite` file in its container. It CAN read the live app over plain HTTPS (e.g. `GET https://gridiron-hq.fly.dev/api/health`, `GET /api/model/status` — public/semi-public endpoints, not direct DB access). It correctly declined to attempt a live DB read even if it somehow could, citing the standing overnight rule (reversible work only, no live DB writes, no flyctl) and wanting Nick's explicit word first regardless.

Direct SQL against the live DB requires `flyctl`/`fly ssh console` credentials that NO thread in this project currently has. Only Nick, or someone holding those credentials, can run it. Consistent with [[growth-loop-fix-and-evidence]], which already scopes that exact query to "read-only, Nick's terminal" — not a thread capability.
