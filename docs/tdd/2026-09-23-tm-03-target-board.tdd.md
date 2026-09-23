# TM-03 — Target board per league-mate on Trade Brain

Unit TM-03 (plan item B6, Trade Machine). Branch `claude/local-tm-03-target-board`, base origin/main `3ac59fea`.
Not statistical (queue row: AUD no, not PRE): no model number is produced, so no pre-registration. Every
threshold below is hand-set and says so.

## 1. Audit: extend or build (written before the first test)

What already exists for this surface, on `3ac59fea`:

| Need | Existing producer (table + writer, file:line) | Already served where | Decision |
|---|---|---|---|
| Openness, untouchables, loss reaction, night share | `manager_signals` rows `chat_open_to_trade`, `chat_own_untouchable`, `chat_reacting_to_loss`, `chat_night_share` (n = messages), written by `buildManagerSignals` server/services/manager-signals.js:363 via `chatSignals` :149, from league_chat.sqlite `manager_chat_profile` opened by `openChatDb` :111 | `/managers/signals` as a flat signal list (server/routes/trades.js:531) | REUSE the stored rows; shape them per manager |
| Players he is down on / rates | `manager_player_view` (league, roster, player, sentiment 0-4, n), written by `buildManagerSignals` manager-signals.js:429 from league_chat.sqlite `manager_player_sentiment` through the trusted identity join | read by talk-vs-model.js:187, counterparty-pricing.js:1100, bluff-detector.js:289; not on any page per manager | REUSE; join to rosters with `rosterOwnership` talk-vs-model.js:160 |
| Recent loss | `manager_signals` `last_week_margin` (n=1), `standing_streak`, manager-signals.js:243 `standingsSignals` | flat list only | REUSE |
| Observed accept rate | `manager_signals` `tx_accept_rate` (withheld under 5 decided), manager-signals.js:225 `txSignals` | `/managers/signals` receptiveness block | REUSE, same row |
| Active hours from behaviour | `timingRead` server/services/trade-tactics.js:249 (league_transactions_raw, min 10 own actions) | trade tactics only | REUSE, call it |
| Roster hole | none per manager. Canonical week number: `lineupDiff` trade-engine.js:2814 (bestLineup on Start/Sit `week_points`) | League Hub card, Nick's team only | EXTEND: call `lineupDiff` for every roster, compare slot by slot |
| LS-01 lineup signals | not on main (`grep -rn "LS-01\|lineup_signal" server client/src` on 3ac59fea: 0 hits). Planned table `lineup_signal(s)` (league, roster, player, week, signal, evidence, n) per EXECUTION-WIRING.md | none | CONSUME BEHIND FIELD DETECTION: read only when the table and its columns exist, otherwise `table_absent` |

Why the stored copy and not a second chat read: `manager_player_view` and the `chat_*` rows ARE the chat DB's
`manager_player_sentiment` / `manager_chat_profile`, copied by the one writer after the trusted identity join
(manager-identity.js:159). Reading league_chat.sqlite again in the route would be a second producer of the
same numbers and would need its own name-to-roster join, the failure manager-identity.js exists to prevent.
The fixture chat DB in the test still drives the whole path: fixture chat DB -> `buildManagerSignals` ->
stored rows -> `/brain/managers` payload.

Route: extend `GET /api/trades/:leagueId/brain/managers` (server/routes/trades.js:225) with a
`target_board` object on each manager; the ManagerBoard row (client/src/components/brain/ManagerBoard.tsx)
renders it. Nav unchanged (Trade Brain is an existing route, not a new tab).
