---
name: gridiron-state-1249-2026-09-22
description: "17:08Z fourteenth batch: BRAKE OFF — Nick unset SCHEDULER_DISABLED, scheduler ENABLED on the live app for the first time, final log check requested; live image = c5ee3b54, later merges not deployed; #119 MERGED, main f620a120; epoch-fallback-loud pushed; Scheduler's Opus 5.5 switch rejected twice, a worker reading last_served_model for all 16 sessions"
metadata:
  type: project
  modified: 2026-09-22T17:12:00.000Z
---
- **BRAKE OFF 17:08Z (deploy step 4 DONE):** Nick ran `fly secrets unset SCHEDULER_DISABLED -a gridiron-hq`; machine 84ed41eae1dd68 update succeeded (screenshot, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmT73QAmujPWzSsTtqJvhYZoW). **The scheduler is ENABLED on the live app for the first time.** Final log check requested of Nick (jobs starting, no errors).
- **Live image = main c5ee3b54** (deployment-01M3517MWXX3HF7CEPSWB8ZK0M). **Merges after 17:05Z (#119, the #108 follow-ups, etc.) are NOT deployed** — a second deploy is Nick's word.
- **Scheduler 17:08Z:** **#119 MERGED**, **main now f620a120** (chain includes #95 eb861feb, #112 a1e661fc, #119). `epoch-fallback-loud` unit pushed (3236/0). Scheduler building a tested read-only post-deploy SQL paste block for Nick. Nick told the #119 line 17:08Z.
- **Scheduler's Opus 5.5 switch REJECTED twice** (16:39Z, 17:07Z), still Opus 5 — likely unavailable to thread sessions; a worker is reading `last_served_model` for all 16 sessions. Restart is Nick's call ([[gridiron-state-1248-2026-09-22]]).
Prev [[gridiron-state-1248-2026-09-22]]. Next [[gridiron-state-1250-2026-09-22]].
