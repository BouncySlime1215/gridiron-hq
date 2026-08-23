# Claude's changes — for Codex review

Made directly in the live app (`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`,
branch `feat/model-honest-rebuild`) because this is the instance actually running on :5177 for
tonight's draft — not the isolated git worktree the session started in.

## Context
User has a live fantasy draft at 4 PM today. Found that this checkout already had substantial
uncommitted, in-progress work on a new "Live Draft Hub" (ESPN live-draft polling + AI pick advice):
`client/src/pages/LiveDraft.tsx`, `server/services/draft-assist.js`, `server/services/espn-draft.js`,
plus wiring in `client/src/App.tsx` and `server/routes/drafts.js`. That work is NOT mine — I only
made the one fix below on top of it. Everything else in that diff is unreviewed/untouched by me.

## Change made

**File:** `server/services/draft-assist.js`, in `boardState()` (~line 173).

**Bug:** The live-draft AI assistant's entire player pool came from `computeConsensus()`
(`server/routes/aggregates.js`), which structurally excludes kickers and defenses (it filters to
`WHERE ffc.value IS NOT NULL OR sl.value IS NOT NULL` — K/DEF have no ADP/market value from any
source). Confirmed via `/api/drafts/18/assist`: `positions.DEF` and `positions.K` always reported
`available: 0` regardless of how many were actually undrafted. Consequence: `rankTargets()` could
never surface a kicker or defense as a recommendation, and the `/advice` Claude prompt (which is
built entirely from this same pool) could never mention one either — even in the last two rounds
when the user actually needs to draft one. The scoring logic at lines 318-319 (`'far too early for
a kicker'` / `'stream a defense at the end'`) was dead code — it already anticipated K/DEF
candidates that could never reach it.

**Fix:** after building `available` from `computeConsensus()`, tail-inject undrafted players with
`position IN ('K','DEF') AND fantasy_relevant = 1` at a late `market_rank`/`board_rank`, joined to
`nfl_teams` for `team_abbr`. Same idiom already used for the mock-draft CPU pool in
`server/routes/drafts.js` (`buildMarketPool`, ~line 37) — this file just didn't have it.

**Verified:**
- `node --check server/services/draft-assist.js` — no syntax errors.
- Live server (`--watch`, picked up the change automatically) — `GET /api/drafts/18/assist` now
  returns `positions.K.available: 47` (was 0). `positions.DEF.available: 0` on that specific draft
  is correct, not a bug — all 32 seeded defenses are `fantasy_relevant=1`
  (`SELECT count(*) FROM players WHERE position='DEF' AND fantasy_relevant=1` → 32), but all 10
  were already drafted in that particular (completed) test draft.
- Server stayed up throughout (`GET /api/teams` → 200 before and after).

## Also checked, found OK (no change needed)
- `draft_advice` table: I initially assumed this was missing from `server/db/index.js` and about to
  add it — don't; it's already self-created via `db.exec(CREATE TABLE IF NOT EXISTS draft_advice...)`
  at the top of `server/services/espn-draft.js` (same self-migrating pattern as the `drafts`/
  `draft_picks` column additions in that same file). Confirmed working live, not a bug.
- `LiveDraft.tsx` has no shot-clock/auto-pick logic at all (it's pure ESPN-polling + display), so it
  does NOT have the old `DraftRoom.tsx` bug where a live-tracking draft's countdown could
  auto-draft a player for the user. Not applicable to this page.
- Forward-looking recommendation logic (per user's ask "make sure the AI understands what's out
  there in other rounds and isn't bs"): already solid — `goneBy()` is a logistic probability model
  on market-rank vs. pick-number gap (not a hard cutoff), `positions[pos].cost_of_waiting` compares
  best-now vs. expected-survivor-at-next-turn projected points, `positionalRuns()` detects run
  behavior in the last 10 picks, and the `/advice` Claude prompt is explicitly instructed to only
  use the supplied dossiers/board and never assert anything not in the data. No changes made here —
  flagging as reviewed-and-looks-legitimate, not verified against real draft outcomes.

## NOT done (ran out of time before 4 PM, worth a look after)
- Two bugs confirmed in the **old** `DraftRoom.tsx` / `server/routes/drafts.js` (mock/manual draft
  path, separate from the new Live Draft Hub): (1) same K/DEF-invisible-in-"Best Available" bug in
  the `GET /:id` route's `available` list (not the `/assist` pool touched above — a different code
  path), (2) the pick-clock ignores Pause and can auto-draft a "recommended" player even in
  `live_tracking` mode. Low priority if tonight's plan is to use the new Live Draft Hub instead of
  the old Draft Room, since `LiveDraft.tsx` doesn't have the clock bug. Equivalent fixes (already
  written and verified in the isolated git worktree at
  `/Users/nick_matta/Documents/GitHub/gridiron-hq-worktree-session-wary-thrush-6yba`) are ready to
  port over if the old Draft Room is still in use.
- `npm run build` was verified clean in the worktree; not re-run here since only one server-side
  `.js` file changed in this checkout (no client build needed, no bundler step touches
  `draft-assist.js`).
