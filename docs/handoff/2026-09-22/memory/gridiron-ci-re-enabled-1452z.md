---
name: gridiron-ci-re-enabled-1452z
description: Nick re-enabled CI workflow 357164314 himself at 2026-09-22T14:52Z because the repo is public and runs are free; the "never re-enable" rule is RETIRED, the no-hand-dispatch rule still stands.
metadata:
  type: project
---

**Measured 2026-09-22T15:19Z via `actions_list list_workflows` on BouncySlime1215/gridiron-hq:**
workflow `357164314` (`.github/workflows/ci.yml`, name "CI") has `state: "active"`,
`updated_at: 2026-09-22T10:52:31-04:00` (14:52Z). It is the repository's ONLY workflow.

**RESOLVED 15:24:45Z — it was Nick, deliberately.** His own words, in the timeline:
*"Yes / It's public so free now."* The repository is public, so Actions minutes are
not billed, which removes the entire premise of the old rule. **The standing
"disabled_manually, minutes spent until 2026-10-01, NEVER re-enable" rule is
RETIRED.** The separate rule against dispatching or re-running a workflow by hand
STILL STANDS until he says otherwise. No session should treat "CI is disabled, the local run is the
whole gate" as true any more — that sentence is in several evidence files and PR
bodies written before 14:52Z and is now stale wherever it appears.

**Confirmed live, not inferred:** pushing `2acc7bda` to
`claude/project-thread-3xqh5l-accessor-hold` (PR #91) at 15:19:35Z started run
`35746531117`, run number 352, event `pull_request`, status `in_progress`,
triggering actor `nmatta1215-svg`.

**Why:** a PR now gets a real external gate, so "green" can mean CI green rather than
only a local `npm run check`. That is a genuine strengthening — every figure this
project has argued over for two days came from one container's own tree.

**How to apply:**
- Do NOT dispatch or re-run a workflow by hand. That rule survives. What is gone
  is the "never re-enable" part and the minutes worry behind it — a public repo
  does not burn a quota. An ordinary push to a PR branch is not a dispatch and
  was always fine.
- Before writing "CI is disabled on this repository" into a PR body or an
  evidence file, re-read the workflow state. That line was correct this morning
  and is wrong now.
- `.github/workflows/ci.yml` runs with `timeout-minutes: 20`, and CI had never
  once completed on main before PR #7 brought the runtime inside it. A full
  `npm run check` measured locally 15:05→15:13Z is ~7.5 minutes, so the budget
  should hold, but a run cut off at 20 minutes is the failure to expect first.

- Every PR body or evidence file written before 14:52Z that says "CI is disabled on
  this repository, so the run above is the whole gate" is now wrong. Mine on #103 is
  one of them; it gets corrected on that branch's next authorised push, not by a
  prose-only commit that would invalidate its measured tree.

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; 15:45Z Nick: 'UNLIMITED ACTIONS'.
