# Codex Feedback for Claude

## 2026-08-24 full-platform product audit

Codex completed an in-depth audit of every visible fantasy and betting tab, hidden/legacy routes, shared platform behavior, persistence, data freshness, and release engineering. The implementation brief is `CODEX_SUGGESTIONS.md`.

Claude should read that document before beginning new feature work. The recommended first assignment is the Phase 0 foundation proposal and implementation:

1. Central migrations and a configurable isolated test database.
2. Complete offline draft pool and team DEF representation.
3. A real NFL Auto Picks page instead of routing `/betting/nfl/picks` to the general board.
4. Shared loading/error/empty/freshness components, first applied to Dashboard, My Team, Draft Room, and My Leagues.
5. Duplicate/legacy route cleanup with explicit redirects.

For major schema/navigation/provider work, provide a design note and acceptance criteria before implementation. After each implementation pass, update this file with changed files, migrations, test output, manual verification, and open risks so Codex can independently validate it.

## Codex completed work

Codex applied and verified these narrow release-safety fixes in the main checkout:

- `client/src/pages/DraftRoom.tsx`
  - Pausing a mock draft now stops and clears the user's pick clock.
  - `live_tracking` drafts no longer start a local clock or auto-pick at zero.
  - The auto-pick-at-zero message is shown only for mock drafts.
  - Initial API failures now render an error instead of an endless loading state.
  - Player pick controls are disabled after the configured draft is complete.
- `client/src/pages/Drafts.tsx`
  - Added UI bounds for team count, rounds, and the user's draft slot.
- `server/routes/drafts.js`
  - Added server-side validation for draft type, geometry, slot, clock, and ranking-set existence.
  - Added explicit player existence validation.
  - Rejects manual picks after `team_count * rounds` picks have been made.

Verification completed:

- `npm run build` passed with Vite 6.4.3 (79 modules transformed).
- JavaScript syntax checks passed for the draft routes and server entry point.
- A disposable two-team draft confirmed invalid geometry returns HTTP 400, picks 1 and 2 persist to slots 1 and 2, and pick 3 returns `draft is complete` with HTTP 400.
- The disposable draft was deleted; the database returned to zero drafts and zero picks.
- `git diff --check` passed.

These changes are included in the Codex publication from the main checkout and should be preserved during future integration.

## Larger design work requested

### Guarantee a complete draftable player pool, including K and team DEF

The clean seed currently has 100 ranking entries, zero live `player_metrics`, and no fantasy-relevant K or DEF records. A default 12-team, 16-round draft needs 192 unique players. Both the available-player response and mock CPU pool can therefore exhaust before the draft ends.

This needs a coherent data-model decision rather than a route-only patch:

1. Define how team defenses are represented. The current seed has individual defensive players but no `DEF` team entities.
2. Ensure a fresh/offline installation has at least the maximum supported draft size in its fallback pool without relying on a successful external sync.
3. Make K and DEF available consistently to all consumers: Draft Room board, mock CPU pool, live draft assistant, recommendation output, filters, and recap/roster views.
4. Decide whether `fantasy_relevant` is the canonical eligibility flag and seed/update it consistently.
5. Return a terminal, visible error when a draft pool is exhausted; do not let the client repeatedly call `cpu-pick` without progress.
6. Add a verification case that completes a 12-team x 16-round offline mock with 192 unique picks and the intended K/DEF roster behavior.

## Integration handoff needed

The user referenced new `LiveDraft.tsx`, `server/services/espn-draft.js`, `server/services/draft-assist.js`, and live-draft routes, but those files are not currently present in the main checkout or the registered `session/wary-thrush-6yba` worktree. Please land/save them in a registered worktree and update `CODEX_REVIEW.md` with the claimed K/DEF recommender diff and verification so Codex can perform the independent audit.
