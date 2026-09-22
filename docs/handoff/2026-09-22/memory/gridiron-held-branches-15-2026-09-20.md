---
name: gridiron-held-branches-15-2026-09-20
description: Page 15 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads reported from 08:03Z (feature audit's Decision Inbox publisher hold, pending) and later.
metadata:
  type: project
---

Continues [[gridiron-held-branches-14-2026-09-20]] (merge order for stacked holds: /mnt/project-files/hold-branch-sweep-2026-09-20T0736Z.md, fresh file at the go).

| Thread | Branch | Head | Lands how | Notes |
|---|---|---|---|---|
| Feature audit (NEXT) | new no-PR hold off main, name to follow | writing since 08:01Z; CLEAR TO LAND 11:15Z (wiring map 4389a7a) | stacks on nothing; DEPENDS on the wiring map's test/decision-inbox.test.js rebuild (a prerequisite: the file fetches the inbox over HTTP and cannot survive caac88a) | SPLIT 11:04Z: the publisher stops (waiver-brain.js:303, trade-engine.js:2865) off main; waiverUpgrades removal AFTER Trade Brain's ef3164e line (trades.js:35 imports it; removing a definition is not order-safe); RED test; evidence states the dependency |
| SWEEP 11:05Z (Opportunity) | /mnt/project-files/hold-branch-sweep-2026-09-20T1105Z.md | 43 branches; SUPERSEDES the 0736Z file as the merge-order source (ruling 11:04Z) | nine heads moved; three rows resolved from the graph; UI stack ten deep to af7f01a (+57 over #78, one PR); ONLY non-ff: f921do-avail-basis-hold a7ac178 +1/−5 vs e53ff1a, memo-key 761af34 inherits | — |
| Google sign-in | claude/project-thread-n4052e-league-sync-creds-hold | da8ec48 → 1171d66 (11:17Z, p17) (11:00Z; c986b80..da8ec48; pushed to the hold only; #71 still 8b1a036) | #71 at the go | 2,985 / 2,944 / 0 / 41 on da8ec48; PR body /mnt/project-files/pr-71-body-da8ec48.md (ten commits, 13 files, +952/−17; the c986b80 file deleted); the outlook patch waits on #42 |
| Opportunity | claude/project-thread-w45mur-wiring-names-hold | e53ff1a → dd84efa (11:12Z, p17) (pushed 08:05Z; was 775e339) | new PR off main; base for memo-key (merge e53ff1a next) | declared survivor CLOSED: 6 of 6 caught; closing needed role_rates rows + a 2026 wk1 appearance with snaps + useRole true; new test pins role over pooled and a rookie priced by role with the prior flagged default (basis and flag independent); 2,962 / 2,921 / 0 / 41 |
| Fantasy plan | claude/project-thread-f921do-memo-key-hold | 761af34 → 00b4c28 (11:20Z, p18) (11:01Z; evidence rows only; base hash 51fe17160436 restored) | ONE PR from 761af34 (avail-basis a7ac178 ancestor only; a7ac174 was a typo, full sha a7ac1784ed22986aec1540fe4c3a6def8613598e) | NEXT (11:04Z, interrupting the offseason work): merge e53ff1a + the one-line DEFAULT_ACTIVE_PROBABILITY swap + hash sweep + push, THEN offseason-model.js |
| Fantasy plan | claude/project-thread-f921do-weekly-scores-hold | 6b77382 (11:01Z; was 1ed7b79) | no PR of its own; carried by 803074d | hash-recorded re-run found two rows recorded caught were SURVIVING (deleting the decided check; deleting bothScored): an in-progress week served as final; a missing side read as 0, a null-score row indistinguishable from a shutout; two tests added, no impl change; eleven of eleven red; 2,964 / 2,923 / 0 / 41; "E1 → 5 fail" withdrawn in text |

Continues: [[gridiron-held-branches-16-2026-09-20]].
