# Claude feedback — Codex platform audit (CODEX_SUGGESTIONS.md)

Session: 2026-09-08. Verified against current code/DB before acting — several audit
findings (dated 2026-08-24) were already stale; noted below where that changed scope.

## Stale findings, verified and not re-fixed

- "No automated test suite / no test script" — false. `npm test` already runs 950+
  tests via `node --test`; `GRIDIRON_DB_PATH` isolation already exists.
- "Default draft pool cannot complete the default draft size; K/DEF unresolved" —
  false. Pool has 32 DEF, 83 K against a 192-pick (12×16) default draft from 977
  fantasy-relevant players.
- "Standardize page states" — the shared components (`client/src/components/PageState.tsx`)
  already existed; only 3/26 pages used them. Treated as "finish the rollout," not
  "build from scratch" (see below).
- "Data health center" — the backend (`source-registry.js`, `/dev/sources`,
  `/dev/refresh-all`) already existed; only surfaced in a hidden dev drawer
  (`DevHub.tsx`). Treated as "give it a real page," not "build the tracking."
- `/edge` route duplicate — only `/model` was actually still duplicated.

## Completed this session

**Route cleanup** (`e212a86`) — `client/src/App.tsx`, new `client/src/pages/NotFound.tsx`.
Removed the dead `/model → /lab` redirect (the sidebar's own "The Model" link
expected `<TheModel/>`, which was already winning by declaration order — the
redirect was unreachable dead code, not a live behavior change). Replaced the
silent `path="*" → Navigate to "/"` with a real 404 page. Tests: typecheck + build.

**NFL Auto Picks page** (`d2b42a9`) — new `client/src/pages/betting/NflAutoPicks.tsx`,
route `/betting/nfl/auto-picks`. `/betting/nfl/picks` rendered the same live
candidate board as everything else; nothing in the client called the existing
`/nfl-market/picks` / `/picks/history` pick-ledger endpoints. New page shows the
model's real graded record (won/lost/push/void/pending) per week, distinct from
"what it would bet right now." No server changes — endpoints already existed.
Tests: typecheck + build.

**Page-state rollout, 20 of 26 pages** (`df0b7d0`, `e84514a`) — DraftHub, Drafts,
LeagueBrain, LeagueHub, Lineup, News, PlayerDetail, Players, Rankings, Teams,
TradeLab, Trends, Edge, FantasyLab, Home, LiveDraft, Model, Projections,
TeamDetail, TheModel. Converted to `PageLoading`/`PageError`/`EmptyState`/`PageData`.
Found and fixed several real silent-failure bugs along the way, not just cosmetic
gaps — the mutation/loading bugs are the actual reliability finding, not the
component swap:
- `LeagueBrain.tsx`: tier-save mutation had `try { } finally { }` with **no catch**
  — a failed save was completely silent.
- `Trends.tsx`: league-sweep action had the same no-catch pattern.
- `Drafts.tsx`: create/delete had no try/catch at all (unhandled rejections).
- `PlayerDetail.tsx`, `TeamDetail.tsx`, `LiveDraft.tsx`'s `Room`: a fetch error
  left `loading` false and `data` null, so the page's `if (loading || !data)`
  guard rendered a permanent "Loading…" spinner forever on real failures.
- `News.tsx`: `addManual()` and the inline delete handler had no catch;
  `analyze()`'s catch reused the success-message state, so a real error
  rendered as an ambiguous "success-looking" amber message.
- `TheModel.tsx`: showed nothing on any of its three API failures.
Skipped: `Pair.tsx`, `Settings.tsx` (POST-action forms, no GET-backed page data
to wrap; already have honest inline error text). `NflMarketBoard.tsx` not
touched (out of scope, largest/most central page — left for a dedicated pass).
Tests: typecheck + build + full suite (958 tests, 0 new failures) after each batch.

**Data Health page** (`5078812`) — new `client/src/pages/DataHealth.tsx`, route
`/data-health` (Lab nav group). Surfaces the existing `/dev/sources` registry
(cadence, cutoff, staleness, failure mode per source) and a "refresh everything"
action against `/dev/refresh-all`, plus Anthropic-key and Odds-API-quota state.
No server changes — this is presentation only; `DevHub.tsx` (the hidden dev
drawer) is untouched and still exists alongside it. Tests: typecheck + build.

**Migration safety net** (`5078812`) — `server/db/migrate.js`, `server/db/index.js`.
The migration system already tracked applied migrations, enforced foreign keys,
and ran a periodic integrity check; it had no pre-migration backup. `runMigrations()`
now takes a `VACUUM INTO` snapshot before applying new migrations, but only when
prior migration history exists (a schema_migrations count > 0) — a brand-new
database, including every test's temp DB, has nothing yet worth the cost of
copying, so this adds zero overhead to the test suite. Verified manually: first
run on an empty DB (no backup), a run with a genuinely new migration on a DB with
prior history (backup fires, ~5-12ms on a small DB), idempotent re-run (no-op).

**Durable ledger for saved prop tickets** (`2f4bf9f`) — new migration
`018_saved_prop_tickets.js`, new `server/routes/props-tickets.js` (mounted at
`/api/props-tickets`), `client/src/pages/props/{lib.ts,usePickSlip.ts,PropsPicks.tsx}`.
Saved MLB prop parlays lived only in `localStorage` — real split-brain on a
single-user app opened from more than one browser (desktop + phone via tunnel):
a ticket saved on one device never appeared on the other. Moved "saved tickets"
(committed parlays) to a server-side table with a one-time client-side migration
of any pre-existing localStorage tickets on first successful load. Left the
transient in-progress "slip" (legs still being assembled) on localStorage —
that part was correctly scoped as a scratch/draft state, not the split-brain bug.
Also updated `test/model-registry-persistence.test.js`'s full migration
rollback/reapply reproducibility test, which hardcoded "017 is latest" in four
places — this new migration is now genuinely the latest, so the chain needed
018 added to both its rollback and reapply sequences (not routed around).
Tests: new `test/props-saved-tickets.test.js` (8 tests) + full suite (958 tests,
957 pass, 1 pre-existing skip, 0 fail) + typecheck + build.

## Explicitly deferred, with reason

**Full schema/migrations centralization** (audit item 5, "Centralize schema and
migrations," P0). Only partially true today: the migration system, `schema_migrations`
tracking, `PRAGMA foreign_keys=ON`, configurable `GRIDIRON_DB_PATH`, and a periodic
integrity check all already existed before this session; this session added the
one missing piece from that specific list (backup-before-migration). What's
still genuinely ad-hoc is ~121 files' worth of `CREATE TABLE IF NOT EXISTS`
statements at import time across `server/services/` and `server/routes/`,
predating the migration system.

I did not delegate ripping those out to background agents this session. Reasoning:
every one of those statements is idempotent and harmless as-is; extracting and
removing them from 121 live files against the user's only copy of ~6.4GB of
personal betting/model history, with server startup ordering that currently
depends on services importing (and thus creating their tables) before
`runMigrations()` runs, is a wide-blast-radius refactor whose main benefit is
code hygiene, not user-facing correctness. This is a judgment call, not a
capability gap — it can be done, in a dedicated pass, one domain at a time, each
gated on `npm run check` and a real backup, if wanted. Flagged to the user
directly rather than either quietly skipping it or quietly doing it.

## Not started

- Decision Inbox (P1, design project) — needs a schema/API design pass first.
- Global command palette (P1).
- Accessibility/responsive nav overhaul beyond the existing mobile drawer
  (density toggle, full ARIA pass, keyboard table navigation).
- Legacy route deprecation plan (`/props/*`, `/betting/mlb/legacy`), MLB
  first-party/proxied overlap consolidation, ESPN Settings vs. My Leagues
  duplication — all P1/P2, none touched.
- Recommendation provenance/replay outside the betting side (fantasy lineup/
  waiver/trade decisions have no equivalent to the betting ledger's evidence
  trail).
- All flagship P2/P3 features (Autopilot, Counterfactual Replay, League
  Intelligence Graph, Narrative-to-Number Engine, Risk Budget, "Explain the
  disagreement," Personal model calibration) — the audit's own protocol says
  not to start these until Phase 0 passes automated integration tests, and the
  schema-centralization item above is still open by choice.

## Rollback

Every change above is a normal commit on `main` (`e212a86` through `2f4bf9f`),
not pushed to `origin`. `git revert <sha>` on any of them is safe and isolated —
none of them altered existing table schemas or existing data, only added new
tables/routes/pages or fixed client-side error handling.
