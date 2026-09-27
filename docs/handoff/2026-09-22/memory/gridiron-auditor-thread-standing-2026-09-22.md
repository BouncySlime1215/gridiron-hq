---
name: gridiron-auditor-thread-standing-2026-09-22
description: Nick's 2026-09-22 07:14Z auditor rule — one dedicated Opus auditor thread owning a 3-gate audit queue, independent, with kill/redirect authority.
metadata:
  type: feedback
  modified: 2026-09-22T07:19:11.383Z
---

**Nick, 2026-09-22T07:14:26Z, cmsg_01YAsw8AnFv4ioRMQw8dfPmT3KiCiFCNRVdLzR7VGhZ9Ty,
verbatim:** "auditor rule — effective immediately: spin up 1 dedicated opus auditor
thread. it owns the audit queue. every unit of work gets 3 gates: acceptance criteria
at kickoff, mid-point wiring/evidence check, final evidence review. the auditor is
independent — no stake in the build, reports up to my oversight channel (not to the
builders), has kill/redirect authority. cheap checks (test rundowns, wiring map
updates, branch hygiene) stay automated/with you; opus time goes to judgment calls:
statistical validity, architecture coherence, real-vs-decoration. you feed it only
gated units: high-risk work (models, trade logic, projections) plus random spot
checks. my oversight agent may add a second auditor if the queue backs up — its call,
don't ask me."

Follow-up 07:17:57Z, verbatim: "lock in and be accurste".

**The auditor thread:** thread id cmsg_01YAsw8AnFv4ioRMQw8dfPmT3KiCiFCNRVdLzR7VGhZ9Ty,
session session_01Q2FHgt4RMnqaJ2LRECwpSV, branch `claude/project-thread-naclrx`.
Writes no feature code. Reports verdicts as thread replies + send_message to the
coordinator; never messages builder threads directly. Bound by the same rule as
everyone: no push, no PR, no merge, no deploy, no settings/secrets.

**How to apply:**
1. Coordinator feeds it ONLY high-risk units (models, trade logic, projections) plus
   random spot checks. Test rundowns, wiring-map updates, branch hygiene and TDD
   evidence-file completeness stay with the coordinator — do not send those.
2. Each unit gets three gates in order: acceptance criteria BEFORE work starts,
   a mid-point wiring/evidence check, a final accept/reject/redirect verdict.
3. Kill/redirect goes coordinator → builder thread; the auditor never relays it itself.
4. A second auditor is the coordinator's call if the queue backs up. Never ask Nick.

**Evidence-transport constraint (verified 07:20Z):** a commit that exists only in
another session's sandbox cannot be audited. `git cat-file -t 58c29114` in a fresh
clone → `fatal: Not a valid object name`, and none of origin's 157 branches carry it.
Units must arrive as a pushed branch, a `git format-patch`/bundle in
/mnt/project-files, or raw command output with the tree hash.

See [[threads-report-to-coordinator]], [[gridiron-five-questions-rule]],
[[gridiron-claude-md-tasks-md-claim-stale]].

## New gate-1 criteria added 2026-09-22 (11:55Z)
- **POWER CHECK, on every pre-registration:** state the **maximum achievable
  effect** and show it exceeds the test's resolution. Partial pooling failed this
  after the fact — its whole fit-season k range was 0.0103 against a test-season
  CI half-width of 0.0104, ratio 0.99, so a perfect result was indistinguishable
  from zero before the test ran. **A pre-registration that cannot pass its own
  best case is not a test.**
- **DECOMPOSITION IS MANDATORY regardless of the primary's outcome** (total =
  level + information, see [[gridiron-preda-level-confound]]). A null total can
  hide offsetting components and a null is where they are most informative.
- **Pre-register the tie-break rule** for a grid whose optimum ties.
- **Report mean signed error beside MAE** on anything proposed for shipping.
  Measured on the #13/#14 arms: at the MAE optimum either arm ships ~17-18% low
  in the mean, and the arms are bias-matched to within 0.65%/1.74%, which is the
  check that makes an information share trustworthy. See
  [[gridiron-mae-optima-are-medians]].
- **A direction or mechanism claim cites the APPLYING LINE, never a write-up
  table.**

**MEMORY.md is single-writer; the auditor does not write it directly:**
[[gridiron-memory-md-single-writer]].
