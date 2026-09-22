# CURRENT: the single pickup file

Both sides (local Claude and the cloud coordinator) rewrite this file before stopping. Read docs/handoff/2026-09-22/START-HERE.md first if you have no context.

## Last written by

Cloud coordinator, 2026-09-22 ~19:00Z.

## State of main

Tip (git ls-remote origin refs/heads/main): b600afa1f344a9fc431028155711218142460c6d. Deployed tree is still c5ee3b54 (#99). 36 PRs merged today (memory board list of 33 plus #130, #147, #131).

## Open PRs, one line each

- #128 5f9242d8: MLB removal, merge on CI green.
- #118 cf60f5e3: position applicability, one click (confirm green, squash).
- #125 737ae4e: needs evidence file plus five-questions body.
- #67 / #74: need fresh base plus one check.
- #116 98129cbc: merge on green.
- #146 5dfedb80: merge on green.
- #147 60558e7: merge on green (landed as 532fe18 by the time this was written; verify).
- #94 / #100 / #103 / #120: Trade Brain queue, in that order.
- #135: advisory. #134: WIP, stays draft.
- Never merge: #136, #140 to #143, archive/* branches.

## Next three units in order

1. Merge the green PRs above, one at a time, gate v2 (skills/gridiron-merge-gate-v2/SKILL.md).
2. Officials and schedules ingest from nflverse-data (memory/gridiron-nflverse-cc-by-attribution.md).
3. Level correction at weekly-ensemble.js:69-77, Auditor-gated.

## Nick decisions still owed

- Brake on or off before any deploy.
- Delete Model.tsx and Edge.tsx, yes or no.
- Keep or close #66, #79, #80, #83.

## Rules in one breath

Usage cap 25% per 5-hour window; one session at a time; merge gate v2; verify once; no secrets in chat; no table drops; nothing paid; licence first.
