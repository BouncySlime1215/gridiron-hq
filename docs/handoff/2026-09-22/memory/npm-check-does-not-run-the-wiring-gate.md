---
name: npm-check-does-not-run-the-wiring-gate
description: "`npm run check` omits check:wiring, which CI runs as its own step — so a clean local `npm run check` does not predict CI."
metadata:
  type: project
  modified: 2026-09-22T17:12:52.979Z
---

`npm run check` is **not** what CI runs. `package.json:20` is:

    typecheck && lint && test && build && start:smoke

CI runs an additional step CI-only: `npm run check:wiring`
(`scripts/wiring-map.mjs --check`) at `.github/workflows/ci.yml:70`, between
lint and test. A branch can pass `npm run check` locally with a write-tree
guard either side, twice, and still be red in CI on the wiring gate.

**Why:** 2026-09-22, found from the Opportunity thread while verifying #116.
Every "clean local run" quoted in that thread — the two on `b0c1616d` and
the one on `605ab3f6` that #99 actually merged on — had never exercised the
wiring gate at all. The gap was invisible until the gate went red for an
unrelated reason. This is the same shape as
[[verify-the-merge-not-just-the-head]]: the verification was rigorous and
still had a hole, and rigour is not what closes a hole of this kind.

**How to apply:**
- Pre-push, run `npm run check && npm run check:wiring`. One is not the other.
- When quoting evidence, say which commands ran. "npm run check, exit 0" is a
  narrower claim than "CI-equivalent, exit 0" and should not be written as
  the second.
- The gate's blocking findings are `table-never-written` and
  `producer-with-no-caller`. It also reports stale **accept-list** entries
  separately; those are non-blocking and do not drive the exit code, so an
  exit 1 is always one of the blocking classes.
- `check:wiring` reads the source tree only. It is safe to run in a detached
  worktree at bare `origin/main` to decide whether a red gate is yours — do
  that before proposing any fix.

Related: [[gridiron-file-allocation]] for whose file a wiring finding belongs
to; the accept list is Wiring map's, not the finding thread's, so a stale
entry is raised rather than edited.
