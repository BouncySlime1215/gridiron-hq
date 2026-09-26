---
name: gridiron-state-1248-2026-09-22
description: "17:06Z-17:08Z thirteenth batch: deploy step 3 CONFIRMED (scheduler-disabled log line, health passing), step 4 unset waiting on Nick; Nick 'use opus 5.5 across everything' → all sessions claude-opus-5-5, model-by-weight RETIRED; switch_model reports success on API rejection (check last_served_model); Feature audit's hardening unit closed as unreachable; #115 MERGED 144b7225; draft #121 pre-registration; Release on deploy.yml + .dockerignore"
metadata:
  type: project
  modified: 2026-09-22T17:10:00.000Z
---
- **DEPLOY STEP 3 CONFIRMED 17:06Z:** Nick's fly logs show 'Scheduler disabled via SCHEDULER_DISABLED=1 — no background jobs will run.' at 17:05:31Z, app listening, health check passing. **Step 4 (`fly secrets unset SCHEDULER_DISABLED`) instructed 17:06Z and again 17:07Z (Ctrl+C the log tail first); WAITING ON NICK.**
- **Nick 17:07:02Z, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmT94Bra9yknAoEUEkApzZCSU, verbatim:** 'bro use opus 5.5 ACross everything pls' → coordinator switched itself, set project model_id claude-opus-5-5 (Nick re-set it himself 17:08Z; channel_session_model_id claude-opus-5-5; effort level cleared), relayed to all 15 threads with his message attached. **STANDING RULE UPDATE: all sessions on claude-opus-5-5; model-by-weight RETIRED** ([[gridiron-verify-once-and-model-by-weight]] — verify-once half still stands).
- **FINDING (Trade Brain 17:07Z): `switch_model` returns success even when the API rejects.** Trade Brain's session shows `user_switch_rejected claude-opus-5-5[1m]`, serving claude-opus-5. **Threads must check `last_served_model`, not the tool's OK.** Confirmed switched so far: Feature audit, Release, Evidence Auditor, Model evidence audit. Nick told 17:07Z that rejected threads can only move by restart — his call.
- **Feature audit: hardening unit CLOSED as unreachable** — `assetUniverse`/`freeAgents` take a resolved league row; every caller validates first; the rig drove them with a bare integer. The earlier raw-TypeError crash finding ([[gridiron-state-1231-2026-09-22]]) is **STRUCK**. **#115 MERGED 144b7225.**
- **Model evidence audit: draft #121** = coupled-grade pre-registration (prior + availability), awaiting Independent Auditor clearance before running.
- **Release:** on the deploy.yml + `.dockerignore` unit (the 2.3 GB build context from `data/`).
Prev [[gridiron-state-1247-2026-09-22]]. Next [[gridiron-state-1249-2026-09-22]].
