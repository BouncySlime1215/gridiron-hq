---
name: trade-brain-never-runs
description: Manager signal generation already covers every league and needs no chat corpus — the gap is that nothing on the server ever triggers it, and no UI reads signals or proposals (found 2026-09-19).
metadata:
  type: project
  modified: 2026-09-19T16:35:44.100Z
---

Audited 2026-09-19 against branch `claude/project-thread-3ldl77-docs`, whose
code matches the Fly deployment.

**Generation was never the gap.** `scripts/build-manager-signals.mjs:38` calls
`refreshManagerData()` with no arguments, which covers every ESPN league
(`server/services/manager-signals.js:442-446`), isolates per-league failures
(`:462-474`), writes league-scoped inside one transaction (`:396-411`) and is
idempotent (`:393-395`). It does **not** need the chat corpus: a chat-free
league still gets ~11 roster and standings signals per roster, which is the
designed path for 4 of the 5 leagues.

**The gap is operational: nothing in the running app ever invokes it.** No
route, no scheduler job, no npm script. Its only automated caller is
`scripts/refresh-live-data.mjs:198-227`, a loop launched by hand on Nick's Mac.
So on Fly, signals never get built. `scripts/build-manager-archetypes.mjs` is
in no allowlist at all, so `manager_archetypes` stays empty and the draft and
outcome signal sources silently never appear.

**Nothing renders any of it.** `GET /api/trades/:leagueId/proposals` is mounted
(`server/index.js:103`, route `trades.js:575-600`) and has zero client callers.
Manager signals and archetypes have **no HTTP route at all**; they reach the
client only embedded as `deal.counterparty`, `deal.tactics`, `deal.acceptance`
and `deal.edge` on `/find` responses, and a grep of `client/src` for those
fields returns one prose string. The UI shows only a
`manager_tradeability === 'hard'` badge (`client/src/components/TradeCard.tsx:231`).
Three fields of `deal.counterparty` are `Map`/`Set` with no serializer, so they
cross the wire as `{}`.
`GET/POST /api/trades/:leagueId/brain/managers` (`trades.js:343-358`) is live
but serves only the hand-entered tier table, not the measured signals.

**Deployment freshness has no direct signal.** No `/version` route, no
`GIT_SHA` in `server/`, `Dockerfile` or `fly.toml`. The clean discriminator is
that a 404 on `/api/trades/:id/brain/managers` means the deployed build
predates that code. A 410 is NOT age evidence — `trades.js:130` retires
`/brain/plan` and `/brain/sell-high` on purpose.

See [[trade-brain-live-gaps]] and [[fly-deployment-outside-repo]].

**The corpus attaches to nothing until someone says who is who (found
2026-09-19).** `refreshManagerData` decides which league owns the chat corpus
by reading `SELECT DISTINCT league_id FROM league_member_identity WHERE
confidence = 'confirmed' AND chat_name IS NOT NULL`. Those rows are written
only by `matchIdentities`, which runs only inside `refreshManagerData` — which
has never run on Fly. So a successful chat upload would have reported success
and changed nothing: every league reads as chat-free and no message reaches the
trade finder. A name match cannot bootstrap it either, since a chat name often
looks nothing like the ESPN name. Fixed on
`claude/project-thread-3xqh5l-signals-api` (PR #26, commit 49cc958): the
rebuild route takes `confirmations`, a roster id to the name that person posts
under, said once — `POST /api/trades/managers/rebuild` with
`{"league_ids":[3],"confirmations":{"3":{"<roster_id>":"<chat name>"}}}`.
