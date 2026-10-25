---
name: gridiron-pr-body-diffs-2026-09-22
description: Stale PR-body text vs corrected merged-tree-check replacement text for #48/#51/#81/#71, held for Release to apply — not yet pushed.
metadata:
  type: project
  modified: 2026-09-22T02:21:22.458Z
---

Google sign-in thread's 4-PR merged-tree-check unit, run 2026-09-22 01:34Z-02:15Z, source-isolated scratchpad worktrees against main@654ff93, git write-tree matched before/after every run (no run voided), all four `npm run check` exit 0. NOT yet applied to any PR — held for Release/Nick's word before editing live PR bodies.

## #48 (branch head b76963d)
Current body: "Full local check ... on this head" — 2,972/2,931/0/41, base main@791b131 (stale).
Replacement: "Full local check on merged tree a1cfe5298a363d3c72d2cb809be0db717ed92071 (branch head b76963d merged onto main@654ff93). npm run check — exit 0: typecheck clean; lint clean, 885 JavaScript files; test 3,008 tests, 2,967 passed, 0 failed, 41 skipped; build clean; start:smoke passed (32 teams)."

## #51 (branch head 2bea7ec)
Current body: no commit named, 2,955/2,914/0/41, base main@791b131 (stale).
Replacement: "Full local check on merged tree b476114a8f211775ab6b90f2cafdbd4b205f4461 (branch head 2bea7ec merged onto main@654ff93). npm run check — exit 0: typecheck clean; lint clean, 882 JavaScript files; test 2,991 tests, 2,950 passed, 0 failed, 41 skipped; build clean; start:smoke passed (32 teams)."

## #81 (branch head b3ba1a7)
Current body: commit ef513b6, 2,950/2,909/0/41, base main@791b131 (stale).
Replacement: "Full local check on merged tree 1399691a1d91a04f59a419883138a9ee5d7887b2 (branch head b3ba1a7 merged onto main@654ff93). npm run check — exit 0: typecheck clean; lint clean, 881 JavaScript files; test 2,986 tests, 2,945 passed, 0 failed, 41 skipped; build clean; start:smoke passed (32 teams)."

## #71 (branch head a2e7f97, stacked on #48)
Current body: commit 1e8dddd, 2,985/2,944/0/41. Base correctly named as #48, but #48 has since moved (main absorbed 654ff93 without landing #48), so the figure is stale relative to the real merge onto current main.
Replacement: "Full local check on merged tree f4d4d4c7ba537d6fcca8b8f7595a208377b72308 (branch head a2e7f97, which already contains #48's b76963d, merged onto main@654ff93). npm run check — exit 0: typecheck clean; lint clean, 888 JavaScript files; test 3,021 tests, 2,980 passed, 0 failed, 41 skipped; build clean; start:smoke passed (32 teams)."
