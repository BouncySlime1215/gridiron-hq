/**
 * Every key the War Room's two consumers read from the plans file, written in
 * plans-schema.js's path notation (`.key`, `[]` list item, `{}` map entry, a
 * typed field's value under `.value`).
 *
 * Pinned to the heads read for this contract:
 *   #231 claude/cloud-war-room-ui    cce5005  server/services/war-room-view.js, moved to the
 *        contract by FIX-04 (claude/cloud-fix-04): the view passes the entry through and
 *        client/src/components/warroom/*.tsx do the deep reads
 *   #230 claude/cloud-war-room-coach 6ac4758  client/src/components/warroom/coach/warroomCoach.ts,
 *                                             CoachDock.tsx, server/services/warroom-actions/schema.js
 *        (#230's reads moved to the contract by FIX-06; none carries a `fix` any more)
 *   #234 REASON-01 after FIX-08              server/services/reasoning/cards.js (reads the contract; no fixes)
 *
 * An entry with `fix` is a read no producer writes today. `fix.to` is the
 * contract path it should read instead (the test proves `to` exists) and
 * `fix.line` is the one-line change for that PR. When a PR takes the fix,
 * move its entry to the new path and delete `fix`; the test fails on a `fix`
 * whose read has started to resolve, so a stale entry cannot linger.
 *
 * Coach's reads go through its unwrap(), which steps into a typed field's
 * `.value`; the paths below include that step. `scalar: true` marks a read
 * that uses the value directly (prints it, compares it): the contract must
 * write a plain value there, not a typed field.
 */

const UI = 'server/services/war-room-view.js';
const WRC = 'client/src/components/warroom';
const DECK = `${WRC}/NextMoveDeck.tsx`;
const REPLY = `${WRC}/ReplyTable.tsx`;
const TOP = `${WRC}/TopStrip.tsx`;
const WR = `${WRC}/WarRoom.tsx`;
const ITIN = `${WRC}/Itinerary.tsx`;
const TGT = `${WRC}/TargetPicker.tsx`;
const FLIP = `${WRC}/FlipMap.tsx`;
const BRAIN = `${WRC}/BrainCheckCard.tsx`;
const CO = 'client/src/components/warroom/coach/warroomCoach.ts';
const DOCK = 'client/src/components/warroom/coach/CoachDock.tsx';
/** FIX-230-1: the dock's trade-off preview moved here so the WR-3 sheets draw the same one. */
const PREV = `${WRC}/TradeoffPreview.tsx`;
const ACT = 'server/services/warroom-actions/schema.js';
const RS = 'server/services/reasoning/cards.js';

export const READS = [
  /* ---------------------------------------------------------------- #231 UI */
  // FIX-04: the view serves the league entry as written, so the deep reads sit in the
  // components that render them. Every #231 `fix` is resolved; none is left.
  { pr: 231, where: `${UI}:111`, reads: 'leagues' },
  { pr: 231, where: `${UI}:116`, reads: 'generated_at', scalar: true },
  { pr: 231, where: `${UI}:182`, reads: 'leagues[].league', scalar: true },
  { pr: 231, where: `${UI}:58`, reads: 'leagues[].me', scalar: true },
  { pr: 231, where: `${UI}:58`, reads: 'leagues[].names' },
  { pr: 231, where: `${UI}:196`, reads: 'leagues[].error', scalar: true },
  { pr: 231, where: `${UI}:200`, reads: 'leagues[].sanity_composed_equals_direct', scalar: true },
  { pr: 231, where: `${DECK}:25`, reads: 'leagues[].alternatives.value' },
  { pr: 231, where: `${DECK}:119`, reads: 'leagues[].next_move.reason', scalar: true },
  { pr: 231, where: `${DECK}:71`, reads: 'leagues[].alternatives.value[].move_id', scalar: true },
  { pr: 231, where: `${DECK}:187`, reads: 'leagues[].alternatives.value[].rank', scalar: true },
  { pr: 231, where: `${DECK}:180`, reads: 'leagues[].alternatives.value[].target', scalar: true },
  { pr: 231, where: `${DECK}:197`, reads: 'leagues[].alternatives.value[].target_owner', scalar: true },
  { pr: 231, where: `${DECK}:139`, reads: 'leagues[].alternatives.value[].steps[].partner', scalar: true },
  { pr: 231, where: `${DECK}:140`, reads: 'leagues[].alternatives.value[].steps[].give' },
  { pr: 231, where: `${DECK}:140`, reads: 'leagues[].alternatives.value[].steps[].get' },
  { pr: 231, where: `${DECK}:167`, reads: 'leagues[].alternatives.value[].steps[].p_yes' },
  { pr: 231, where: `${DECK}:207`, reads: 'leagues[].alternatives.value[].steps[].title_odds_delta' },
  { pr: 231, where: `${DECK}:210`, reads: 'leagues[].alternatives.value[].steps[].title_after' },
  { pr: 231, where: `${DECK}:181`, reads: 'leagues[].alternatives.value[].steps[].message' },
  { pr: 231, where: `${DECK}:216`, reads: 'leagues[].alternatives.value[].steps[].walk_away.value.text', scalar: true },
  { pr: 231, where: `${DECK}:189`, reads: 'leagues[].alternatives.value[].steps[].send_when' },
  { pr: 231, where: `${DECK}:247`, reads: 'leagues[].alternatives.value[].steps[].reply_table' },
  { pr: 231, where: `${REPLY}:6`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.decline' },
  { pr: 231, where: `${DECK}:221`, reads: 'leagues[].alternatives.value[].p_complete' },
  { pr: 231, where: `${DECK}:220`, reads: 'leagues[].alternatives.value[].expected' },
  { pr: 231, where: `${DECK}:252`, reads: 'leagues[].alternatives.value[].reasoning.value' },
  { pr: 231, where: `${DECK}:222`, reads: 'leagues[].finder_best_expected' },
  { pr: 231, where: `${DECK}:179`, reads: 'leagues[].destination.value.title_now' },
  { pr: 231, where: `${TOP}:20`, reads: 'leagues[].attention.value' },
  { pr: 231, where: `${TOP}:40`, reads: 'leagues[].destination.value.goal' },
  { pr: 231, where: `${TOP}:42`, reads: 'leagues[].destination.value.eta_week' },
  { pr: 231, where: `${TOP}:42`, reads: 'leagues[].destination.value.arrive_by' },
  { pr: 231, where: `${TOP}:22`, reads: 'leagues[].destination.value.risk_mode' },
  { pr: 231, where: `${TOP}:46`, reads: 'leagues[].destination.value.title_planned_now' },
  { pr: 231, where: `${TOP}:47`, reads: 'leagues[].destination.value.ground_lost' },
  { pr: 231, where: `${WR}:128`, reads: 'leagues[].itinerary.value' },
  { pr: 231, where: `${ITIN}:19`, reads: 'leagues[].itinerary.value.stops' },
  { pr: 231, where: `${ITIN}:15`, reads: 'leagues[].itinerary.value.stops_left', scalar: true },
  { pr: 231, where: `${WR}:134`, reads: 'leagues[].targets.value' },
  { pr: 231, where: `${TGT}:44`, reads: 'leagues[].targets.value[].player', scalar: true },
  { pr: 231, where: `${TGT}:47`, reads: 'leagues[].targets.value[].owner', scalar: true },
  { pr: 231, where: `${TGT}:45`, reads: 'leagues[].targets.value[].gain_if_landed' },
  { pr: 231, where: `${TGT}:46`, reads: 'leagues[].targets.value[].p_reach' },
  { pr: 231, where: `${TGT}:48`, reads: 'leagues[].targets.value[].mode_fit' },
  { pr: 231, where: `${TGT}:43`, reads: 'leagues[].targets.value[].why' },
  { pr: 231, where: `${TGT}:50`, reads: 'leagues[].targets.value[].approved', scalar: true },
  { pr: 231, where: `${TGT}:49`, reads: 'leagues[].targets.value[].is_plan_target', scalar: true },
  { pr: 231, where: `${WR}:131`, reads: 'leagues[].flip_map.value' },
  { pr: 231, where: `${FLIP}:27`, reads: 'leagues[].flip_map.value[].player', scalar: true },
  { pr: 231, where: `${FLIP}:28`, reads: 'leagues[].flip_map.value[].buy_from', scalar: true },
  { pr: 231, where: `${FLIP}:28`, reads: 'leagues[].flip_map.value[].sell_to', scalar: true },
  { pr: 231, where: `${FLIP}:29`, reads: 'leagues[].flip_map.value[].spread' },
  { pr: 231, where: `${FLIP}:30`, reads: 'leagues[].flip_map.value[].price_a' },
  { pr: 231, where: `${FLIP}:31`, reads: 'leagues[].flip_map.value[].legs.p_both' },
  { pr: 231, where: `${FLIP}:31`, reads: 'leagues[].flip_map.value[].legs.nick_after' },
  { pr: 231, where: `${WR}:137`, reads: 'leagues[].catch_up.value' },
  { pr: 231, where: `${WR}:137`, reads: 'leagues[].speed_curve.value' },
  { pr: 231, where: `${WR}:141`, reads: 'leagues[].brain_report.value' },
  { pr: 231, where: `${BRAIN}:24`, reads: 'leagues[].brain_report.value.checks' },
  { pr: 231, where: `${BRAIN}:42`, reads: 'leagues[].brain_report.value.blocks' },
  { pr: 231, where: `${TOP}:56`, reads: 'leagues[].brain_report.value.overall', scalar: true },

  /* ------------------------------------------------------------ #230 Coach */
  { pr: 230, where: `${CO}:246`, reads: 'leagues[].stop_tradeoffs.value' },
  { pr: 230, where: `${CO}:247`, reads: 'leagues[].stop_tradeoffs.value{}' },
  { pr: 230, where: `${PREV}:23`, reads: 'leagues[].stop_tradeoffs.value{}.stop_label', scalar: true },
  { pr: 230, where: `${PREV}:24`, reads: 'leagues[].stop_tradeoffs.value{}.cost.value' },
  { pr: 230, where: `${PREV}:24`, reads: 'leagues[].stop_tradeoffs.value{}.extra_steps', scalar: true },
  { pr: 230, where: `${PREV}:25`, reads: 'leagues[].stop_tradeoffs.value{}.gain.value' },
  { pr: 230, where: `${PREV}:25`, reads: 'leagues[].stop_tradeoffs.value{}.gain_text', scalar: true },
  { pr: 230, where: `${PREV}:26`, reads: 'leagues[].stop_tradeoffs.value{}.net.value' },
  { pr: 230, where: `${PREV}:26`, reads: 'leagues[].stop_tradeoffs.value{}.verdict', scalar: true },
  { pr: 230, where: `${PREV}:27`, reads: 'leagues[].stop_tradeoffs.value{}.because', scalar: true },
  { pr: 230, where: `${PREV}:28`, reads: 'leagues[].stop_tradeoffs.value{}.new_next_move_changes', scalar: true },
  { pr: 230, where: `${CO}:265`, reads: 'leagues[].alternatives.value' },
  { pr: 230, where: `${CO}:464`, reads: 'leagues[].next_move.value' },
  // FIX-06: dealLine() reads the deal from the move's first step.
  { pr: 230, where: `${CO}:441`, reads: 'leagues[].alternatives.value[].steps[].partner', scalar: true },
  { pr: 230, where: `${CO}:439`, reads: 'leagues[].alternatives.value[].steps[].give' },
  { pr: 230, where: `${CO}:440`, reads: 'leagues[].alternatives.value[].steps[].get' },
  { pr: 230, where: `${CO}:453`, reads: 'leagues[].destination.value.goal.value.label', scalar: true },
  { pr: 230, where: `${CO}:454`, reads: 'leagues[].destination.value.arrive_by.value', scalar: true },
  { pr: 230, where: `${CO}:457`, reads: 'leagues[].itinerary.value.stops' },
  { pr: 230, where: `${CO}:459`, reads: 'leagues[].itinerary.value.stops[].status', scalar: true },
  { pr: 230, where: `${CO}:458`, reads: 'leagues[].itinerary.value.stops_left', scalar: true },
  { pr: 230, where: `${CO}:461`, reads: 'leagues[].names' },
  // PLUG_IN_FIELDS (warroomCoach.ts:52-60, mirrored in schema.js): readField() unwraps at every step.
  { pr: 230, where: `${CO}:53`, reads: 'leagues[].destination.value.title_now.value' },
  { pr: 230, where: `${CO}:54`, reads: 'leagues[].destination.value.path.value' },
  { pr: 230, where: `${CO}:55`, reads: 'leagues[].itinerary.value.stops' },
  { pr: 230, where: `${CO}:56`, reads: 'leagues[].targets.value' },
  { pr: 230, where: `${CO}:57`, reads: 'leagues[].speed_curve.value' },
  { pr: 230, where: `${CO}:58`, reads: 'leagues[].flip_map.value' },
  { pr: 230, where: `${CO}:59`, reads: 'leagues[].brain_report.value.checks' },
  /* ------------------------------------------------- #234 reasoning (FIX-08) */
  { pr: 234, where: `${RS}:47`, reads: 'leagues[].league', scalar: true },
  { pr: 234, where: `${RS}:154`, reads: 'leagues[].names' },
  { pr: 234, where: `${RS}:104`, reads: 'leagues[].alternatives.value' },
  { pr: 234, where: `${RS}:86`, reads: 'leagues[].alternatives.value[].move_id', scalar: true },
  { pr: 234, where: `${RS}:91`, reads: 'leagues[].alternatives.value[].delta_final.value', scalar: true },
  { pr: 234, where: `${RS}:88`, reads: 'leagues[].alternatives.value[].steps[].partner', scalar: true },
  { pr: 234, where: `${RS}:89`, reads: 'leagues[].alternatives.value[].steps[].give' },
  { pr: 234, where: `${RS}:89`, reads: 'leagues[].alternatives.value[].steps[].get' },
  { pr: 234, where: `${RS}:90`, reads: 'leagues[].alternatives.value[].steps[].p_yes.value', scalar: true },
  { pr: 234, where: `${RS}:90`, reads: 'leagues[].alternatives.value[].steps[].p_yes.n', scalar: true,
    awaits: 'no producer writes the offer count behind p_yes yet (FIX-03 prices it with a heuristic); cards.js reads it as null' },
  { pr: 234, where: `${RS}:84`, reads: 'leagues[].alternatives.value[].steps[].title_odds_delta.value', scalar: true },
  { pr: 234, where: `${RS}:84`, reads: 'leagues[].alternatives.value[].steps[].title_odds_delta.se', scalar: true },
  { pr: 234, where: `${RS}:84`, reads: 'leagues[].alternatives.value[].steps[].title_odds_delta.clears_2se', scalar: true },
  { pr: 234, where: `${RS}:95`, reads: 'leagues[].alternatives.value[].steps[].send_when.value', scalar: true },
  { pr: 234, where: `${RS}:96`, reads: 'leagues[].alternatives.value[].steps[].opening.value.text', scalar: true },
  { pr: 234, where: `${RS}:98`, reads: 'leagues[].alternatives.value[].steps[].walk_away.value.text', scalar: true },
  { pr: 234, where: `${RS}:68`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value' },
  { pr: 234, where: `${RS}:74`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.accept.value.do', scalar: true },
  { pr: 234, where: `${RS}:74`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.silence.value.when', scalar: true },
  { pr: 234, where: `${RS}:75`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.counter.value.counter_rules.counter_with', scalar: true },
  { pr: 234, where: `${RS}:75`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.counter.value.counter_rules.accept_if', scalar: true },
  { pr: 234, where: `${RS}:76`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.counter.value.counter_rules.walk_away_if', scalar: true },
  { pr: 234, where: `${RS}:76`, reads: 'leagues[].alternatives.value[].steps[].reply_table.value.accept.value.odds_after.value', scalar: true },
  { pr: 234, where: `${RS}:52`, reads: 'leagues[].partners.value' },
  { pr: 234, where: `${RS}:52`, reads: 'leagues[].partners.value[].team', scalar: true },
  { pr: 234, where: `${RS}:169`, reads: 'leagues[].partners.value[].p_responds', scalar: true },
  { pr: 234, where: `${RS}:170`, reads: 'leagues[].partners.value[].basis', scalar: true },
  { pr: 234, where: `${RS}:171`, reads: 'leagues[].partners.value[].roster_holes' },
  { pr: 234, where: `${RS}:183`, reads: 'leagues[].partners.value[].offers_logged', scalar: true },
  { pr: 234, where: `${RS}:184`, reads: 'leagues[].partners.value[].chat_labels' },
  { pr: 234, where: `${RS}:60`, reads: 'leagues[].brain_report.value' },
  { pr: 234, where: `${RS}:62`, reads: 'leagues[].brain_report.value.checks[].id', scalar: true },
  { pr: 234, where: `${RS}:64`, reads: 'leagues[].brain_report.value.checks[].status', scalar: true }
];

export const FILES = { UI, DECK, REPLY, TOP, WR, ITIN, TGT, FLIP, BRAIN, CO, DOCK, PREV, ACT, RS };
