---
name: gridiron-manager-profiles-absent
description: The live Fly app holds zero saved manager profiles for all five leagues including Transfer portal, checked 2026-09-19 — the likely surviving copy is on Nick's Mac.
metadata:
  type: project
  modified: 2026-09-19T16:00:00.000Z
---

Nick asked on 2026-09-19 whether the manager/negotiation profiles he built
for himself and the other managers in his **Transfer portal** league still
exist, so work could continue from them.

Checked `GET /api/trades/:leagueId/brain/managers` on gridiron-hq.fly.dev for
all five leagues. Every manager in every league comes back `is_set: false`,
`notes: null`, `updated_at: null`, `tradeability: "fair"`. `is_set` is
literally `!!p` where `p` is that manager's row in `manager_profiles`
(`server/services/league-brain.js:135`), so **the `manager_profiles` table is
empty on Fly** — the values shown are the unset defaults the endpoint
synthesises from the league rosters. The owner names are real because they
come from the ESPN payload, not from any saved profile.

There is also no manager-signals surface on the deployed build:
`/api/manager-signals`, `/api/trades/:id/brain/signals` and
`/api/leagues/:id/manager-signals` all 404, and `manager_signals` appears
nowhere in `main`. The old `/api/tradelab/:id/partners` returns 410, retired
2026-09-18 in favour of `/api/trades/:leagueId/find`.

So the profiles are not in the deployment. If they survive anywhere it is on
Nick's Mac. Do not tell him they can be recovered from Fly. Correct the
sibling claim in [[gridiron-live-data-state]]'s neighbours that manager
signals existed for league 4: as of this check no league has any.
