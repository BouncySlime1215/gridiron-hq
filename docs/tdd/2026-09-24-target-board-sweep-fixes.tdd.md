# Target board sweep fixes (FIX-190-1, FIX-190-2)

RED `408e1a90` "test: board reads the finder's talk week; no chat probability printed as a message share (RED)" ·
GREEN `aae8844c` "fix: target board reads the trade finder's week; loss-reaction read labelled as avg probability" ·
`test/target-board.test.js`, 2 tests added.

## FIX-190-1: the board and the finder read talk on different weeks

`findTrades` gets its week from `tradeWeekContext()` (`trade-engine.js`,
`const weekNow = tradeWeekContext()`) and passes it to
`counterpartyLayer` → `talkReads`. The board took its week from
`leagueCurrentWeek(lg)` (`target-board.js:152`), which reads the league's stored
`current_week` / payload `currentMatchupPeriod`. When the two differ (a stale
stored week before a sync, or a bye), the board's buy-low list and the trade
card beside it were computed on different weeks.

The board now uses `tradeWeekContext().week`. When BROKEN-D's `league.week`
(#283) merges, it replaces `tradeWeekContext()` in both places together.

Test: league 31 with `current_week = 6` while `NFL_WEEK=2` pins the finder to
week 2. Controls: `leagueCurrentWeek(lg) === 6`, the finder week is 2, and
`talkReads` gives different buy-low/sour verdicts on weeks 2 and 6 (usage rows
for weeks 1-3 make Cold Runner `buy_low` on week 6 only). A source anchor fails
if the finder stops handing `tradeWeekContext()` to `counterpartyLayer`.
Asserts: `meta.week === 2`, and the board's `down_on` equals `talkReads` on week 2.

## FIX-190-2: a 0-1 probability printed as "% of his messages"

`chat_reacting_to_loss` is `manager_chat_profile.p_reacting_to_loss`, a
classifier probability averaged over his messages. `postLossFactor` printed it
as `reacts to losses in N% of his messages`. It now reads
`reacting to a loss: 0.xx avg probability 0-1 over his messages`, the same
wording as `TargetBoard.tsx` `ChatProb`.

Grep test: the p_*-backed chat metrics are read from `manager-signals.js`
`chatSignals` (≥ 9, including `chat_reacting_to_loss`). Every tracked
`.js/.mjs/.ts/.tsx` under `server`, `client/src`, `scripts` is scanned for a
line naming one of those fields next to `* 100` or "% of his/her/their/the messages".
Known-positive control: the replaced line is flagged by the same detector.

## RED (tests at 408e1a90, source at 764bccd9)

```
node --experimental-test-module-mocks --test test/target-board.test.js
not ok 6 - the board reads talk on the trade finder's week ... (actual 6, expected 2)
not ok 7 - no chat probability field is printed as a share of messages
  + 'server/services/counterparty-pricing.js:580: : `reacts to losses in ${(metrics.chat_reacting_to_loss * 100).toFixed(0)}% of his messages`,'
# tests 15  # pass 13  # fail 2
```

Run at the RED commit itself (source unchanged from 764bccd9).

## GREEN (aae8844c)

target-board 15/0. Neighbouring suites unchanged: manager-data-pipeline 27/0,
manager-signals-api 27/0, receptiveness-activity 12/0, trade-acceptance 22/0,
trade-manager-read 20/0, hype-vocabulary 4/0. `npm run lint` clean;
`npm run check:wiring` passes.
