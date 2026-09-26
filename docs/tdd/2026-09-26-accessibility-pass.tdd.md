# Item 58 ACCESSIBILITY PASS: record

<!-- prereg: docs/tdd/2026-09-26-accessibility-pass-prereg.md -->

The pre-registration (bar B1-B6) was committed in the RED commit, before any fix.

## RED

On origin/main 46b39464, `test/a11y-check.test.js` fails 7 of 12 tests. After main moved to ef726b35 (#518 trimmed DevHub), the check reads the same numbers except the scan: 130 files and 18 enforced findings (15 unlabeled controls, 3 click-only elements). `node scripts/check-a11y.mjs` reports:

- **Contrast:** 10 of 78 pairs are below AA.
- **Structure:** 5 gaps.
- **Scan:** 19 findings in enforced files (16 unlabeled controls, 3 click-only elements) and 4 report-only findings.

## GREEN

After the fix, all 12 tests pass. `GRIDIRON_A11Y_CHECK=enforce node scripts/check-a11y.mjs` reports PASS:

- **Contrast:** 0 of 78 pairs below AA.
- **Structure:** 0 gaps.
- **Scan:** 0 enforced findings. The same 4 report-only findings remain, all in locally owned Trades files.

Token changes, each the smallest step that reaches AA:

| token | before | after | worst pair before -> after |
|---|---|---|---|
| light `--c-subtle` | #7a8293 | #686f7d | on soft 3.48 -> 4.55 |
| light `--c-accent` | #4b5bff | #4a5afc | on its tint 4.45 -> 4.54 |
| light `--c-green` | #12803f | #127f3e | on its tint 4.46 -> 4.52 |
| dark `--c-subtle` | #747b8a | #7e8492 | on soft 4.01 -> 4.55 |

In light mode, subtle text now sits next to muted (#676f80). The two greys are close to each
other, because AA leaves no room for a lighter third grey.

## Browser walk (headless Chromium, built client, API offline, /players)

| | before | after |
|---|---|---|
| First Tab stop (1440 and 375) | the Today nav link | Skip to content |
| Enter on the skip link | n/a | focus lands on `<main id="main">` |
| Tab stops in the closed phone drawer (375, first 14 Tabs) | 7, all off-screen | 0 |
| Open phone drawer | 7 links, reachable | 7 links, reachable |
| Rail link names (sidebar collapsed) | `title` only (tooltip) | aria-label = area name |
| Tabs row: ArrowRight from Board | nothing | selects and focuses Rankings |
| Tabs row: tab stops | 4 of 4 | 1 of 4 |

Screenshots of the first Tab stop are in `docs/tdd/a11y-58/`: before and after, at 1440 light and 375 dark.
