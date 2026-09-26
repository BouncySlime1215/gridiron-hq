# Item 58 ACCESSIBILITY PASS: pre-registration

Written before the fix. Source: Nick's reserve queue item 58: "keyboard nav through all 7 areas,
focus order, aria labels on icon buttons, contrast >= AA; a CI check."

## What is measured

`node scripts/check-a11y.mjs` on the tree (flag `GRIDIRON_A11Y_CHECK`, default `report`; CI runs
`enforce`). It has three parts, and each bar below is one number from it.

Files local builders own are scanned but never enforced or edited: the Trades client and War Room,
the Coach drawer, Numbers & People and the AI spend tracker (`scan-jsx.mjs` PROTECTED).

## Before (measured on origin/main 46b39464, 2026-09-26)

- Contrast: 78 token pairs, 10 below AA.
  - Light `--c-subtle` is 3.48 to 3.86:1 on every surface.
  - Dark `--c-subtle` is 4.01 to 4.34:1 on card, soft and raised.
  - Light accent on soft is 4.46:1, and on its own tint 4.45:1.
  - Light green on its tint is 4.46:1.
- Structure: 5 gaps.
  - There is no skip link.
  - Rail links have no name.
  - The closed phone drawer is still in the Tab order.
  - Tabs have no arrow keys and a tab stop per tab.
  - Sheet has no focus trap and does not return focus.
- Scan: 128 files.
  - 19 findings are enforced: 16 unlabeled controls and 3 click-only elements.
  - 4 are report-only.
  - There are 0 unnamed icon-only buttons.

## Pass bar (all must hold)

- **B1 contrast.** 0 of the checked pairs are below AA, in light and dark.
  - Text tokens (ink, ink2, muted, subtle, accent, green, amber, red) on bg, card, soft and raised: >= 4.5:1.
  - Accent ink on accent: >= 4.5:1.
  - Each status colour on its tint over a card: >= 4.5:1.
  - The focus ring (accent) on bg and card: >= 3:1.
- **B2 icon names.** 0 icon-only buttons or links without aria-label in enforced files.
- **B3 keyboard reach.** 0 click-only non-interactive elements and 0 positive tabIndex in enforced files.
- **B4 labels.** 0 unlabeled input, select or textarea in enforced files.
- **B5 keyboard path through the seven areas.** 0 structure gaps: the skip link comes first, all 7 areas are nav links, rail links are named, the closed drawer is inert, Tabs use arrows, Home and End with one tab stop, and Sheet traps and returns focus. The pure key helpers are proven by unit tests.
- **B6 gate.** In enforce mode the CLI exits 1 on a planted violation in an enforced file, and 0 on the same violation in a protected file. The CI step runs enforce.

## What would fail it

- Any B1-B6 number above zero.
- A contrast fix that moves a token by more than it needs. Each change is the smallest step that
  reaches AA, and before/after values are listed in the PR.
- Any edit to a protected file. `git diff --stat origin/main...HEAD` must show none.

No served number changes; there is no shadow period. Contrast, labels and keys are either met or not.
