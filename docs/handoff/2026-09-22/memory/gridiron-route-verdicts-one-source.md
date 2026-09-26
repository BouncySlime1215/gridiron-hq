---
name: gridiron-route-verdicts-one-source
description: docs/wiring/route-verdicts.json is the single source of route keep/delete verdicts in Gridiron HQ; two tools disagreeing about one route is how a report names live code as about to die.
metadata:
  type: project
  modified: 2026-09-22T04:19:10.980Z
---

**`docs/wiring/route-verdicts.json`**, added 2026-09-20 on
`claude/wiring-map-8f96ur`. Holds one verdict per route with the OWNING THREAD's own
reason — never the checker's inference — plus `keep_statuses`, the verdicts that mean
the route is not being deleted.

Statuses: `delete`, `delete-route-only` (route dead, service behind it live),
`kept-no-screen`, `kept-tombstone`, `external-caller`,
`orphaned-backend-of-deleted-page`, `already-removed`, and `unverified` for a row no
owner has ruled on. **`unverified` is not a verdict** — it means verify before cutting.

**Why it exists.** `scripts/route-verdict-list.mjs` and
`scripts/route-deletion-impact.mjs` both need to know which routes are dying. When they
each carried their own copy, the impact report read every `route-no-caller` row as a
deletion and announced that `requirePlatformAdmin()` falls with
`POST /api/trades/managers/rebuild` — a route already ruled kept-external-caller — and
that the whole `walk-forward.js` chain falls with the model registry routes that had
been deliberately kept. Both would have deleted live code on the report's word.

**Two rules that go with it:**
- A verdict list must never be TITLED as a list of dead things. The first version was
  called "dead routes"; a reader acting on the heading would have cut Google sign-in's
  eight `/api/auth` routes, including `POST /api/auth/invites`, which is how the
  morning plan invites the Transfer portal league.
- Deletion shape: zero dials and no served string naming it → delete to a 404. Any
  external mention or user-facing string naming it → 410 tombstone with a pointer to
  the replacement, the `retired()` shape at `server/routes/trades.js:155`.

Every line number in a generated verdict list cites the branch and head it came from;
another branch's head has different offsets, so a row that does not match a reader's
tree is used by method plus path fragment, which do not move.

**Correction (2026-09-22):** this was added on branch `claude/wiring-map-8f96ur`, not
`main`. Checked against `main` at `654ff93`, `docs/wiring/route-verdicts.json` does
not exist there. Everything above describes that branch's design, not a live repo
artifact — do not cite the path as present on main until/unless some thread actually
creates or merges it.

Related: [[gridiron-dials-not-mentions]], [[gridiron-failure-modes]].
