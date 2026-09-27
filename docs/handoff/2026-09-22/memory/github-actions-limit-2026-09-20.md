---
name: github-actions-limit-2026-09-20
description: From 01:00Z 2026-09-20 every CI run died in 2-4s because Nick's GitHub Actions limit was hit; red checks that night are not the PRs' contents, and a repo-wide freeze followed.
metadata:
  type: project
---

At **01:00:24Z on 2026-09-20** GitHub Actions on `BouncySlime1215/gridiron-hq`
stopped allocating runners. Nick's Actions limit was hit.

**The signature, so nobody re-diagnoses it as a test failure.** The job comes
back `conclusion: "failure"` — not `cancelled`, not `startup_failure` — with:

- `created_at` and `completed_at` **2 to 4 seconds apart**
- `runner_id: 0`, `runner_name: ""`
- `get_workflow_job` returns **no `steps` array at all**
- `get_check_run` output `title`, `summary` and `text` all empty strings
- `get_job_logs` returns **HTTP 404** for both `job_id` and
  `run_id` + `failed_only` — there is no log because no step ever ran

Observed across four unrelated branches in three minutes: run 35480247309
(#58, 01:00:24Z), 35480258216 (#63 attempt 2), 35480265803 (#64), 35480274513
(#35 attempt 2), 35480391028 (#35, 01:03:30Z). **Re-running does not help** —
three attempt-2 runs failed identically. The last green run was 35475200551
at 23:06Z.

**Nick's instruction, relayed 01:04Z 2026-09-20:** freeze. No git push, no new
PR, no workflow re-run, no marking a draft ready, no base changes — nothing
that triggers CI — until he lifts it. Local work only. He was cancelling
queued and running workflows and disabling the workflows on the repo.

**What this means for the morning:** a red check on any PR from that night is
this, not the PR. The question to ask before touching a PR's contents is
whether the job ran for seconds with no steps. See
[[gridiron-failure-modes]] — this is the inverse of the usual one: not
healthy-looking and broken, but broken-looking and fine.
