---
name: availability-live-baseline-numbers
description: The measured before-reading taken from the live app on 2026-09-19 at 19:58Z, so the availability fit can be judged on a diff — and why the 0.708 figure everyone quotes is not what live serves.
metadata:
  type: project
  modified: 2026-09-19T20:15:59.584Z
---

Captured with `scripts/capture-availability-baseline.mjs` (PR #18) against
gridiron-hq.fly.dev, authenticated with GRIDIRON_FLY_TOKEN. Two reads per league,
`/api/trades/:id/rosters` then `/api/trades/:id/offer`. `--find` adds the only
surface carrying `acceptance`. `--compare=before.json` re-reads the **same** target
player by id rather than re-picking, because the pick rule ("most valuable player
I do not own") moves once values move, and comparing two different players shows a
difference that means nothing.

Every league reads basis `constants`, stamp `absent|absent` — the missing-table
state, so neither availability table exists yet.

- **Jahmyr Gibbs, RB, `injury_status` null, `practice_status` null:
  `active_probability` 0.805.** This is the number to check after the fit, and it
  should rise toward ~0.95.
- **The 0.708 → 0.952 pair quoted everywhere is `contingency.js:654`'s cohort
  example, not what live serves for one player**, because the base prior blends
  in. Gibbs' gap is about 15 points, not 25. Expect someone to check one player
  rather than the cohort, so have the real number ready.
- League 3 (Transfer portal): playoff odds 0.26, CI90 [0.2328, 0.287], horizon now
  0.806 / playoff 0.194, `adj_ppg` 14.77, value 10787, opening package
  Chase Brown + Ladd McConkey + Devaughn Vele at ratio 1.00 for +3.77 ppg,
  response digest `60977fc82949c9e5`.
- League 1: playoff odds 0.62 on the same player.
- `acceptance` and `perception_delta` came back null — correct, and not a data
  gap: the offer ladder has no acceptance field at all (see
  [[availability-fit-before-after]]).
- App latency during the capture: 100-145 seconds per read, one read needed three
  attempts. Consistent with [[fly-app-stalls-in-bursts]].
