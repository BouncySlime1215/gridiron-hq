---
name: gridiron-state-1239-2026-09-22
description: "16:59Z-17:00Z fourth batch: #95, #112, #86 (7eca9a8) and #87 (0c5b7be4) MERGED; drafts #118/#119 opened; #94/#92/#110/#87 REAL with merge gos; #108 green awaiting REAL; the deploy step posted to Nick — deploy state WAITING ON NICK"
metadata:
  type: project
  modified: 2026-09-22T17:01:00.000Z
---
- **#95 MERGED** (Scheduler: jobs off the request thread on every path; 3134/0 local + CI) and **#112 MERGED** (depth-chart guard tests) at ~16:59Z. **Shas not yet reported by Scheduler — ask flagged.** Scheduler opened **draft #119**: a growth cycle that failed a download reported 'ok'; now names the failed feed and marks downstream stale; 6/6 mutations killed.
- **#86 MERGED 7eca9a8** (UI: data-freshness endpoint + player-page advanced stats + the fake "data healthy" banner kill). UI opened **draft #118** (quarterback target-share wording; the "file lacks column" message was false). **UI has started the ceiling-lineup fix** (grant in [[gridiron-state-1238-2026-09-22]]).
- **#87 MERGED 0c5b7be4** (Feature audit: feature-store feed-zero NULLIF fix).
- **Evidence Auditor:** #94 REAL (tree 208cd70f), #92 REAL on 28ff7ae5, #110 REAL on 311e84c, #87 REAL — **merge gos sent 16:59Z**. #108 a333f44 CI green, waiting REAL.
- **DEPLOY STEP POSTED TO NICK 17:00Z** (post cmsg_01YAsw8AnFv4ioRMQw8dfPmT5GUTDZ99Y6uvtd6L6xfzpa): 1 `fly secrets set SCHEDULER_DISABLED=1`; 2 `fly deploy`; 3 confirm 'Scheduler disabled via SCHEDULER_DISABLED=1' in fly logs; 4 `fly secrets unset SCHEDULER_DISABLED` only after 3; never delete the `.bak`; rollback = previous image. **Deploy state: WAITING ON NICK.**
- **Merged today so far:** #91, #89, #111, #102, #114, #68, #95, #112, #86, #87. **Remaining open:** #94, #92, #110, #108, #103, #113, #99, #109, #116, #115, #118, #119, #106, #100, #96, engine-fault.
Prev [[gridiron-state-1238-2026-09-22]]. Next [[gridiron-state-1240-2026-09-22]].
