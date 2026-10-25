---
name: gridiron-evidence-file-form-5
description: Page 5 of the docs/tdd evidence-file standard (from ≥12:27Z 2026-09-20): the dead-branch tell, one registration per mounted tree, the runner requirement restated.
metadata:
  type: project
---

Continues [[gridiron-evidence-file-form-4]].

- Dead-branch tell (≥12:27Z, Opportunity; failure mode 184): the sharper check on an alternation is a branch that never matches anything; run each branch alone against the fixture and flag any matching nothing (a producer's spelling can differ: injury-report vs "injury report").
- One page-explanation registration per mounted tree (≥12:27Z, UI; failure mode 185): two usePageExplain registrations in one tree write one slot; pin with a test that the second is a component mounted only on the other branch.
- Runner requirement restated (≥12:27Z; failure modes 186, 157, 159): APPLIED is count(old) == 1, never `old in src` or a git diff (blind to untracked files); SHA-256 before, after and after-restore; a row whose hash did not move is refused; a control exercises the refusal (anchor present twice → NOT APPLIED anchor x2).
- Rows in a test file's header (≥12:28Z, Opportunity aaace23): mutation rows may live in the test file's header beside the assertions, but CLAUDE.md's TDD rule still requires a docs/tdd/ evidence file: a short one pointing at the header with the two source hashes, the full-check line (numbers, the commit measured, "no source change" when the head is test-only) and any runner flag the file needs (e.g. --experimental-test-module-mocks). A mutation that fails more than the aimed assertion is stated as shared, not replaced by a contrived isolating edit.
- Split-proof form (≥12:32Z, feature audit; failure modes 191, 193): re-run the motivating mutation with the new assertion in place (red) and again with it removed (green), the removed-assertion re-run table; before splitting inside an arm, probe that the fixture enters it; a fixture reaching one branch of a classifier means the classifier is exported and tested per state.
- `old` and `new` are both measurements, not one measurement and a prediction (≥12:33Z, Opportunity, verbatim; failure mode 197): the row not measured is the row that was wrong.
- Running scripts (≥12:33Z, Model audit; failure mode 196): never edit a running script in place; a repoint is a new file under a new name; the held target is read from the process's own descriptor.
- Tool fixes carry a mutation row (≥12:33Z; failure mode 198): a fix to the checker itself ships with a row (byte restored → the attribution test red; fixed → green).
- Committed runner (≥12:35Z, UI; failure mode 200): an evidence table's runner and mutation list are committed under docs/tdd/sweeps/ (Coach's harness *.json and UI's mutation-runner.py + *.mutations.json are the two forms) so a reader re-derives the table from the committed copy.
- One page-explanation registration per mounted tree (≥12:35Z, UI's wording; failure modes 185, 199): two usePageExplain registrations in one tree write one slot; the failure is a blanked summary (the loser's cleanup fires setInfo({}) on the next render), the same shape as the provider-identity loop the hook's header guards.
- The full check (≥12:36Z, Trade Brain): `npm run check` = typecheck + lint + test + build + smoke; chaining `npm test` after it runs the suite twice; a full-check line names that command and the commit.
- doesNotMatch exception (≥12:36Z): an alternation inside a negative assertion is a wider net on the safe side and is left as is; the honest-exception form: a mutation the aimed test misses but a named neighbouring test in the same file catches is stated as such (Trade Brain M9), never counted as killed by the aimed test.
- Pin tests and fixtures (≥12:38Z, wiring map; failure modes 208, 209): a pin test asserts its own premise first (the offset points at the opening quote) before asserting the branch it pins; fixture names in test SQL never collide with real tables (zz_fixture_ prefix), since a census reads a test's DDL as a create site.
