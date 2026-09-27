---
name: gridiron-pr-board-ui-2026-09-19-night
description: UI draft PRs on gridiron-hq (#43 #46 #53 #58 #60 #65 #69 #73 #75 #76 #78) split out of the 2026-09-19 night PR board, with heads, merge order and conflict resolutions. Current as of 2026-09-20 02:31Z.
metadata:
  type: project
  modified: 2026-09-20T02:31:00.000Z
---

Split from [[gridiron-pr-board-2026-09-19-night]] (which keeps the global merge order and the 01:31Z rule). All draft.

- #43 b7d88fc (mutation holes closed: availability_basis on /news, slots_not_modelled on lineupCall response).
- #46 c05b940; #53 1f72e08. Settings.tsx: #46 before #53, plain union.
- #58 f15f871 on #44's 3deb9da, renders projection_fit (#44 before #58).
- #60 24ad65b on #57; must merge AFTER #57 (tradeWeekContext takes a league arg only on #57; 3 of #60's 7 tests red in the wrong order, 20/20 in #57 → #43 → #60). lineup-brain.js #43/#60 conflict: take #60's side plus #43's `const notModelled = slotsNotModelled(lg, slots)` re-added.
- #65 "do not merge" #46/#53 resolution 690e7e4.
- #69 fd3d6cc (opened as the no-new-PR rule crossed in transit; left open).
- Heads #43/#46/#53/#58/#60 above each carry their TDD evidence file, pushed after their own full local check (02:12Z).
- NEW #73 (design system) head 1fe949e, branch claude/project-thread-xiezr0-design-system, base main 791b131, https://github.com/BouncySlime1215/gridiron-hq/pull/73: docs/design/design-system.md + tokens in client/src/index.css (extends, does not replace) + font link + test/design-system-tokens.test.js; local 2,958/2,917/0/41 skip. The last new PR from UI: every redesign step lands as commits on this branch. Orphan exports in client/src/components/ui/DesignSystem.tsx (only Skeleton, ToastProvider, PageHeader consumed) adopted or dropped per step. Confidence :48 "Calibrated" from bare thresholds routed to audit.
- #75 claude/project-thread-xiezr0-basis-chip 64420d3, based on #73 (1fe949e): redesign step 1 = glossary (client/src/lib/glossary.ts, one record per quantity, two floors under two names) + BasisChip.tsx collapsing four provenance renderings; 2926/2967 pass, 41 skipped; seven mutations each one test red. OPENED DURING THE FREEZE, stays open untouched. Order: #73 before #75.
- #76 claude/project-thread-xiezr0-stat-block 48439e7 on #75 (step 2, opened after freeze, untouched). Order: #75 before #76.
- #78 claude/project-thread-xiezr0-deep-dive on #76 (step 3 deep-dive drawer, opened 02:29:04Z after freeze, untouched). Order: #76 before #78.
- Stray remote branch tdd/xiezr0-hosted (identical commit to #46's c05b940, no PR) awaits deletion in the morning; do not delete overnight.
- FREEZE BREACH: UI pushed to #43/#46/#53/#58/#60 branches and opened #75 without acknowledging the 01:58Z freeze; push times asked 02:14Z; told to use -hold branches for step 2 onward.
- Redesign proposal https://claude.ai/artifact/9ajVsBBoSZsKs6PbREZm4A. X's & O's (/teams) is editorial seed content, 12/32 coordinators "TBD (camp)".

Order: #44 before #58; #57 → #43 → #60; #46 before #53; #73 before #75; #75 before #76; #76 before #78.
