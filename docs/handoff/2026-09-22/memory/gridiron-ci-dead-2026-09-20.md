---
name: gridiron-ci-dead-2026-09-20
description: From ~01:00Z on 2026-09-20 every gridiron-hq CI run failed two seconds after starting on every branch at once — Nick confirmed the GitHub Actions limit is hit, the repo is under a push/CI freeze, and a red check from that point tells you nothing about the PR.
metadata:
  type: project
---

**A two-second job is not a test failure.** It is the job dying before checkout,
before install, before any test body ran. When you see it, stop reading the diff.

## What happened

Every CI run created from about **01:00Z on 2026-09-20** failed this way, on
four branches at once within thirty seconds:

| run | PR | created | duration |
| --- | --- | --- | --- |
| 35480247309 | #58 | 01:00:24Z | 5 s |
| 35480258216 | #63 | 01:00:36Z | ~5 s |
| 35480265803 | #64 | 01:00:45Z | 19 s |
| 35480274513 | #35 | 01:00:55Z | 2 s |
| 35480391028 | #35 | 01:03:30Z | 2 s |

Every run created before roughly **23:15Z on 2026-09-19 was green**, including
two on the release-train branch. The #35 commits were a single docs file that no
test reads (`grep -rln RELEASE-TRAIN test/ scripts/` is empty), so there was no
route by which it could fail the suite at all.

## The cause — inferred, then confirmed

**Confirmed by Nick at 01:04Z, with the number at 01:08Z: 2,000 of 2,000
minutes used, resetting 1 October 2026.** It was inferred first from the API
alone, and the arithmetic is worth keeping because it is how to recognise this
again before anyone confirms it. This was
run **350** on a private repository at about **6.5 minutes** a run — roughly
2,400 minutes against an included 2,000. An exhausted allowance fails a job in
exactly this shape: created, instantly failed, **and no log written at all** —
the log blob **404s** rather than returning empty, so `get_job_logs` and a
direct `curl` of the signed URL both fail.

A platform incident is indistinguishable from the API. **The billing page is the
only thing that separates them, and no session can read it** — which is why the
inference had to be reported to Nick rather than settled by a thread.

## Where it landed

The push freeze of 01:04-01:08Z was **lifted** once `ci.yml` — the repo's only
workflow — was set to `disabled_manually`. **A push now triggers nothing, so
pushing is safe again.** What stays forbidden until the reset: **re-enabling
the workflow, and re-running anything from the Actions tab.** A re-run spends
the exhausted thing and fails in two seconds regardless.

**Merging is not gated.** This is a private repository on the **Free plan**, so
no required-check rule can exist on `main`. A red or missing check on a PR here
is not a statement about its contents, and the evidence standing in for CI is
each PR's own body, which carries its owner's full local run — suite count,
failures, lint, typecheck, smoke — taken before the allowance ran out.

## How to behave while it holds

- **One re-run, then stop.** A job that dies in two seconds dies in two seconds
  again; a second re-run burns the same allowance that is the suspected cause.
- **One comment on the PR, not one per event.** Every new push re-triggers and
  re-fails, so each head produces another wake. The comment is per-PR, not
  per-failure. It went on #35 as `issuecomment-5746576739`.
- **Do not read a red check as a verdict on a PR** merged or reviewed during
  this window. Suite numbers quoted in PR bodies were measured before it
  started and are still good; the check is not.
- The last known-good suite runs: `85146b9` (#35), and the green runs listed
  under runs 337-346, all before 23:15Z.

See [[gridiron-release-train-2026-09-19]] for the six PRs whose merge may be
gated on this.

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; see state 1199/1198.
