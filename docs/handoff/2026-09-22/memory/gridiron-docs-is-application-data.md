---
name: gridiron-docs-is-application-data
description: docs/CLAUDE-NEXT-STEPS.md is served at runtime and asserted byte-for-byte by a test — editing it turns the suite red.
metadata:
  type: project
---

`docs/CLAUDE-NEXT-STEPS.md` is **application data that happens to live under
`docs/`**, not documentation. Verified at `791b131`:

- `server/services/nfl-research-lab.js:279` — `researchMasterPlan()` returns
  `fs.readFile(path.join(root, 'docs/CLAUDE-NEXT-STEPS.md'), 'utf8')`.
- `server/platform/paths.js:55` — `export const CANONICAL_PLAN = path.join(DOCS_ROOT, 'CLAUDE-NEXT-STEPS.md');`
- `server/routes/nfl-market.js:46` serves it at
  **`/api/nfl-market/research-lab/plan`** (the router-relative path is
  `/research-lab/plan`).
- `test/nfl-execution-integrity.test.js:258` asserts the endpoint returns it
  **byte for byte**.

**So editing that one file turns the suite red.** It is the only documentation
file any test opens at runtime, per a corrected grep over `test/*.test.js` at
`791b131` (the model-evidence audit names `docs/design/design-system.md` as a
second; that one is not opened by a test in the `test/*.test.js` glob).

**Why it matters:** the broad rule "a docs-only commit cannot move the check's
figure, so a figure measured at an earlier commit still describes this one" is
used across this project to reuse full-suite numbers. That rule is true **only
if the commit does not touch `docs/CLAUDE-NEXT-STEPS.md`**. The exposure is
forward: someone edits it and quotes a figure they have just invalidated.

Found by the Google sign-in thread, corroborated independently by the
model-evidence audit, after a feature-audit grep missed it — see
[[bash-grep-caret-backslash-n]] for why the grep missed it.

It is a betting-side document, so any edit to it needs an owner allowed in
the betting tree.
