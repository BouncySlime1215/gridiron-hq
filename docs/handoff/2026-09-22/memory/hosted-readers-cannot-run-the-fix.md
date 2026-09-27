---
name: hosted-readers-cannot-run-the-fix
description: Start/Sit tells every reader to run scripts/fit-availability.mjs, which an invited friend on the hosted app cannot do; queued as a follow-up needing both PR #43 and PR #46 merged.
metadata:
  type: project
---

`availabilityDegradation()` (server/services/contingency.js:626) serves
`fix: 'run scripts/fit-availability.mjs (docs/tdd/play-chance-live.tdd.md, section 6)'`,
and Lineup.tsx renders it verbatim as "To fix: …" in the degraded-basis block.
That is honest on Nick's Mac and a dead end for anyone else. The moment Google
sign-in lets an invited manager in, that person reads a shell command for a
script on a server they have no account on, under a heading saying the numbers
they are looking at are degraded. It is the only served `fix:` string in the
app that a signed-in user cannot act on from the UI — routes/drafts.js:635 tells
them to run syncs that are buttons in Settings, which is fine.

The fix is small: render the command only when the reader could run it
(`deployment?.local`, or the session holds the admin grant), and otherwise say
the true thing — the numbers are degraded and whoever runs this install has to
re-fit them. The server keeps serving `fix` unchanged; this is presentation.

**Why:** it is the same defect class as [[basis-fields-served-never-rendered]]
one step on. Having made every surface name what priced its chance-to-play, the
remaining gap is that the remedy named is addressed to one person while the app
is about to have several.

**How to apply:** it needs BOTH open PRs merged first and cannot be done on
either branch. It reads `client/src/state/deployment.ts`, which exists only on
`claude/project-thread-xiezr0-hosted` (PR #46), and edits
`client/src/pages/Lineup.tsx`, which is PR #43's file. Do it as a follow-up on a
branch reset from origin/main once both land, not as a third branch during the
freeze.

Related: [[availability-unfitted-positions]].
