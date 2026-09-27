---
name: gridiron-server-surfaces-with-no-client-reader
description: Two fully built Gridiron HQ server surfaces that no client page fetches — the Decision Inbox and the trend-exploits join — and the grep that reliably proves it, verified 2026-09-20.
metadata:
  type: project
  modified: 2026-09-20T02:25:00.000Z
---

`/api/decision-inbox` is mounted (`server/index.js:129`) over its own table
(`migrations/020_decision_recommendations.js`) with a publish helper, a list
route, an HTTP publish route for external engines, and stale expiry. **Two
engines write to it on every run**: `waiver-brain.js:338` and
`trade-engine.js:2865`. So recommendations are computed, deduped, stored and
expired on the live app continuously.

**Nothing in `client/src` reads any of it.** Grepped the whole client tree for
the route path, `decisionInbox`, `decision_recommend` and inbox item fields —
zero hits. Its only readers are three test files (`decision-inbox.test.js`,
`waiver-kicker-defense.test.js`, `legacy-route-security.test.js`).

## The second one, which makes it a pattern

`GET /trades/:leagueId/trends` (`server/routes/trades.js:254`) serves
`trendExploits()` — 324 lines joining every significant weekly trend onto the
roster, the wire and the schedule, then ranking it. **Zero occurrences of the
literal `/trends` or of "exploit" anywhere in `client/src`.**

Both are **joins**, the expensive kind of surface. If that is a selection effect
it is the worst possible one: the more work a surface does, the less likely
anyone noticed it was never wired up. Assume there are more.

A third case, one level worse — a whole module nothing imports, whose table
feeds the Draft board at double weight: [[gridiron-espn-market-has-no-caller]].

## HOW TO CHECK THIS, because the obvious way undercounts

Listing `api(` / `useApi(` call sites finds only inline string literals, and this
client also builds paths in variables (`PostDraftPlan.tsx:11`). That inventory
shows ~50 client paths and **is an undercount** — a route missing from it is not
yet a finding. The check that holds: **grep the whole `client/src` tree for the
route's own distinctive literal** (`/trends`, `decision-inbox`). A
variable-built path still contains it. No false positives.

For a server module, `git grep -n "<module-basename>" <sha>` over the whole tree,
then state what would disprove it: a computed module specifier, a scheduler
registration by name rather than by import, or a caller on an unmerged branch.

**Why this is worth keeping.** It is the endpoint-level version of the wiring
map's served-field deletion check: a field-granularity check cannot catch it,
because nothing renders the response. Routed to the wiring map 02:20Z/02:45Z.

**What it cost.** The inbox's `confidence` column is written by both engines and
they disagreed about what it means: the trade side writes a FITTED
`headline.p_right` (`trade-engine.js:2874`), the waiver side wrote a hand-set
`0.9` claim-friction factor. "Is this recommendation right" against "will someone
claim him first", under one heading. Fixed on #62 (`f1b827f`) by publishing
`confidence: null` from waivers — safe precisely BECAUSE nothing reads it, and
undetected for the same reason. See
[[gridiron-feature-audit-findings-f1-f4]].

Nav is eight tabs and `/model` was deleted, so building pages for these is
Nick's call and the UI thread's slot — not something to start on this finding
alone.

**Also unlabelled, and on the feature-audit thread's own file:** every `score` in
`trend-exploits.js` is a product of hand-set multipliers with no citation — 0.75
contested (`:104`), 0.6/1.0 favourable and 1.2/0.8 starter (`:222`), 0.9 free
agent (`:239`), 0.5 rival-held avoid (`:264`). That is what orders the list. Same
shape as the waiver `accept_probability` fixed on #62; not taken 2026-09-20
because it would widen an already-checked PR.

`server/routes/decision-inbox.js` and `server/routes/trades.js` have no listed
editor under the one-editor-per-server-file rule; `trend-exploits.js` is the
feature-audit thread's.
