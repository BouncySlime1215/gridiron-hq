---
name: gridiron-pr-board-sync-2026-09-19-night
description: Chat sync, Google sign-in / ESPN credentials and Trade Brain draft PRs on gridiron-hq (#47 #48 #51 #71 #70 #41) split out of the 2026-09-19 night PR board, with heads, evidence files and order. Current as of 2026-09-20 02:35Z.
metadata:
  type: project
  modified: 2026-09-20T02:35:00.000Z
---

Split from [[gridiron-pr-board-2026-09-19-night]] (which keeps the global merge order, the 01:31Z rule and the 01:58Z GitHub freeze).

- Chat sync: #47 4c624ac (064_league_history_tables; docs-only: SPREAD_SCALE claim retracted, manual-only writer left two comment numbers stale, no fitted constant, no re-fit waits; 2,957/2,916/0/41 skip).
- Google sign-in: #48 b76963d (063_espn_credentials; before the first invite; 2,972/2,931/0/41 skip; evidence docs/tdd/espn-credential-ownership.tdd.md); #51 2bea7ec (grantAdmin); they own routes/leagues.js. NEW #71 8b1a036, branch claude/project-thread-n4052e-league-sync-creds, BASED ON #48's branch not main (needs platform/espn-credentials.js): league refresh uses the user's ESPN creds; 2,976/2,935/0/41 skip, five-question block + local numbers in body (#48 body same); evidence docs/tdd/league-sync-credentials.tdd.md; unconnected public ESPN leagues no longer sync anonymously (Nick's five all carry pairs). #48 before #71.
- Held VERIFIED ls-remote 02:09Z: claude/project-thread-n4052e-league-sync-creds-hold f3fb498, one above #71's 8b1a036, no PR; fast-forward onto #71 after the go; delete needs coordinator word.
- Trade Brain: #70 docs-only (Trade Brain provenance write-up), opened 01:35Z four minutes after the rule, stays open untouched; #41 45323ce (RED 7730804 luck, RED 6ab561a + GREEN 45323ce provenance fields; two pushes after freeze 02:11Z/02:22Z; accessor pair on hold d2cfb72) (luck min_n ordering + :775 false absent-reason string, tests G9a-f, fixture league 24).

Order: #48 before #71.
