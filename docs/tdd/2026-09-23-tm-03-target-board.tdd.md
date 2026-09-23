# TM-03 — Target board per league-mate on Trade Brain

Unit TM-03 (plan item B6, Trade Machine). Branch `claude/local-tm-03-target-board`, base origin/main `3ac59fea`.
Not statistical (queue row: AUD no, not PRE): no model number is produced, so no pre-registration. Every
threshold below is hand-set and says so.

## 1. Audit: extend or build (written before the first test)

What already exists for this surface, on `3ac59fea`:

| Need | Existing producer (table + writer, file:line) | Already served where | Decision |
|---|---|---|---|
| Openness, untouchables, loss reaction, night share | `manager_signals` rows `chat_open_to_trade`, `chat_own_untouchable`, `chat_reacting_to_loss`, `chat_night_share` (n = messages), written by `buildManagerSignals` server/services/manager-signals.js:363 via `chatSignals` :149, from league_chat.sqlite `manager_chat_profile` opened by `openChatDb` :111 | `/managers/signals` as a flat signal list (server/routes/trades.js:531) | REUSE the stored rows; shape them per manager |
| Players he is down on / rates | `talkReads` server/services/talk-vs-model.js:182 (`readTalk` :77, PRAISE 2.3, SOUR 1.75, 3-mention floor, usage gap from `nfl_ffopportunity_weekly`) over `manager_player_view` (writer `buildManagerSignals` manager-signals.js:429) | the trade finder, counterparty-pricing.js:258 | REUSE the verdicts (round 2; round 1 wrongly re-thresholded the table at 2.0) |
| Recent loss | `manager_signals` `last_week_margin` (n=1), `standing_streak`, manager-signals.js:243 `standingsSignals` | flat list only | REUSE |
| Observed accept rate | `manager_signals` `tx_accept_rate` (withheld under 5 decided), manager-signals.js:225 `txSignals` | `/managers/signals` receptiveness block | REUSE, same row |
| Active hours from behaviour | `timingRead` server/services/trade-tactics.js:249 (league_transactions_raw, min 10 own actions) | trade tactics only | REUSE, call it |
| Roster hole | `analyzeLeague` server/routes/tradelab.js:98 (VOR starter value / league average, need under 0.80), the one needs source of the trade finder (trade-engine.js:155 `rosterContext`, counterparty-pricing.js:456) | the finder's "he is short at X" reason | REUSE its `needs` (round 2; round 1 built a second hole from `lineupDiff` week points and disagreed on 2 rosters) |
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

### Round 2 (skeptic findings, head eb16c357)

- RED `5cd25dcd` test: RED board reads use talkReads + analyzeLeague, THIN boundary, route isolation. Against
  eb16c357's service (tests from 5cd25dcd, service file stashed back to eb16c357): pass 9 fail 4 (tests 4, 5, 6,
  12). Test 13 (route isolation) passes on the old tree because the route was right; its liveness is mutant D.
- GREEN `ceff05f7` fix: target board reads the trade finder's producers; probability wording; DST-correct
  hour. Same command: 13/13 pass. Neighbours on ceff05f7: league-brain 5/5, trade-brain-surface 13/13,
  manager-signals-api 27/27. `npx tsc --noEmit` 0, `node scripts/lint.mjs` 0, `node scripts/wiring-map.mjs --check` 0.
  `server/routes/trades.js` is unchanged in round 2.

## 3. What it does

`GET /api/trades/:leagueId/brain/managers` (server/routes/trades.js, the `/brain/managers` handler) now adds
`target_board` to every manager and `target_board_meta` to the response. The board is built by
`targetBoard(lg)` in server/services/target-board.js (new file, the only new module). ManagerBoard renders it
through client/src/components/brain/TargetBoard.tsx inside each manager row. Per manager:

| Field | Source (reader -> table -> writer) | n | THIN |
|---|---|---|---|
| `roster_hole` | `analyzeLeague` tradelab.js:98: position with the lowest starter ratio; `is_need`, `gap` (VOR points) and `needs` copied from its `needs` list | teams | n<5; `is_need:false` renders "not a need" |
| `down_on` | `talkReads` talk-vs-model.js:182 verdicts `buy_low` / `genuine_sour` on a player `rosterOwnership` (talk-vs-model.js:160) puts on HIS roster; buy_low first | mentions | n<5 |
| `rates_yours` | `talkReads` verdict `wants_him` on a player on Nick's roster | mentions | n<5 |
| `openness`, `untouchable`, `tilt.reacting_to_loss` (avg classifier probability 0-1 per message, extract_league_chat.py:321-324; shown as "avg probability 0-1" with the coach/people/variables.js:354 labels), `active_hours.night_share` (a real share, :313) | `manager_signals` chat_open_to_trade / chat_own_untouchable / chat_reacting_to_loss / chat_night_share (writer `chatSignals` manager-signals.js:149) | his messages | n<5; `no_corpus` when the roster has no trusted chat identity |
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

### Round 2 sweep (tree ceff05f7; scratchpad mut3.sh restores the file after each mutant)

| Mutant | Result |
|---|---|
| A (skeptic) thin `>=` -> `>` (n=5 wrongly thin) | killed: pass 11 fail 2 (tests 4, 6) |
| D (skeptic) route `target_board_meta: board ? board.meta : null` (error swallowed) | killed: pass 12 fail 1 (test 13) |
| E rates_yours takes any verdict, not only `wants_him` | killed: pass 12 fail 1 (test 4, `not_interested` fixture) |
| F hole picks the HIGHEST ratio | killed: pass 12 fail 1 (test 12) |
| G buy_low no longer ranked above genuine_sour | killed: pass 12 fail 1 (test 5) |
| H NOT-APPLIED CONTROL | reported NOT APPLIED |

Round 1 mutants M2, M6, M7 targeted code that no longer exists (neutral 2.0 rule, median-gap hole).

## 5. The numbers (local copy, not production)

Local copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"` at 06:28 ET; worktree server
on :5197 (`SCHEDULER_DISABLED=1`, paid keys blank) at head 5148217f's parent 74e8b373 for the API numbers; counts
from an in-page `fetch('/api/trades/4/brain/managers')` reduced to aggregates only (no names leave the page).

- ROUND 1 (tree 74e8b373; the hole, down_on and rates_yours counts in this bullet are SUPERSEDED by round 2 below). Chat league (league 4, the only one with trusted chat identities: `SELECT league_id, COUNT(*) FROM
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
- ROUND 2, same local copy, tree ceff05f7, direct `targetBoard(lg)` call on league 4 (scratchpad agree.mjs,
  secret columns not selected), week 3 (`leagueCurrentWeek`): 10 rosters. Hole vs `analyzeLeague`: `needs` list
  equal on 10/10; hole = analyzeLeague's top need on 9/9 rosters that have a need. Buy low: 1 player, and
  `talkReads` gives it `genuine_sour` (1/1 agree). Sell high: 0. Control first (scratchpad ctrl.mjs, same DB,
  week 3): `talkReads` on league 4 returns attachment 6, wants_him 7, not_interested 5, genuine_sour 1,
  sales_pitch 4; all 7 wants_him are on OTHER managers' rosters, 0 on Nick's, so 0 sell-high is the canonical
  answer, not an empty read. Round 1's 5 buy-low / 7 sell-high came from the 2.0 rule the finder does not use.
  One `targetBoard` call took 194 ms (one sample, a guess, not a benchmark).
- Busiest hour, round 2: rendered times on the 375px page (Chrome with TZ=America/New_York) are 7 AM, 4 AM,
  10 AM, 9 AM, 12 PM; `busiest_hour_utc` on league 4 is {1, 8, 11, 13, 14, 16}. UTC 11 and 8 now render 7 AM and
  4 AM EDT (`TZ=America/New_York node -e` with `setUTCHours` on 2026-09-23 printed `8 4 AM`, `11 7 AM`). Round 1
  converted on January 1 (EST) and showed 6 AM / 3 AM, one hour early all autumn.
- Known-nonzero before any empty read: league 4 above is the nonzero case. The `no_corpus` path is shown only
  in the fixture (test 5, roster with a `likely` match); it was not checked on a real no-chat league.

Screenshots at 375 px, re-taken on ceff05f7 (round 2), every manager, league and player name blurred before
capture (headless Chrome over CDP, `document.documentElement.scrollWidth - innerWidth` = 0, no horizontal
scroll; 9 boards, 9 with "avg probability 0-1", 0 with "% of his messages read as open"):
docs/tdd/img/tm-03-board-375-1.png, -2.png, -3.png. Checked by eye: no readable name.

## 6. Known defects and limits

- The hole is analyzeLeague's season-projection VOR read, not this week's lineup. A roster whose weakest
  position is still above 0.80 of league average shows the position with "not a need".
- Buy low / sell high inherit readTalk's hand-set thresholds (PRAISE 2.3, SOUR 1.75, 3 mentions); they are
  the finder's rules, not new ones. Before week 3 there are under 2 usage games, so `buy_low` cannot fire and
  sour reads show as `genuine_sour`.
- Busiest hour is `timingRead`'s, shown in the viewer's local time on today's date. On league 4 two managers
  show 4 AM and 7 AM ET (UTC 8 and 11); whether those are his own taps or ESPN-timestamped queued moves was
  not checked (not verified).
- Same misphrase outside this unit: counterparty-pricing.js:448 says "reacts to losses in N% of his messages"
  for the same avg-probability number, and ManagerBoard's measured panel shows raw `chat_open_to_trade` beside
  Receptiveness `open_to_trade_pct` (a league rank). Both are counterparty-pricing / ManagerBoard follow-ups,
  named for the PR.
- Falling playoff odds (named in the queue row's "tilt") is not in this unit: tilt is last result + streak +
  chat loss-reaction only. Follow-up once B-01 odds are per-manager.
- `open_to_trade_pct` in `/managers/signals` is a rank named like a share; renaming it is outside this unit
  (counterparty-pricing.js is not this unit's file). Follow-up.
- LS-01 is read behind detection of its planned shape; if LS-01 ships other column names the board says
  `columns_absent` with the missing names rather than guessing.

## 7. Nick's five questions

1. Well built? One new service that only reads existing producers, one route extension, one component. 13
   tests from a fixture chat DB through the real signal build and a real analyzeLeague fixture; round 2 sweep
   kills 5/5 applied mutants (incl. the skeptics' A and D), H is the not-applied control. Parameterised SQL; the LS-01 table name comes from a fixed list.
2. Stats or made up? Stats already stored (chat shares, sentiment means, accept rate, margins, lineup points).
   The only threshold of its own is THIN under 5 (hand-set, in `target_board_meta.rules`); buy low / sell high
   and needs use the trade finder's existing rules.
3. How we know: nothing is backtested here, because nothing new is predicted. The board shows reads with their
   n; it makes no start/sit, waiver or trade call of its own, so there is no decision win rate to grade.
4. Pointed anywhere else? Yes: `/brain/managers` feeds the Trade Brain page (client/src/pages/TradeBrain.tsx
   `useApi(.../brain/managers)`) -> ManagerBoard -> TargetBoard. TM-04 (pitch) is the next consumer.
5. How it unifies: no second producer. Chat reads come from the one signal build after the trusted identity
   join; buy low / sell high are `talkReads` verdicts and the hole is `analyzeLeague` needs, the same calls the
   trade finder makes (checked equal on league 4: needs 10/10, top need 9/9, buy-low 1/1); accept rate is the
   same row the counterparty layer prices with (checked equal on 9/9 managers).
