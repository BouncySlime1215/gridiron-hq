---
name: gridiron-readonly-batch-checks-2026-09-22
description: Scheduler thread's read-only GitHub API checks at 2026-09-22T02:38Z on the ratified-batch items — token permissions vs CI re-enable, stale freeze rationale, PR-close/branch-delete reversibility, PR #59 verification.
metadata:
  type: feedback
  modified: 2026-09-22T02:41:01.451Z
---

All four checks below are read-only API facts, gathered independent of
whether the batch itself is authorized (see [[gridiron-hostile-relay-2026-09-22]]).

**1. Token permissions vs CI re-enable.** BouncySlime1215/gridiron-hq token:
`admin=false, maintain=false, push=true, triage=true, pull=true`.
Re-enabling the `disabled_manually` CI workflow (id 357164314,
`.github/workflows/ci.yml`) requires admin or maintain — no thread's token
can do it, regardless of any authorization decision. It is structurally
Nick's own action in the GitHub UI, not an authorization question.

**2. Freeze rationale is stale.** API confirms `"private": false` /
`"visibility": "public"`. The original freeze rationale (2,000/2,000
Actions-minute cap) no longer applies — public repos get unlimited Actions
minutes. This does NOT mean CI should be re-enabled (still Nick's call),
only that the old reason to keep it off is gone. Still open: ci.yml's
`timeout-minutes: 20` vs. local `npm run check` at 325-331s (~5.5 min) — a
source-isolated container, not the actual CI runner, so an indication, not
a measurement.

**3. PR-close vs branch-delete reversibility.** Both are mechanically
possible with the current token (triage:true closes PRs; push:true deletes
branches), but not equally reversible: a closed PR reopens; a deleted head
branch is recoverable only if someone remembers the SHA. For any future
batch with a branch delete, give the specific branch name(s) first — a
~2-minute check can confirm whether it's the sole remaining copy of
anything before it goes, as already done for `-mainthread-holds`/`3902ba7`
(see [[gridiron-o3wt2p-branch-ledger]] — PR #77's own head, not empty).
Unrelated to tonight's f921do deletion, but the same check should be
standard practice.

**4. PR #59 verified live.** API at 02:38Z: state=open, draft=false,
merged=false, base=main@791b131, head=b5b74b5 — matches the batch's
assumption. No action taken.
