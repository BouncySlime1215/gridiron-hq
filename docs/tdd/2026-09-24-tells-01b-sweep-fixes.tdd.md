# TELLS-01b sweep fixes (FIXPR-268): members-only stored card, producer 'tells', snapshot-first terms, prior_trades

Branch `claude/cloud-tells-01b` (PR #268). ENGINE-00a's spine (#216, `pr/216` head `4eb6caa4`) is merged in
(`9228b7a2`) so the producer has its registry, state writer and event log. #266 is NOT merged: its own head
reports 11 `check:wiring` findings, so stacking on it cannot exit 0. Its offer_log removal is ported instead.
RED `aba732ab` · GREEN and test-hardening shas are in the PR comment.

| fix | what changed |
|---|---|
| FIX-268-1 | `eval/e1-league.js` stops reading `offer_log` (and its idea_id dedup), as #266 does. The two wiring findings actually came from `eval/e2.js` (`SELECT … proposed_at FROM offer_log`), so E2's loader now reads nothing and says why (`NO_SOURCE_REASON`) until #239 `sent_at` and #266 `price_band` merge. `check:wiring` exits 0 |
| FIX-268-2 | `GET /api/tells/:leagueId/card` calls `assertLeagueMember(req.auth?.userId, leagueId)`. A non-member gets 403 |
| FIX-268-3 | The route and `tells/card.js` only read the stored `tells.card` row (`getState`, optional `?as_of=`) and return its as_of. The fit and E1 grade run in `tells/producer.js`, called by `scripts/engine-tells.mjs` (role engine), which the refresh loop spawns as step `tells` |
| FIX-268-4 | `e1-league.js#offersFromRaw` and `clone-features.js#loadCloneContext` read terms from `trade_proposal_snapshots` first and from raw `items_json` only when no snapshot exists. Each offer carries `terms_source`, and the card and grade carry `terms_sources` counts. A proposal the raw table lost but a snapshot kept is an offer again |
| FIX-268-5 | Spine adapters `tells_transactions` → `league.transaction` and `tells_team_weeks` → `league.team_week` (backfill.js). `saveTeams` hands `league.team_counter` events (ESPN `transactionCounter`) to an emitter its caller supplies. Producer `tells` writes `tells.card`, `tells.prior_trades` and `tells.checkout_risk`. The `prior_trades` factor in counterparty-pricing.js is default-off (`GRIDIRON_TELLS_PRIOR_TRADES`, preview-mode aware) |

## RED → GREEN

RED `aba732ab` run on its own tree: 9 failures across the 6 touched test files. The first failure, quoted:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/services/tells/producer.js' imported from …/test/tells-producer.test.js`.
The other failures: the snapshot-first tests, the stored-card flag test, the refresh-loop order, and the E1/E2 offer_log tests.
GREEN: every one of them passes. Full suite: 4927 tests, 4885 pass, 0 fail, 42 skipped.

## Liveness: mutation sweep

| mutant | result |
|---|---|
| M1 route without `assertLeagueMember` | killed (route 403) |
| M2 `zero:['prior_trades']` ignored | killed (RED 3b) |
| M3 clone-features ignores snapshots | killed (FIX-268-4 clone) |
| M4 raw terms first whenever raw still has items | survived the first test; test hardened (140: both present, snapshot wins); killed |
| M5 producer grades offers proposed or answered after the card's as_of | survived; the fix cut on proposal time only, so the cut now uses answer time and a test pins it; killed |
| M5b cut on proposal time only | killed |
| M6 prior_trades applied by default | killed (RED 3a, flag test) |
| M7 a tell missing from the screen served as `confirmed` | killed (RED 2) |

## Benchmarks (synthetic, scratch script; 400 offers in 2 leagues, 12 teams, 6 weeks of pickups; three runs)

- Producer run for one league, as of hour 500 (about 200 offers answered by then): 0.35-0.38 s.
- Route read of the stored card: median 0.35-0.37 ms, p95 0.48-0.55 ms. Card size 39 KB.
- Before this fix the route recomputed the fit and grade on every request: about 0.4 s at 400 offers (PR body, `4f72e10d`).
