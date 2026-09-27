# Does cloud-build / local-verify make the project faster? (Nick asked to check, 2026-09-22 6:35 PM ET)

Measured with `~/gridiron-local/bin/throughput.py` (journal birth time → last activity; merges from WORKLOG).

## Baseline: local builds (build-unit.js, everything on the 8 GB Mac)

| Batch | Units | Start → PR ready | Notes |
|---|---|---|---|
| 1 | F-05, R-02 | 19:38Z → ~21:22Z = ~102 min | one gate failed on a Node-25-only test; fixer rounds 2 each |
| 2 | S-00, C-01, F-08 | 20:05Z → still gating at 22:35Z (150+ min) | gates serialized behind the machine-wide guard lock |
| 3 | S-02, S-18, R-07 | 20:15Z → still gating at 22:35Z (140+ min) | same |

Merge rate so far: 9 merges in 194 min = 2.8/hour (several were small landings).
Bottleneck: the local `npm run check` (~10-12 min each), one at a time across all workflows (guard lock). 6 gates = ~70 min single file.

## Cloud pilot (INT-128-1, Sonnet, remote): FINDING 6:45 PM ET

The Agent tool's isolation "remote" did not run in the cloud. The agent created ~/gridiron-local/wt/int-128-1 on this Mac and ran npm run check here (pid 39744), outside the guard lock. So it offloaded nothing and added load. Next attempt: a real cloud execution (Claude Code scheduled cloud agent / RemoteTrigger).

- cloud start → draft PR: _pending_
- local verify-pr.js (skeptics + fix loop): _pending_
- merge-queue (CI on Node 22): _pending_
- local CPU/load while it ran: _pending_

## Verdict: pending the pilot

## Lean Sonnet build, measured end to end (INT-128-1, PR #153)

- Build (Sonnet; ran on this Mac because the Agent 'remote' option fell back to local): 22:22Z → 22:51Z = 29 min, 182K Sonnet tokens (vs ~1.4M Opus tokens per unit in local build workflows).
- Local verify-pr (liveness + structure skeptics): ~3 min of agent time, 205K tokens; its final 'mark ready' step was cut by the 6:50 PM ET limit and finished after the 7 PM reset.
- Merge queue (CI on Node 22 + gate): merged 23:07Z as 34aa3d0e.
- Real cloud routine (SY-06): cloned and investigated correctly on Anthropic's side, then hit the same account 5-hour limit at 22:52Z. Cloud routines share the account limit: they offload CPU and RAM, not tokens.

Interim verdict: lean builds + local verification cost roughly a quarter to a third of the tokens of a full local build workflow per unit and skip the local guard-lock queue. Wall time is dominated by CI (~11 min) and the one-at-a-time merge rule, not by the build.
