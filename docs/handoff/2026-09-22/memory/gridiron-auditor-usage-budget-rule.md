---
name: gridiron-auditor-usage-budget-rule
description: Nick's 18:16Z 2026-09-22 standing rule that usage monitoring is priority one, and the Evidence Auditor's specific read budget under it.
metadata:
  type: feedback
  modified: 2026-09-22T18:18:26.965Z
---

Nick Matta, 2026-09-22 18:16:07Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTWxz7wC5vFLCTEe7cMso3FB,
timeline): "i want u to monitor all of the usage and usage types pls - we have
the 200/m plan thats 20x usage ... YOUR #1 priority above all else is to monitor
this ... make sure that we are using our usgae limit efficiently while not
killing accuracy or missing small things."

**Why:** the 20x plan should cover a week of 24/7 work; the weekly cap is the
real constraint, not the monthly one. Efficiency must not cost accuracy — he
asked for both in the same sentence.

**How to apply (Evidence Auditor's budget, set by the coordinator 18:17:56Z):**
- **One read per CI run, when it finishes** — not while it is in progress. Time
  the read instead of polling: the suite is ~400s plus build and smoke.
- **`git ls-remote origin main` instead of a REST call** for main's tip. Git
  over HTTPS does not spend the REST hourly budget; `list_workflow_runs` does.
- **One ledger reply per merge batch, not per event.**
- Read a saved transcript or a fetched body again rather than re-fetching it —
  the 18:07Z sweep output held all 19 PR bodies and answered the R63 question
  with no API calls at all.
- Do not run full suites: that role ended at 18:06Z. See
  [[gridiron-merge-gate-rule]].

Related: [[gridiron-30min-update-rule]], [[gridiron-verify-once-and-model-by-weight]].
