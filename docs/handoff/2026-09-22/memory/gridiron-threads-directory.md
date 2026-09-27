---
name: gridiron-threads-directory
description: Full session id / thread id map for all Gridiron HQ threads including both auditors, with CONTINUING / LAND-AND-PAUSE / PAUSED status from the 18:06Z fleet cut (Nick GO 18:05:09Z). Linked from MEMORY.md "Threads".
metadata:
  type: project
  modified: 2026-09-22T19:15:00.000Z
---

**FLEET FREEZE 18:37Z (Nick 18:29Z usage burst: 5h 16%, weekly 5%): every thread finishes ONLY its in-flight merge, writes a handoff addendum, STOPS — no new units, no new guard runs, auditors quiet; continuing threads restart fresh ONE AT A TIME after the ~18:45Z reading [[gridiron-usage-priority-rule]]. Finishing: UI #118 cf60f5e3; Feature audit #55/#62/#130 MERGED; #67 (retarget base) then #74, then addendum + stop; Wiring map #146 6212253; Scheduler #128 5f9242d8 (merges on green); Model evidence audit #121 d90dd78b; Fantasy plan #106 MERGED b3e79709 → PAUSED (next: #66/#79/#80/#83 keep-or-close, Nick line); Chat sync #131/#125; Trade Brain #94 → #100; Opportunity #116 98129cbc (last item) / #135 advisory; Release #133 MERGED 9f121bc → PAUSED; Coach #90 MERGED 6224fade → PAUSED; Planner, Explorer, both auditors: nothing in flight. Model evidence audit #121 MERGED fd85caa2 → STOPPED, check-ins cancelled. Wiring map: #146 CI running, #147 DRAFT (four wrong CONTRACT.md cells) approved on green. **Research-only thread "Licensed source for refs and coaches" (freeze exception, Nick 18:30:22Z) RESOLVED 18:50Z: nfldata dropped, nflverse-data officials.csv + games.csv (CC BY 4.0) → Scheduler's next unit after the freeze [[gridiron-nflverse-cc-by-attribution]].** Opportunity STOPPED 18:33Z (#116 in flight; next unit R66 grader fix, scripts/reach-grade.mjs allocated). Restart briefs: cancel any PR check-in / subscription the old session armed.**

**Status as of 18:06Z 2026-09-22** ([[gridiron-state-1284-2026-09-22]], gate [[gridiron-merge-gate-rule]]): five CONTINUING, seven LAND AND PAUSE (finish the listed PRs then stop, handoff written), Explorer PAUSED NOW. Handoffs in `/mnt/project-files/handoff/<thread>-2026-09-22.md` (memory pointers: [[gridiron-fantasy-plan-handoff-2026-09-22]], [[gridiron-auditor-handoff-2026-09-22]]). Every thread loads `anthropic-skills:gridiron-merge-gate-v2` and `anthropic-skills:gridiron-token-efficiency` (prefix required [[gridiron-skill-prefix-lesson]]) before pushing; no subagent for a single API call [[gridiron-no-subagent-for-single-api-call-lesson]]. Fresh restarts land on claude-opus-5-5 (project settings, 18:18Z). 18:27Z: Opportunity's session lacks the token-efficiency skill (gist relayed inline); Opportunity restarts fresh after #72 lands; GitHub writes = one attempt now, check state first, ten minutes between refusals. **18:18Z: all 15 handoffs in; every thread told usage priority #1 [[gridiron-usage-priority-rule]] + restart-fresh.** Routing 18:18Z: Model evidence #121 → merge on green; Feature audit pass_rushers unblocked + #130; Wiring map #137; UI #132 then #118; Trade Brain #94 → #100 → #103 → #120; Scheduler MLB 8e2667bc/b6c7b739 + #144/#145.

All thread ids share the prefix `cmsg_01YAsw8AnFv4ioRMQw8dfPmT` + the suffix shown.

- Release **[LAND AND PAUSE (#127, #133; NO deploy press)]** — session cse_016rykKAHmB43LAZp6eqwedG · suffix LtvcKX5oSjZz6x2L5FEXHk
- Wiring map **[CONTINUING]** — session cse_01CQKUgynAHZALCtMfvu7ieE · suffix FsHkhHKFJUzXHr2RdRZRWK
- UI **[CONTINUING]** — session cse_012mJNcQKskfZmyq4qTmFqDe · suffix YDSUNJhXhq5i9wxu6ZASvP
- Fantasy plan **[LAND AND PAUSE (#106)]** — session cse_01U2PQK2qw4VrXdytNqpq5an · suffix HJkQrWhT9rQXMaMsRp8sgy
- Scheduler **[CONTINUING]** — session cse_01DrNvRmumDqr2e83XuG7Qr1 · suffix TWgBAMfiBF9jyPkKJpFNGs
- Feature audit **[CONTINUING]** — session cse_01XL5WQkomfhtJ925G1wZ9yr · suffix 1e6VjvMZtgk12UfXZf7BhA
- Trade Brain **[LAND AND PAUSE (#94 → #103 → #120 → #100)]** — session cse_01M65mgrWTebkf9zqNR3gFnL · suffix WTNUkdBSZxWaPcUAWCz5d8
- Opportunity **[LAND AND PAUSE (#116, #85 merge-not-rebase, #135 after Auditor, #72)]** — session cse_01BvuTs792dFTGix8BixBJWv · suffix PBrwJmDV2B1faqr1XGaJM4
- Google sign-in **[RESOLVED 08:55Z (Fantasy plan holds its PR bodies)]** — session cse_01Fvh3EsJ4qTYUfpkB1ArgBM · suffix 8YsGjX4GZdwhGVZ82qyDvf
- Chat sync **[LAND AND PAUSE (#131, #124, #125; #134 stays draft)]** — session cse_01XTraU7NJBSDtpxoVYe2oWR · suffix KYXEhjbYKXZq8jgBSxswWF
- Model evidence audit **[CONTINUING]** — session cse_01RaKeP3tXctv8SXVFaMRZdd · suffix 7SXDS8LvnSNmvMsRPdPPrw
- Coach **[LAND AND PAUSE (#90, #82)]** — session cse_016PjGEhxy64vLJRHjfRmZAH · suffix S3usSxcPEMGfCMXmNcuFcN
- Data & techniques R&D (was BDB survey) **[PAUSED NOW (= Explorer; trig_01TmmVb3SUDjmL1ytumBjCMV disabled, kept)]** — session cse_01MZWAai2grAYofLf1AFcQTf · suffix 4vudwP2HRu3f6Jh6t6Wnw5
- R&D integration & cleanup (= Planner) **[LAND AND PAUSE (#92; self-wake disabled)]** — session cse_01AkWVQyBHMgzzCWthGU6PNw · suffix EemiXC9TrLjvH3yHwUXYiK
- Independent Auditor (statistical) **[CONTINUING, model/stat PRs only]** — session cse_01Q2FHgt4RMnqaJ2LRECwpSV · suffix 3KiCiFCNRVdLzR7VGhZ9Ty
- Evidence Auditor **[READ-ONLY (merge ledger + main watch; no suite re-runs)]** — session cse_012mT7CaxQcWsGgGqaj6PCqF · suffix 3qmhahWyZnNu4SCfUGc16M
