# Execution status snapshot — 2026-09-15

Where the betting-model work stands, pushed to GitHub on branch
`cursor/betting-model-audit-fixes-1c85` (PR #6).

## Done and pushed
- Live-code audit + §0.1 reconciliation to `main`: `docs/evidence/2026-09-15/BETTING-MODEL-AUDIT-AND-PROFIT-PLAN.md`.
- Unified plan (M0-M5 / WP01-20 mapped to live status): `docs/evidence/2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md`.
- Master implementation plan (papers/methods integrated, FIX/ADD per WP, R01-R28 gates): `docs/evidence/2026-09-15/BETTING-MODEL-MASTER-PLAN.md`.
- Research corpus shipped in-repo: `docs/betting-model/` (481 files).
- Ready-to-paste Linear import (Epic + M0-M5 + WP01-20 w/ acceptance): `docs/evidence/2026-09-15/LINEAR-IMPORT.md`.
- Repo-managed Cloud env: `.cursor/environment.json` (npm ci && npm run build; server terminal on 5177; scheduler off by default). Validated: install/build/typecheck/lint all pass here.
- Per-phase model assignment (fable Tier A / sonnet Tier B / grok Tier C) recorded in the plan.

## Phase 0 test triage (interim)
Full `npm test` re-run against current `main` in a clean isolated temp DB.
**19 failures observed** (run was still finishing/slow on a heavy file at snapshot
time). All cluster in **data-/environment-dependent** areas on a clean DB, not logic
touched by this branch (this branch changed no product code):
- news/claim extraction (superseded/ambiguous claims, evidence span, content-hash cache, coverage summary, press-conference),
- AI `POST /explain/page` explanation tests,
- C05 shopping/distribution ("the residual population is the one this database actually contains", "with no qualified distribution available, it refuses rather than ranking").
Consistent with the prior run (~21) and with the developer's populated-DB run showing
0 failures. **Final per-test classification (data-dependent skip vs real) is pending a
clean completion** and is the first thing to finish before WP code lands.

## Designed, not yet started (gated on Phase 0)
- WP15/D3 full frozen packet: `freezeT60Packet` in `server/services/nfl-t60-packet.js`
  persists quote/injury/news rows but NOT `game_context`/`team_features`/`total_market`
  (`PACKET_BOARD_INPUT_COVERAGE`). Plan: add those to the packet schema and have
  `autoPickDecisionBoardForPacket` (`server/services/nfl-auto-picks.js`) consume them via
  an override like the existing `marketOverride`; regression test = freeze, mutate live
  tables, re-score, assert identical.

## Immediate front (order)
WP15/D3 -> WP08 news signal versioning -> WP14 save-every-prediction + error ledger ->
FIX#28 one CLV module + FIX#14 ridge team strength -> WP12-13 walk-forward + conformal ->
unity (family adapters -> gated comparison + tree_lab -> Node bridge). Each behind the
gates, registered as a trial, no staking authority.

## Time / effort read
- Engineering, full 20-WP scope: the corpus's own estimate is ~41-78 engineer-days of
  focused work (`docs/betting-model/plans/archive/MASTER-PLAN-2026-09-14.md`). These are
  engineer-days, not calendar time, and parallelize across the model-tier assignments.
- First complete frozen-shadow spread path (the immediate front above): the ~15-30
  engineer-day slice within that.
- **Profit/qualification is NOT bounded by engineering.** Promotion needs ~250 settled
  forward decisions with positive CLV (currently 0). Those accrue only as the 2026 season
  is actually played (one week settles at a time), so the binding clock is the season,
  not development. Realistically most/all of a season before any promotion is even askable.
- Honest expected outcome remains: a trustworthy, reproducible, unified pipeline that
  most likely shows **no robust spread edge** - proven forward, not asserted.
