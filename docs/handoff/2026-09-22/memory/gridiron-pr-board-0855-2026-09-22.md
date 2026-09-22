---
name: gridiron-pr-board-0855-2026-09-22
description: Release's PR board as of 08:55Z 2026-09-22 (c8420d3 on #102) for Nick's morning merge post — merge order, ready list, holds, and the branch conflicts found by the per-branch merge rehearsal.
metadata:
  type: project
  modified: 2026-09-22T08:44:00.000Z
---
Split out of [[gridiron-nick-morning-list-2026-09-22]] items 5 and 12 at 09:02Z. Board doc: docs/board/pr-board-2026-09-22-0800Z.md on draft PR #102 (`claude/release-train-2yv3x6-hold` @ c8420d3, ONE check run per the pause). Morning post = this board + verified figure per PR + merge commands.

**Order:** #95 first of everything (`gh pr ready 95` / `gh pr merge 95 --squash`; #96 HELD until UI's data-freshness.js consumer fix lands, then #96 WITH or AFTER #86, never before).

**Ready (merge rehearsal clean vs main):** #99 (ea7a208, VERIFIED Evidence Auditor 09:01Z) #87 #85 #81 #74 #66 #57 #55 #45 #41 #35 #15 #93 #97 #98 #101. Also #103 (a830c2b, verified 2x + accepted; merge after #94), #104 (e3a8676, accepted, guard pair pending), #106 (effW, Auditor 17b gate open).

**HOLD:** #86 (route unmounted — needs the two-line mount in server/index.js: import near :43, app.use '/api/data-freshness' beside :134 — plus consumer fix), #96 (see above), #68 (body stale), #36 (head stale), #72 (figure names no commit). #89 supersedes #47 → drop #47.

**Conflicts (combined 19-branch tree fails 3 tests that pass alone):**
- #94 and #100 conflict with #91 (routes/trades.js, trade-tactics.js, counterparty-pricing.js) → rebase onto post-#91 main; each is individually clean vs main (both statements true). Merge order #94→#103.
- #89 adds a scheduled job that #95's closed allow-list doesn't know (job-registry gap) → Scheduler.
- #91's trade-path caller doesn't report #89's archetype read SQL error (no such column espn_member_id) → Trade Brain + #89 owner.
- #88 and #89 both add migration 064 (rename). #93/#88 both add ESPN waiver/FAAB handling (read together).
Rest of Release's 08:55Z message truncated — fetch thread cmsg_01YAsw8AnFv4ioRMQw8dfPmTLtvcKX5oSjZz6x2L5FEXHk after reset.
