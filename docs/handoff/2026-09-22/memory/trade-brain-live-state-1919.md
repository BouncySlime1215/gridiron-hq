---
name: trade-brain-live-state-1919
description: What the live app actually reported on 2026-09-19 19:25Z — five leagues, manager_profiles empty in all of them, the signals route 404, and the Anthropic key configured after all.
metadata:
  type: project
  modified: 2026-09-19T19:26:15.933Z
---

Measured against gridiron-hq.fly.dev at 19:25Z on 2026-09-19 with
`scripts/verify-trade-brain-live.mjs`, authenticated with GRIDIRON_FLY_TOKEN.
The app answered in 2.9s that time; see [[fly-app-stalls-in-bursts]] for why
most attempts get nothing.

**Five leagues, all season 2026 week 2:** 1 Matta - Kodsi Annual, 2 DMV League
23-24, 3 "Transfer portal " (note the trailing space), 4 My 2025 League,
5 My 2026 League. So Transfer portal, the one Nick cares about most, is
**league id 3**, not 4. Careful: `manager-signals.js:24` and several code
comments say the chat corpus league is "league 4", which is `My 2025 League`.
Check which is meant before wiring anything to a hard-coded id.

**`manager_profiles` is empty in every league.** `GET /api/trades/:id/brain/managers`
returns 200 for all five, with 0 of 8, 0 of 10, 0 of 10, 0 of 8 and 0 of 10
rosters carrying a hand-set tier. Nothing has ever been set.

**`GET /api/trades/:id/managers/signals` 404s on every league**, because that
route exists only in PR #26 and in no deployed code. It is NOT evidence that
the deployment is old — that inference was made here and then withdrawn. The
deployed build is recent: `GET /api/trades/3/brain/plan` returns **410** with
the "retired on 2026-09-18" body, and `brain/managers` returns 200 on all five
leagues, so the live box is running code in the `1694694..d9b4a90` range, i.e.
the same base branch these PRs are stacked on. The gap is only the five PRs,
and it is mostly a UI gap: the live bundle `/assets/index-D3Xib5Rt.js` has zero
occurrences of manager, archetype, signal or proposal.

**No trade proposal has ever been requested on the live app.** `/api/dev/usage`
on 2026-09-19 shows 39 calls, all `claude-haiku-4-5-20251001`, across
team-analysis, nfl-news-typed-extraction and news-analyze. There is no
`trade_proposals` row and the $0.50 budget is unspent. So the discard bug in
[[trade-brain-live-gaps]] has never actually cost money — nothing calls that
route, because no page does. It would start costing the moment a UI ships
against unfixed code.

**The Anthropic key IS configured** — `/api/dev/status` reports
`api_key.configured: true`, masked `sk-ant-[redacted]`. This corrects the older
note in [[gridiron-live-data-state]] that said it was unset. Two consequences:
the proposals path will make real paid calls the moment it is deployed, and
until PR #25 lands each of those calls pays for an answer the code discards
(see [[trade-brain-live-gaps]]).

**GRIDIRON_FLY_TOKEN has the `model:*` admin grant** — `/api/dev/status`
returned 200 rather than 403 — so it can drive
`POST /api/trades/managers/rebuild` once that ships. It is NOT a Fly API
token: `flyctl` rejects it with "unauthorized", so machine restarts and
secret changes are Nick's to do, not this session's.
