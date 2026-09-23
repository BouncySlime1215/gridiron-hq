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

## 2. RED / GREEN

- RED: `test: RED target board per league-mate on /brain/managers (TM-03)` — `c39b21c2`. 10 of 11 tests fail
  against a stub `targetBoard()` that returns no boards. First failing assertion, test 1:
  `assert.ok(m.target_board && typeof m.target_board === 'object', \`roster ${m.roster_id} has a target_board\`)`
  -> `error: 'roster 1 has a target_board'`; tests 2-8, 10, 11 fail with
  `Cannot read properties of undefined (reading 'openness' | 'tilt' | 'down_on' | ... | 'roster_hole')`.
  Test 9 (privacy guard) passes on the stub by construction; its liveness is mutant M10 below.
- GREEN: `feat: target board per league-mate on Trade Brain (TM-03)` — `74e8b373`. 11/11 pass.
- Follow-up: `fix: target board spacing, two-decimal sentiment, no-hole wording (TM-03)` — `5148217f` (UI only,
  from the screenshot pass).

Command (each run on its own tree, fresh temp DB):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/target-board.test.js`
-> RED tree c39b21c2: pass 1 fail 10; GREEN 74e8b373 and head 5148217f: pass 11 fail 0.
Neighbours on 74e8b373, same command: test/league-brain.test.js 5/5, test/trade-brain-surface.test.js 13/13,
test/manager-signals-api.test.js 27/27. `npx tsc --noEmit` exit 0; `node scripts/lint.mjs` exit 0;
`node scripts/wiring-map.mjs --check` exit 0 (74e8b373 working tree). The full `npm run check` is left to the Gate phase.

## 3. What it does

`GET /api/trades/:leagueId/brain/managers` (server/routes/trades.js, the `/brain/managers` handler) now adds
`target_board` to every manager and `target_board_meta` to the response. The board is built by
`targetBoard(lg)` in server/services/target-board.js (new file, the only new module). ManagerBoard renders it
through client/src/components/brain/TargetBoard.tsx inside each manager row. Per manager:

| Field | Source (reader -> table -> writer) | n | THIN |
|---|---|---|---|
| `roster_hole` | `lineupDiff` trade-engine.js:2814 per roster; slot with the lowest (starter week_points - league median starter at that slot) | teams priced | n<5; `below_median:false` renders "no real hole" |
| `down_on` | `manager_player_view` (writer manager-signals.js:429) where sentiment < 2 and `rosterOwnership` (talk-vs-model.js:160) says the player is on HIS roster | mentions | n<5 |
| `rates_yours` | same table, sentiment > 2 and the player is on Nick's roster | mentions | n<5 |
| `openness`, `untouchable`, `tilt.reacting_to_loss`, `active_hours.night_share` | `manager_signals` chat_open_to_trade / chat_own_untouchable / chat_reacting_to_loss / chat_night_share (writer `chatSignals` manager-signals.js:149) | his messages | n<5; `no_corpus` when the roster has no trusted chat identity |
| `tilt.last_week_margin`, `just_lost`, `streak` | `manager_signals` last_week_margin / standing_streak (`standingsSignals` manager-signals.js:243) | 1 game (a fact, not labelled thin) | `just_lost: null` when no game is decided |
| `active_hours.busiest_hour_utc` | `timingRead` trade-tactics.js:249 over league_transactions_raw | his own moves | under its own 10-move bar |
| `accept_rate` | `manager_signals` tx_accept_rate (`txSignals` manager-signals.js:225) | decided offers | `withheld_under_5` with n when under 5 decided |
| `lineup_signals` | LS-01 `lineup_signals` (or `lineup_signal`) only when the table has league_id, roster_id, player(_name), signal, n; `evidence` text never selected | per row | n<5 |

No new table, column or migration. A board that throws is reported in `target_board_meta.error` (and logged)
while the hand-set tiers still serve.

## 4. Mutation sweep (tree 74e8b373; script restores the file after each mutant)

| Mutant | Result |
|---|---|
| M1 thin bar 5 -> 2 | killed (tests 4, 8) |
| M2 DESIGNED SURVIVOR: down_on `<` neutral -> `<=` | survived: the fixture has no exactly-neutral player on his own roster (Flat Guy is Nick's) |
| M3 down_on drops the his-roster check | killed (test 4: Stranger appears) |
| M4 rates_yours owner Nick -> him | killed (test 4) |
| M5 corpus gate ignored | killed (test 5) |
| M6 hole picks the largest gap | killed (test 10) |
| M7 median -> mean | killed (test 10) |
| M8 CALL SITE, route: every manager gets Nick's board (`get(String(out.my_roster_id))`) | killed (tests 2-8) |
| M9 withheld branch bar > 0 -> > 5 | killed (test 6) |
| M10 board serves the chat-side name | killed (test 9) |
| M11 LS-01 detection off | killed (test 8) |
| M12 NOT-APPLIED CONTROL: pattern absent from the file | reported NOT APPLIED (count 0), not "survived" |

## 5. The numbers (local copy, not production)

Local copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"` at 06:28 ET; worktree server
on :5197 (`SCHEDULER_DISABLED=1`, paid keys blank) at head 5148217f's parent 74e8b373 for the API numbers; counts
from an in-page `fetch('/api/trades/4/brain/managers')` reduced to aggregates only (no names leave the page).

- Chat league (league 4, the only one with trusted chat identities: `SELECT league_id, COUNT(*) FROM
  league_member_identity WHERE confidence IN (...) GROUP BY 1` -> 4|10): 10 managers, 10 boards; 9 other
  managers; roster hole priced for 9/9 (n=10 teams each), 8 of 9 below the league median; chat corpus 9/9;
  down_on 5 players total (3 thin); rates_yours 7 (6 thin); openness measured 9/9; just_lost 4, unknown 0;
  accept rate measured 3, withheld 4 (rest not measured); busiest hour known 5; lineup_signals `table_absent`
  (LS-01 not on main). One call took 1406 ms after the page's own first call had warmed the asset cache (one
  sample, a guess at typical latency, not a benchmark).
- One number, one producer, checked on the same input: `accept_rate` equals `/managers/signals`
  receptiveness `accept_rate` for all 9 managers (same row). `openness` (0.325 for one roster) and
  receptiveness `open_to_trade_pct` (1.00 for the same roster) come from the same `chat_open_to_trade` row but
  are different concepts: the second is the league percentile rank (counterparty-pricing.js:315
  `percentile(openVals, ...)`), despite the `_pct` name. No disagreement in the underlying number; the name is a
  follow-up (see known defects).
- No-corpus control: league 1 renders the tiers and boards with chat reads `no_corpus` (screenshot pass, first
  load) — the known-empty case; league 4 is the known-nonzero case.

Screenshots at 375 px, every manager, league and player name blurred before capture (headless Chrome over CDP,
`document.documentElement.scrollWidth - innerWidth` = 0, no horizontal scroll):
docs/tdd/img/tm-03-board-375-1.png, -2.png, -3.png.

## 6. Known defects and limits

- The hole is a hand-set rule (furthest below the league median starter at that slot). It is not graded against
  any trade outcome; it is a description, not a recommendation, and nothing prices on it.
- "Down on"/"rates yours" use a strict neutral of 2.0 on the 0-4 chat score with no margin; a 1.96 mean counts
  as down on (shown to two decimals so the reader sees it). M2 is the standing survivor for the boundary.
- Busiest hour is `timingRead`'s, shown in the viewer's local time. On league 4 two managers show 3 AM and 6 AM;
  whether those are his own taps or ESPN-timestamped queued moves was not checked (not verified).
- Falling playoff odds (named in the queue row's "tilt") is not in this unit: tilt is last result + streak +
  chat loss-reaction only. Follow-up once B-01 odds are per-manager.
- `open_to_trade_pct` in `/managers/signals` is a rank named like a share; renaming it is outside this unit
  (counterparty-pricing.js is not this unit's file). Follow-up.
- LS-01 is read behind detection of its planned shape; if LS-01 ships other column names the board says
  `columns_absent` with the missing names rather than guessing.

## 7. Nick's five questions

1. Well built? One new service that only reads existing producers, one route extension, one component. 11
   payload tests from a fixture chat DB through the real signal build; 10 of 11 mutants die, M2 is the designed
   survivor, M12 the not-applied control. Parameterised SQL; the LS-01 table name comes from a fixed list.
2. Stats or made up? Stats already stored (chat shares, sentiment means, accept rate, margins, lineup points).
   The thresholds (THIN under 5, neutral 2.0, median-gap hole) are hand-set and labelled as such in the payload
   (`target_board_meta.rules`).
3. How we know: nothing is backtested here, because nothing new is predicted. The board shows reads with their
   n; it makes no start/sit, waiver or trade call of its own, so there is no decision win rate to grade.
4. Pointed anywhere else? Yes: `/brain/managers` feeds the Trade Brain page (client/src/pages/TradeBrain.tsx
   `useApi(.../brain/managers)`) -> ManagerBoard -> TargetBoard. TM-04 (pitch) is the next consumer.
5. How it unifies: no second producer. Chat reads come from the one signal build after the trusted identity
   join; the hole comes from `lineupDiff`, the same week number Start/Sit and League Hub use; accept rate is the
   same row the counterparty layer prices with (checked equal on 9/9 managers).
