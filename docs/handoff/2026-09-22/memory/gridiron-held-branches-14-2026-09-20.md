---
name: gridiron-held-branches-14-2026-09-20
description: Page 14 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads and local patches reported from 07:56Z (Google sign-in outlook-route patch on 803074d) and later.
metadata:
  type: project
---

Continues [[gridiron-held-branches-13-2026-09-20]] (merge order for stacked holds: /mnt/project-files/hold-branch-sweep-2026-09-20T0736Z.md, fresh file at the go).

| Thread | Branch / artefact | Head | Lands how | Notes |
|---|---|---|---|---|
| Google sign-in | /mnt/project-files/outlook-route-803074d.patch (local patch, NOT a branch; the #71 hold c986b80 unchanged apart from a doc-only commit pending) | three commits in git am format on base 803074d (RED test, route, evidence file) | `git am --3way` on a fresh detached 803074d applied clean: one step AFTER #42 fast-forwards to 803074d (ruling 07:57Z; morning-go checklist) | GET /api/leagues/:id/outlook: numbers on that tree after the patch: npm run check exit 0, 3,063 / 3,022 / 0 / 41, smoke on an isolated DB. Five cases (four red before the route; unauthenticated 401 passes because the mount authenticates before routing, kept as that statement); five injections APPLIED by hash, each killing its named test, plus a NO-OP control; existence-check-before-membership-check pinned by a red test as information-hiding. Deleted-league case: 403 not 404 (league_memberships.league_id ON DELETE CASCADE, migration 006, PRAGMA foreign_keys = ON), asserts the cascade; the route's own 404 recorded as defensive, NOT counted as covered. Nothing pushed; patch branch local only |
| Opportunity | claude/project-thread-w45mur-wiring-names-hold | 775e339 → e53ff1a (pushed 08:05Z, p15) | new PR off main 791b131; STACKING BASE for the fantasy plan's memo-key (merges 775e339 next commit) | DEFAULT_ACTIVE_PROBABILITY = 0.92 exported from availability-basis.js (docstring names player-week-engine.js, trade-engine.js :496/:3032, roster-risk.js :258; pairs with default_durability and unfitted_position); a source-reading test requires each constant to be its own literal. 2,961 / 2,920 / 0 / 41 on its own tree; evidence canonical (named tests, 5/5 kills, two controls); ONE SURVIVOR declared (role arm mislabelled as pooled uncaught; killing fixture named; being closed). :639 answer YES: a legacy constants row can carry a substituted prior; UI's Unverified tier is the only correct rendering |
| Coach | claude/coach-grounded-4l8hno-hold | f5406ee → f62896e → fdfebf5 (11:19Z, p17) (08:01Z; f62896e3ea53ee20b832db848e00bac8a143add5) | new PR off main | full check 3,052 / 0 / 41 in 456 s; 48 mutations all killed; PR body /mnt/project-files/pr-coach-body-f5406ee.md re-measured for f62896e (copy to pr-coach-body-f62896e.md pending, f5406ee file left as a pointer); ONE run-sheet script scripts/build-person-profiles.mjs (dry-run default, --write, --person); nulls name their kind; catalog 36 → 41 |
| Feature audit | claude/project-thread-5f9c3y-unpriced-hold | ec13adb PUSHED 08:01Z (D13) | new PR off main; stacks on nothing | clean tree: 2,954 / 2,913 / 0 / 41, 875 files, build 3.17 s, smoke, exit 0. Per side me/them value_out_unpriced / value_in_unpriced = COUNTS OF PLAYERS; asset value_priced boolean, value always a number; fairness 'partly unpriced' replaces the confident label |
| Feature audit | claude/project-thread-5f9c3y-draft-chain-hold | c6df372 PUSHED 08:01Z; SUPERSEDES 2692006 | new PR off main | 2,964 / 2,923 / 0 / 41, 876 files, build 3.00 s, smoke, exit 0 |

Continues: [[gridiron-held-branches-15-2026-09-20]].
