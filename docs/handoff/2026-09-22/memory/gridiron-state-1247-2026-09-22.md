---
name: gridiron-state-1247-2026-09-22
description: "17:05Z-17:06Z twelfth batch: DEPLOY HAPPENED — Nick deployed main c5ee3b54 to Fly (image deployment-01M3517MWXX3HF7CEPSWB8ZK0M, machine 84ed41eae1dd68), brake set beforehand, log check (step 3) and unset (step 4) still waiting on Nick; #99 MERGED c5ee3b54; Nick asks about the start/sit 80% fix — UI building it; #115/#116/#117/#119 REAL with gos"
metadata:
  type: project
  modified: 2026-09-22T17:09:00.000Z
---
- **DEPLOY HAPPENED 17:05Z.** Nick ran `fly deploy` from `~/Documents/GitHub/gridiron-hq` on **main c5ee3b54** (`git pull` → 'Already up to date'). Build-context warning 2.3 GB (`data/` 2.2 GB) but the image is **85 MB** (Dockerfile copies only client/dist, server, scripts). **Image `registry.fly.io/gridiron-hq:deployment-01M3517MWXX3HF7CEPSWB8ZK0M`**, machine 84ed41eae1dd68 updated, 'Visit your newly deployed app'. **Rollback image is now the PREVIOUS one, `deployment-01M2VZ9JRYSXVHCRWJ83V360QH`.** Brake `SCHEDULER_DISABLED=1` was set as an app secret before the deploy (step 1). **Step 3 (log check for 'Scheduler disabled via SCHEDULER_DISABLED=1') WAITING ON NICK; step 4 (unset) not yet.**
- **Nick 17:06:11Z, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmTWntxLfoTyiNSUyUCRjsCk6, verbatim:** 'ok now what - are u solving the start sit 80% thing bro' → answered: UI is building the ceiling-lineup fix now (weekly configuration, equality RED; [[gridiron-state-1242-2026-09-22]]). Both the −4.6 (17:02Z) and 80% (17:05Z) figures had already been corrected to him.
- **#99 MERGED c5ee3b54** (Opportunity; contract graders; PR body corrected to 116/67). **'Measured on main' now names c5ee3b54.**
- **Evidence Auditor 17:06Z:** **#115 REAL** (6d637d3d), **#116 REAL**, **#117 REAL**, **#119 REAL** → merge gos sent. #118 CI in progress (body says stacked on #86 — fix that line). **#120 held** for a rebased head (trade logic, full local run). #94 full local run in progress.
- **Scheduler** asked for a read-only post-deploy SQL paste block for Nick.
Prev [[gridiron-state-1246-2026-09-22]]. Next [[gridiron-state-1248-2026-09-22]].
