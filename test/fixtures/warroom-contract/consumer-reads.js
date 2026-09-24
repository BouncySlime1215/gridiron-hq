/**
 * Every key the War Room's two consumers read from the plans file, written in
 * plans-schema.js's path notation (`.key`, `[]` list item, `{}` map entry, a
 * typed field's value under `.value`).
 *
 * Pinned to the heads read for this contract:
 *   #231 claude/cloud-war-room-ui    cce5005  server/services/war-room-view.js
 *   #230 claude/cloud-war-room-coach 6ac4758  client/src/components/warroom/coach/warroomCoach.ts,
 *                                             CoachDock.tsx, server/services/warroom-actions/schema.js
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
const CO = 'client/src/components/warroom/coach/warroomCoach.ts';
const DOCK = 'client/src/components/warroom/coach/CoachDock.tsx';
const ACT = 'server/services/warroom-actions/schema.js';
const RS = 'server/services/reasoning/cards.js';

const deckFix = (field, to, line) => ({ fix: { to: `leagues[].alternatives.value[].${to}`, line } });

export const READS = [
  /* ---------------------------------------------------------------- #231 UI */
  { pr: 231, where: `${UI}:142`, reads: 'leagues' },
  { pr: 231, where: `${UI}:145`, reads: 'generated_at', scalar: true },
  { pr: 231, where: `${UI}:160`, reads: 'leagues[].names' },
  { pr: 231, where: `${UI}:372`, reads: 'leagues[].me', scalar: true },
  { pr: 231, where: `${UI}:365`, reads: 'leagues[].league', scalar: true },
  { pr: 231, where: `${UI}:375`, reads: 'leagues[].error', scalar: true },
  { pr: 231, where: `${UI}:379`, reads: 'leagues[].sanity_composed_equals_direct', scalar: true },
  { pr: 231, where: `${UI}:171`, reads: 'leagues[].acq.alternatives',
    fix: { to: 'leagues[].alternatives.value', line: 'deckPlans(): read `entry.alternatives` (a typed field; the deck is its `.value`) instead of `entry.acq.alternatives`.' } },
  { pr: 231, where: `${UI}:181`, reads: 'leagues[].acq.best',
    fix: { to: 'leagues[].next_move.value', line: 'Drop the named-plan fallback (best, best_direct, best_two, best_three, best_chained): the producer writes the ranked deck in `alternatives` and its head in `next_move`.' } },
  { pr: 231, where: `${UI}:202`, reads: 'leagues[].acq.fallback',
    fix: { to: 'leagues[].alternatives.value[].steps[].reply_table.value.decline', line: 'replies(): take the decline row from `step.reply_table.value.decline` (it names the backup by `move_id`), not `acq.fallback`.' } },
  { pr: 231, where: `${UI}:394`, reads: 'leagues[].acq.candidates_scored',
    fix: { to: 'leagues[].next_move.reason', line: 'Show `next_move.reason` when the deck is unknown; the producer puts the paths-searched count in that sentence.' } },
  { pr: 231, where: `${UI}:227`, reads: 'leagues[].acq.title_now',
    fix: { to: 'leagues[].destination.value.title_now', line: 'Read title odds now from `destination.value.title_now` (a typed field), not `acq.title_now`.' } },
  { pr: 231, where: `${UI}:231`, reads: 'leagues[].acq.best.target', ...deckFix('target', 'target', 'card(): `plan.target` stays `target`, read from the deck entry.') },
  { pr: 231, where: `${UI}:232`, reads: 'leagues[].acq.best.owner', ...deckFix('owner', 'target_owner', 'card(): read `plan.target_owner`, not `plan.owner`.') },
  { pr: 231, where: `${UI}:246`, reads: 'leagues[].acq.best.chained', ...deckFix('chained', 'chained', 'card(): `chained` is unchanged, read from the deck entry.') },
  { pr: 231, where: `${UI}:233`, reads: 'leagues[].acq.best.steps[].team', ...deckFix('team', 'steps[].partner', 'card()/stepLine()/itinerary(): read `step.partner`, not `step.team`.') },
  { pr: 231, where: `${UI}:234`, reads: 'leagues[].acq.best.steps[].give', ...deckFix('give', 'steps[].give', '`give` is unchanged, read from the deck entry.') },
  { pr: 231, where: `${UI}:234`, reads: 'leagues[].acq.best.steps[].get', ...deckFix('get', 'steps[].get', '`get` is unchanged, read from the deck entry.') },
  { pr: 231, where: `${UI}:236`, reads: 'leagues[].acq.best.steps[].p', ...deckFix('p', 'steps[].p_yes', 'Read `step.p_yes` (a typed field), not `step.p`.') },
  { pr: 231, where: `${UI}:240`, reads: 'leagues[].acq.best.steps[].delta', ...deckFix('delta', 'steps[].title_odds_delta', 'Read `step.title_odds_delta` (typed field carrying `se` and `clears_2se`), not `delta` / `se` / `clears`.') },
  { pr: 231, where: `${UI}:240`, reads: 'leagues[].acq.best.steps[].se', ...deckFix('se', 'steps[].title_odds_delta.se', 'Take the SE from `title_odds_delta.se`.') },
  { pr: 231, where: `${UI}:240`, reads: 'leagues[].acq.best.steps[].clears', ...deckFix('clears', 'steps[].title_odds_delta.clears_2se', 'Take the 2-SE flag from `title_odds_delta.clears_2se`.') },
  { pr: 231, where: `${UI}:239`, reads: 'leagues[].acq.best.steps[].title_after', ...deckFix('title_after', 'steps[].title_after', '`title_after` keeps its name but is a typed field: pass it through instead of num().') },
  { pr: 231, where: `${UI}:243`, reads: 'leagues[].acq.best.delta_final', ...deckFix('delta_final', 'delta_final', '`delta_final` is a typed field now.') },
  { pr: 231, where: `${UI}:244`, reads: 'leagues[].acq.best.p_complete', ...deckFix('p_complete', 'p_complete', '`p_complete` is a typed field now.') },
  { pr: 231, where: `${UI}:245`, reads: 'leagues[].acq.best.expected', ...deckFix('expected', 'expected', '`expected` is a typed field now.') },
  { pr: 231, where: `${UI}:245`, reads: 'leagues[].acq.best.expected_se', ...deckFix('expected_se', 'expected.se', 'Take the SE from `expected.se`, not `expected_se`.') },
  { pr: 231, where: `${UI}:253`, reads: 'leagues[].acq.best.message', ...deckFix('message', 'steps[].message', 'The playbook is per step: read `steps[0].message` (typed field), not a plan-level string.') },
  { pr: 231, where: `${UI}:254`, reads: 'leagues[].acq.best.walk_away', ...deckFix('walk_away', 'steps[].walk_away', 'Read `steps[0].walk_away.value.text` (+ `max_give`).') },
  { pr: 231, where: `${UI}:255`, reads: 'leagues[].acq.best.send_when', ...deckFix('send_when', 'steps[].send_when', 'Read `steps[0].send_when` (typed field).') },
  { pr: 231, where: `${UI}:218`, reads: 'leagues[].acq.best.reasoning', ...deckFix('reasoning', 'reasoning.value.case_for', 'reasoning(): read `plan.reasoning.value[slot]`; the panel is one typed field, not six bare strings.') },
  { pr: 231, where: `${UI}:249`, reads: 'leagues[].baseline.best_expected.expected',
    fix: { to: 'leagues[].finder_best_expected', line: 'vs_finder: read `finder_best_expected` (typed field with `se`), not `baseline.best_expected.expected` / `expected_se`.' } },
  { pr: 231, where: `${UI}:281`, reads: 'leagues[].acq.targets',
    fix: { to: 'leagues[].targets.value', line: 'suggestions(): read `targets.value[]` ({ player, owner, gain_if_landed, p_reach, mode_fit, why }), not `acq.targets` ids with `gain` / `p_complete`.' } },
  { pr: 231, where: `${UI}:304`, reads: 'leagues[].flip.top',
    fix: { to: 'leagues[].flip_map.value', line: 'flips(): read `flip_map.value[]` ({ player, buy_from, sell_to, spread, price_a, price_b, legs, legs_why_not }); drop the top/realised join and the a/b names.' } },
  { pr: 231, where: `${UI}:315`, reads: 'leagues[].flip.realised[].legs.d2',
    fix: { to: 'leagues[].flip_map.value[].legs.nick_after', line: 'Legs arrive joined: `legs.{give_a, get_b, p1, p2, p_both, nick_after}` replace `p_complete` / `d2` / `se2` / `clears2`.' } },

  /* ------------------------------------------------------------ #230 Coach */
  { pr: 230, where: `${CO}:244`, reads: 'leagues[].stop_tradeoffs.value' },
  { pr: 230, where: `${CO}:245`, reads: 'leagues[].stop_tradeoffs.value{}' },
  { pr: 230, where: `${DOCK}:25`, reads: 'leagues[].stop_tradeoffs.value{}.stop_label', scalar: true },
  { pr: 230, where: `${DOCK}:26`, reads: 'leagues[].stop_tradeoffs.value{}.cost.value' },
  { pr: 230, where: `${DOCK}:26`, reads: 'leagues[].stop_tradeoffs.value{}.extra_steps', scalar: true },
  { pr: 230, where: `${DOCK}:27`, reads: 'leagues[].stop_tradeoffs.value{}.gain.value' },
  { pr: 230, where: `${DOCK}:27`, reads: 'leagues[].stop_tradeoffs.value{}.gain_text', scalar: true },
  { pr: 230, where: `${DOCK}:28`, reads: 'leagues[].stop_tradeoffs.value{}.net.value' },
  { pr: 230, where: `${DOCK}:28`, reads: 'leagues[].stop_tradeoffs.value{}.verdict', scalar: true },
  { pr: 230, where: `${DOCK}:29`, reads: 'leagues[].stop_tradeoffs.value{}.because', scalar: true },
  { pr: 230, where: `${DOCK}:30`, reads: 'leagues[].stop_tradeoffs.value{}.new_next_move_changes', scalar: true },
  { pr: 230, where: `${CO}:263`, reads: 'leagues[].alternatives.value' },
  { pr: 230, where: `${CO}:459`, reads: 'leagues[].next_move.value' },
  { pr: 230, where: `${CO}:437`, reads: 'leagues[].alternatives.value[].partner',
    fix: { to: 'leagues[].alternatives.value[].steps[].partner', line: 'dealLine(): read the deal from `move.steps[0]` (`partner`, `give`, `get`); a deck entry is a plan, not a single offer.' } },
  { pr: 230, where: `${CO}:435`, reads: 'leagues[].alternatives.value[].give',
    fix: { to: 'leagues[].alternatives.value[].steps[].give', line: 'Same change: `move.steps[0].give`.' } },
  { pr: 230, where: `${CO}:436`, reads: 'leagues[].alternatives.value[].get',
    fix: { to: 'leagues[].alternatives.value[].steps[].get', line: 'Same change: `move.steps[0].get`.' } },
  { pr: 230, where: `${CO}:449`, reads: 'leagues[].destination.value.goal.label',
    fix: { to: 'leagues[].destination.value.goal.value.label', line: 'coachFooter(): `unwrap(dest?.goal)?.label`; the goal is a typed field (it can be unset while title odds are known).' } },
  { pr: 230, where: `${CO}:450`, reads: 'leagues[].destination.value.arrive_by', scalar: true,
    fix: { to: 'leagues[].destination.value.arrive_by.value', line: 'coachFooter(): `unwrap(dest.arrive_by)`; arrive_by is a typed field.' } },
  { pr: 230, where: `${CO}:452`, reads: 'leagues[].itinerary.value.stops' },
  { pr: 230, where: `${CO}:454`, reads: 'leagues[].itinerary.value.stops[].status', scalar: true },
  { pr: 230, where: `${CO}:453`, reads: 'leagues[].itinerary.value.stops_left', scalar: true },
  { pr: 230, where: `${CO}:456`, reads: 'leagues[].names' },
  // PLUG_IN_FIELDS (warroomCoach.ts:51-61, mirrored in schema.js): readField() unwraps at every step.
  { pr: 230, where: `${CO}:52`, reads: 'leagues[].destination.value.title_now.value' },
  { pr: 230, where: `${CO}:53`, reads: 'leagues[].destination.value.path.value' },
  { pr: 230, where: `${CO}:54`, reads: 'leagues[].itinerary.value.stops' },
  { pr: 230, where: `${CO}:56`, reads: 'leagues[].speed_curve.value' },
  { pr: 230, where: `${CO}:55`, reads: 'leagues[].suggestions.value',
    fix: { to: 'leagues[].targets.value', line: "PLUG_IN_FIELDS (client + schema.js): rename 'suggestions' to 'targets'." } },
  { pr: 230, where: `${CO}:57`, reads: 'leagues[].flips.value',
    fix: { to: 'leagues[].flip_map.value', line: "PLUG_IN_FIELDS: rename 'flips' to 'flip_map'." } },
  { pr: 230, where: `${CO}:58`, reads: 'leagues[].brain_check.value.checks',
    fix: { to: 'leagues[].brain_report.value.checks', line: "PLUG_IN_FIELDS: rename 'brain_check.checks' to 'brain_report.checks'." } },
  { pr: 230, where: `${CO}:60`, reads: 'leagues[].title.value.odds_by_week',
    fix: { to: 'leagues[].destination.value.path.value', line: "PLUG_IN_FIELDS: replace 'title.odds_by_week' with 'destination.path' (week-by-week planned vs actual title odds)." } },
  { pr: 230, where: `${CO}:59`, reads: 'leagues[].roster.value.bye_holes',
    fix: { to: 'leagues[].itinerary.value.stops[].week', line: "PLUG_IN_FIELDS: drop 'roster.bye_holes' until a producer writes it; bye cover today is a `cover_bye` stop with its `week`." } },
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
  { pr: 234, where: `${RS}:90`, reads: 'leagues[].alternatives.value[].steps[].p_yes.n', scalar: true },
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
  { pr: 234, where: `${RS}:169`, reads: 'leagues[].partners.value[].p_responds.value', scalar: true },
  { pr: 234, where: `${RS}:170`, reads: 'leagues[].partners.value[].basis', scalar: true },
  { pr: 234, where: `${RS}:171`, reads: 'leagues[].partners.value[].roster_holes' },
  { pr: 234, where: `${RS}:175`, reads: 'leagues[].partners.value[].paper_values' },
  { pr: 234, where: `${RS}:179`, reads: 'leagues[].partners.value[].recent_moves' },
  { pr: 234, where: `${RS}:183`, reads: 'leagues[].partners.value[].offers_logged', scalar: true },
  { pr: 234, where: `${RS}:184`, reads: 'leagues[].partners.value[].chat_labels' },
  { pr: 234, where: `${RS}:60`, reads: 'leagues[].brain_report.value' },
  { pr: 234, where: `${RS}:62`, reads: 'leagues[].brain_report.value.checks[].id', scalar: true },
  { pr: 234, where: `${RS}:64`, reads: 'leagues[].brain_report.value.checks[].status', scalar: true }
];

export const FILES = { UI, CO, DOCK, ACT, RS };
