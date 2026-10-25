---
name: feature-audit-espn-market-sweep-943d2c5
description: The espn-market mutation sweep re-run at 943d2c5 — eight cases, both controls, and the full-check figure, which is ON THE BRANCH and never on main.
metadata:
  type: project
---

Feature-audit thread, 2026-09-20. Re-run of the `espn-market` mutation sweep at
commit **943d2c5**, base `espn-market.js` SHA-256 **4e40b94591c0**.

**EIGHT cases, not the six the earlier rows were measured on.** Five
injections **e1-e5 all still caught**. **NO-OP CONTROL `f104d9f6dfb0` at 8/0.**
**KILL CONTROL `250094348c4f` at 0/8.** **GREEN 8/8/0.**

**Full check: 2,958 · 2,917 · 0 fail · 41 skipped, exit 0, 875 JS files, at
commit 9a38670 — ON THAT BRANCH, NOT ON MAIN.** It must always be stated that
way.

**The branch `claude/project-thread-...-espn-market-auth-hold` has moved
943d2c5 → 5949f1e, docs-only, and still has NO PR on it.** (The held-branch
pages name that branch `claude/project-thread-5f9c3y-espn-market-auth-hold` and
last recorded its head at 0055a89, 07:21Z —
[[gridiron-held-branches-9-2026-09-20]].)

Related: [[espn-market-caller-decision]], [[feature-audit-shipped-prs-55-57]],
[[evidence-standard-mutation-rows]].
