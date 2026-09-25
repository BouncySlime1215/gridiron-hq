/**
 * WR-POLISH: the eight defects from the coordinator's 03:50 War Room browser audit
 * (league 4 at 1440x900), each pinned on a league-4-shaped plan: the live plans file's
 * league-4 entry with every name replaced by "Player <id> (POS)", free text rewritten,
 * and the sections the War Room does not draw trimmed to unknown. It is the shape the
 * audit saw: next_move unknown with a reason, an empty deck, a flip map that repeats one
 * player four times with no fair legs, catch_up's all-in line and a broken number audit.
 *
 *  1. the league rail never reads "rank 6 of 5": out-of-range ranks are failed by the view;
 *  2. NEXT MOVE with nothing cleared shows the reason, then the closest path and the all-in
 *     option, each labelled "did not clear the fresh-dice check";
 *  3. the flip map shows one row per player (its best leg); rows with no fair legs sit
 *     behind "Show all";
 *  4. the top strip keeps title odds now -> planned, the risk dial and both dots on their own row;
 *  5. an empty Coach dock greets and offers four prompts that send on click;
 *  6. the Coach footer says "none clears this week" + the reason, not "not computed yet";
 *  7. number health reads the audit (the contract shape, and the live number_audit when
 *     the plan carries none);
 *  8. targets never show a player the plan marks untouchable on his roster; the label shows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf, WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-wr-polish-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_WARROOM_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { buildWarRoomView, warRoomView, __resetPlansCache, attentionProblem } = await import('../server/services/war-room-view.js');
const { rankAttention } = await import('../server/services/campaign/attention.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });

/** League 4 as the producer wrote it at 03:29 on 2026-09-24 (names scrubbed). */
const LEAGUE4 = {"league":4,"me":"5","names":{"2":"Player 2 (RB)","4":"Player 4 (WR)","5":"Player 5 (WR)","7":"Player 7 (TE)","15":"Player 15 (RB)","17":"Player 17 (WR)","27":"Player 27 (QB)","28":"Player 28 (RB)","30":"Player 30 (WR)","33":"Player 33 (TE)","39":"Player 39 (K)","40":"Player 40 (QB)","41":"Player 41 (RB)","43":"Player 43 (WR)","44":"Player 44 (WR)","46":"Player 46 (TE)","53":"Player 53 (QB)","54":"Player 54 (RB)","56":"Player 56 (WR)","65":"Player 65 (K)","66":"Player 66 (QB)","67":"Player 67 (RB)","68":"Player 68 (RB)","69":"Player 69 (WR)","70":"Player 70 (WR)","72":"Player 72 (TE)","78":"Player 78 (K)","79":"Player 79 (QB)","80":"Player 80 (RB)","82":"Player 82 (WR)","83":"Player 83 (WR)","93":"Player 93 (RB)","95":"Player 95 (WR)","105":"Player 105 (QB)","106":"Player 106 (RB)","108":"Player 108 (WR)","109":"Player 109 (WR)","111":"Player 111 (TE)","117":"Player 117 (K)","119":"Player 119 (RB)","120":"Player 120 (RB)","121":"Player 121 (WR)","122":"Player 122 (WR)","131":"Player 131 (QB)","132":"Player 132 (RB)","134":"Player 134 (WR)","135":"Player 135 (WR)","137":"Player 137 (TE)","143":"Player 143 (K)","144":"Player 144 (QB)","145":"Player 145 (RB)","146":"Player 146 (RB)","147":"Player 147 (WR)","148":"Player 148 (WR)","149":"Player 149 (WR)","150":"Player 150 (TE)","157":"Player 157 (QB)","158":"Player 158 (RB)","159":"Player 159 (RB)","160":"Player 160 (WR)","163":"Player 163 (TE)","169":"Player 169 (K)","171":"Player 171 (RB)","174":"Player 174 (WR)","175":"Player 175 (WR)","176":"Player 176 (TE)","183":"Player 183 (QB)","184":"Player 184 (RB)","186":"Player 186 (WR)","187":"Player 187 (WR)","188":"Player 188 (WR)","195":"Player 195 (K)","196":"Player 196 (QB)","197":"Player 197 (RB)","198":"Player 198 (RB)","199":"Player 199 (WR)","200":"Player 200 (WR)","208":"Player 208 (K)","210":"Player 210 (RB)","212":"Player 212 (WR)","215":"Player 215 (TE)","223":"Player 223 (RB)","225":"Player 225 (WR)","226":"Player 226 (WR)","234":"Player 234 (K)","235":"Player 235 (QB)","236":"Player 236 (RB)","237":"Player 237 (RB)","238":"Player 238 (WR)","239":"Player 239 (WR)","241":"Player 241 (TE)","249":"Player 249 (RB)","251":"Player 251 (WR)","262":"Player 262 (RB)","263":"Player 263 (RB)","264":"Player 264 (WR)","265":"Player 265 (WR)","267":"Player 267 (TE)","274":"Player 274 (QB)","275":"Player 275 (RB)","276":"Player 276 (RB)","277":"Player 277 (WR)","278":"Player 278 (WR)","280":"Player 280 (TE)","287":"Player 287 (QB)","288":"Player 288 (RB)","290":"Player 290 (WR)","291":"Player 291 (WR)","292":"Player 292 (WR)","293":"Player 293 (TE)","300":"Player 300 (QB)","301":"Player 301 (RB)","303":"Player 303 (WR)","314":"Player 314 (RB)","316":"Player 316 (WR)","326":"Player 326 (QB)","327":"Player 327 (RB)","329":"Player 329 (WR)","332":"Player 332 (TE)","340":"Player 340 (RB)","341":"Player 341 (RB)","342":"Player 342 (WR)","343":"Player 343 (WR)","352":"Player 352 (QB)","353":"Player 353 (RB)","355":"Player 355 (WR)","358":"Player 358 (TE)","366":"Player 366 (RB)","367":"Player 367 (RB)","368":"Player 368 (WR)","377":"Player 377 (K)","379":"Player 379 (RB)","380":"Player 380 (RB)","381":"Player 381 (WR)","382":"Player 382 (WR)","383":"Player 383 (WR)","392":"Player 392 (RB)","394":"Player 394 (WR)","395":"Player 395 (WR)","404":"Player 404 (QB)","405":"Player 405 (RB)","407":"Player 407 (WR)","408":"Player 408 (WR)","419":"Player 419 (DEF)","426":"Player 426 (DEF)","427":"Player 427 (DEF)","429":"Player 429 (DEF)","432":"Player 432 (DEF)","435":"Player 435 (DEF)","437":"Player 437 (DEF)","440":"Player 440 (DEF)","443":"Player 443 (DEF)","444":"Player 444 (DEF)","445":"Player 445 (DEF)","449":"Player 449 (TE)","451":"Player 451 (TE)","452":"Player 452 (RB)","453":"Player 453 (RB)","454":"Player 454 (TE)","455":"Player 455 (WR)","457":"Player 457 (WR)","458":"Player 458 (QB)","460":"Player 460 (WR)","461":"Player 461 (TE)","462":"Player 462 (RB)","465":"Player 465 (RB)","468":"Player 468 (WR)","469":"Player 469 (WR)","470":"Player 470 (RB)","478":"Player 478 (WR)","486":"Player 486 (RB)","504":"Player 504 (WR)","582":"Player 582 (WR)"},"sanity_composed_equals_direct":true,"attention":{"status":"ok","value":{"rank":5,"of":5,"reason":"best move worth 0.0 pts"},"source":"campaign.plan"},"destination":{"status":"ok","value":{"goal":{"status":"ok","value":{"kind":"title","label":"Win the title"},"source":"campaign.plan"},"risk_mode":{"status":"ok","value":{"mode":"balanced"},"source":"campaign.plan"},"tolerances":{"status":"ok","value":{"max_assets":3,"max_offers_per_manager_week":2,"max_downside_per_step":0.01},"source":"campaign.plan"},"arrive_by":{"status":"unknown","source":"campaign.plan","reason":"No arrive-by week is set."},"eta_week":{"status":"unknown","source":"plan.path","reason":"No plan, so no arrival week."},"title_now":{"status":"ok","value":0.0008,"source":"sim.title","unit":"title_odds"},"title_planned_now":{"status":"ok","value":0,"source":"plan.path","unit":"title_odds"},"path":{"status":"ok","value":[{"week":3,"planned":0,"actual":0.0008}],"source":"plan.path"},"ground_lost":{"status":"ok","value":-0.0008,"source":"plan.path","unit":"title_odds"}},"source":"campaign.plan"},"finder_best_expected":{"status":"ok","value":0.00298,"source":"sim.title","se":0.0008641999999999999,"unit":"title_odds","guess":true,"n":8},"next_move":{"status":"unknown","source":"plan.path","reason":"None of the 116 paths searched clears the sliders and the fresh-dice check this week. Try another target or risk mode."},"alternatives":{"status":"ok","value":[],"source":"plan.path"},"itinerary":{"status":"ok","value":{"version":1,"stops":[],"stops_left":0,"untouchables":[],"conflicts":[]},"source":"plan.path"},"flip_map":{"status":"ok","value":[{"player":"134","buy_from":"10","sell_to":"11","spread":{"status":"ok","value":0.1442,"source":"sim.title","se":0.0156,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":8995.32,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":8495.58,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"134","buy_from":"10","sell_to":"9","spread":{"status":"ok","value":0.13329999999999997,"source":"sim.title","se":0.015100331122197287,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":8995.32,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":8329,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"134","buy_from":"10","sell_to":"12","spread":{"status":"ok","value":0.12999999999999998,"source":"sim.title","se":0.01565439235486322,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":8995.32,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":8329,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"134","buy_from":"10","sell_to":"1","spread":{"status":"ok","value":0.1192,"source":"sim.title","se":0.01602560451277892,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":8995.32,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":8329,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"15","buy_from":"2","sell_to":"12","spread":{"status":"ok","value":0.10669999999999999,"source":"sim.title","se":0.015362942426501507,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":11530.08,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":10889.52,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"15","buy_from":"2","sell_to":"1","spread":{"status":"ok","value":0.09749999999999999,"source":"sim.title","se":0.01587734234687909,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":11530.08,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":10676,"source":"clone.price","unit":"market_value"},"legs":null,"legs_why_not":"no fair one-player leg on both screens"},{"player":"15","buy_from":"2","sell_to":"9","spread":{"status":"ok","value":0.09670000000000001,"source":"sim.title","se":0.015088074761214567,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":11530.08,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":10889.52,"source":"clone.price","unit":"market_value"},"legs":null},{"player":"134","buy_from":"10","sell_to":"2","spread":{"status":"ok","value":0.0958,"source":"sim.title","se":0.012570600622086441,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":8995.32,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":8495.58,"source":"clone.price","unit":"market_value"},"legs":null},{"player":"132","buy_from":"11","sell_to":"1","spread":{"status":"ok","value":0.0734,"source":"sim.title","se":0.018677526602845464,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":11251.919699999999,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":11051.2815,"source":"clone.price","unit":"market_value"},"legs":null},{"player":"15","buy_from":"2","sell_to":"11","spread":{"status":"ok","value":0.0867,"source":"sim.title","se":0.014408677940741129,"clears_2se":true,"unit":"title_odds"},"price_a":{"status":"ok","value":11530.08,"source":"clone.price","unit":"market_value"},"price_b":{"status":"ok","value":10676,"source":"clone.price","unit":"market_value"},"legs":null}],"source":"sim.title","n":168},"targets":{"status":"ok","value":[{"player":"368","owner":"1","gain_if_landed":{"status":"ok","value":0.035,"source":"sim.title","se":0.0054,"unit":"title_odds"},"p_reach":{"status":"ok","value":0.212,"source":"plan.path","unit":"probability","guess":true},"mode_fit":{"status":"ok","value":"needs_all_in","source":"plan.path"},"why":{"status":"ok","value":"Player 368 is a suggested target.","source":"plan.template"},"approved":false,"is_plan_target":false},{"player":"132","owner":"11","gain_if_landed":{"status":"ok","value":0.0292,"source":"sim.title","se":0.005,"unit":"title_odds"},"p_reach":{"status":"ok","value":0.13670400000000002,"source":"plan.path","unit":"probability","guess":true},"mode_fit":{"status":"ok","value":"needs_all_in","source":"plan.path"},"why":{"status":"ok","value":"Player 132 is a suggested target.","source":"plan.template"},"approved":false,"is_plan_target":false},{"player":"134","owner":"10","gain_if_landed":{"status":"ok","value":0.025,"source":"sim.title","se":0.0047,"unit":"title_odds"},"p_reach":{"status":"unknown","source":"plan.path","reason":"No path to him fits any risk mode yet."},"mode_fit":{"status":"ok","value":"too_risky_for_safe","source":"plan.path"},"why":{"status":"ok","value":"Player 134 is a suggested target.","source":"plan.template"},"approved":false,"is_plan_target":false},{"player":"171","owner":"1","gain_if_landed":{"status":"ok","value":0.0234,"source":"sim.title","se":0.0045,"unit":"title_odds"},"p_reach":{"status":"unknown","source":"plan.path","reason":"No path to him fits any risk mode yet."},"mode_fit":{"status":"ok","value":"too_risky_for_safe","source":"plan.path"},"why":{"status":"ok","value":"Player 171 is a suggested target.","source":"plan.template"},"approved":false,"is_plan_target":false},{"player":"197","owner":"1","gain_if_landed":{"status":"ok","value":0.0184,"source":"sim.title","se":0.004,"unit":"title_odds"},"p_reach":{"status":"unknown","source":"plan.path","reason":"No path to him fits any risk mode yet."},"mode_fit":{"status":"ok","value":"too_risky_for_safe","source":"plan.path"},"why":{"status":"ok","value":"Player 197 is a suggested target.","source":"plan.template"},"approved":false,"is_plan_target":false}],"source":"plan.path"},"catch_up":{"status":"ok","value":[{"text":"You are behind: the all-in plan reaches +3.3 pts if it lands.","gain":{"status":"ok","value":0.004442880000000001,"source":"plan.path","unit":"title_odds"},"steps":2},{"text":"Trade deadline: week 12 (9 weeks left).","gain":{"status":"unknown","source":"plan.path","reason":"The deadline clock carries no gain of its own."},"steps":0}],"source":"plan.path"},"speed_curve":{"status":"unknown","source":"plan.path","reason":"No plan to put on a clock."},"brain_report":{"status":"ok","value":{"overall":"not_enough_data","checks":[{"id":"E1","name":"Accept calibration","bar":"log-loss gain vs activity-only: 95% anytime-valid CS > 0; pooled reliability slope 0.8-1.2 (se <= 0.25)","status":"not_enough_data","result":"needs 171590 more offers","n":37,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E2","name":"Price accuracy","bar":"accept rate at the predicted yes point within an anytime-valid 95% CS of predicted (CS width <= 0.30); offers below it < 50% accepted","status":"not_enough_data","result":"needs 10 more offers","n":0,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E3","name":"Title-odds calibration (Sleeper replay, historical)","bar":"Brier gain vs standings-only CI > 0 and reliability slope 0.8-1.2","status":"passing","result":"brier_gain_title_vs_standings 0.0018 (95% CI 0.0012 to 0.0024)","n":906,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E3-live","name":"Title-odds calibration (2026 live)","bar":"Brier gain vs standings-only CI > 0 and reliability slope 0.8-1.2","status":"not_enough_data","result":"needs 40 more team-seasons (no snapshot has a resolved playoff outcome yet)","n":0,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E4","name":"Planner vs simple baselines","bar":"planner title-odds gain minus finder's best offer AND minus do-nothing, both CI > 0","status":"not_enough_data","result":"needs 30 more league-seasons (planner replay output not produced yet; the E4 planner replay harness (Sleeper, no unit assigned yet) produces it)","n":0,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E5","name":"Step value, live","bar":"mean realized title-odds gain CI > 0 and within CI of predicted","status":"not_enough_data","result":"needs 15 more steps","n":0,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E6","name":"Follow vs ignore","bar":"near-tie followed-minus-ignored score CI > 0 (>= 20 per arm, >= 8 weeks)","status":"not_enough_data","result":"needs 20 more decisions","n":0,"as_of":"2026-09-24T07:22:53.666Z"},{"id":"E7","name":"Luck vs decision","bar":"weekly split shown; mean luck per team-week CI contains 0 (>= 4 weeks)","status":"not_enough_data","result":"needs 4 more weeks (source table weekly_autopsy is not built yet; PROJ-04-a (Monday Autopsy) builds it)","n":0,"as_of":"2026-09-24T07:22:53.666Z"}],"blocks":["Until E1 passes, every \"chance he says yes\" is a guess."]},"source":"eval.check","as_of":"2026-09-24T07:22:53.666Z"},"number_health":{"status":"ok","value":{"overall":"broken","broken":2,"warn":0,"ok":9,"checks":[{"check_id":"projection_basis","status":"broken","title":"Title tab and trade finder rank players differently","detail":"Rank agreement between the title simulator's and the trade finder's player rates is 0.78 over 142 rostered players (needs 0.9); average gap 2.2 pts/game.","cause":"The title simulator prices players on last season's projections; the trade finder uses this season's rest-of-season rate."},{"check_id":"weekly_range","status":"broken","title":"Weekly ranges differ between pages","detail":"Your lineup's weekly floor this week: Ceiling lineup says 87.7, Start/Sit posture says 54.9 (32.9 pts apart; limit 10).","cause":"Four separate samplers for one lineup-week (trade card, season sim, ceiling lineup, lineup posture), with different inputs and methods."},{"check_id":"checked_out","status":"ok","title":"Two \"checked out\" signals at once","detail":"Only checkedOutFactor (counterparty pricing) is applied.","cause":"activity.manager (engine) and checkedOutFactor (counterparty pricing) both nudge receptiveness for the same dead starts."},{"check_id":"current_week","status":"ok","title":"Pages disagree on the current week","detail":"All pages use week 3.","cause":"Three week producers: the NFL schedule's next unplayed week (trade engine), the league's own week, and the simulator's start week."},{"check_id":"inv_no_nan","status":"ok","title":"A number is missing (NaN)","detail":"No served value is NaN or infinite.","cause":"A producer returned NaN or Infinity instead of a number."},{"check_id":"inv_odds_sum","status":"ok","title":"League odds do not add up","detail":"Title odds sum to 100% and playoff odds to 6 spots.","cause":"Title odds must sum to 100% across the league and playoff odds to the number of playoff spots."},{"check_id":"inv_probability_range","status":"ok","title":"A probability is outside 0-100%","detail":"Every served odds value is between 0 and 100%.","cause":"A served odds value is below 0 or above 1."},{"check_id":"inv_range_order","status":"ok","title":"A weekly range is out of order","detail":"Every weekly range runs floor <= median <= ceiling.","cause":"A floor above its median or ceiling, or a negative floor."},{"check_id":"p_play_default","status":"ok","title":"Chance to play is guessed for some players","detail":"0 of 152 rostered players have no chance-to-play read and are priced at 92%. Largest gap between the trade engine's and the simulator's chance to play for one player: 0.0 pts.","cause":"Players with no availability read are priced at a 92% default (trade-engine.js, season-sim.js), and the callers ask for different weeks."},{"check_id":"source_age","status":"ok","title":"Data is older than it should be","detail":"Every source synced within its window (League sync, NFL injury reports, NFL scores and lines).","cause":"A source has not synced within its expected window."},{"check_id":"title_odds_paths","status":"ok","title":"Title odds differ between pages","detail":"Title odds agree within 0.1 pts, playoff odds within 1.9 pts.","cause":"Three separate simulations with their own caches and random seeds (My team uses a fresh random world per server start; Trade Lab uses one seed per sync; the trade finder its own fixed seed)."}]},"source":"audit.numbers","as_of":"2026-09-24T06:52:28.879Z"},"risk_modes":{"status":"ok","value":[{"mode":"safe","label":"Safe","active":false,"expected":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"if_complete":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"p_complete":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"first_step":null},{"mode":"balanced","label":"Balanced","active":true,"expected":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"if_complete":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"p_complete":{"status":"unknown","source":"plan.path","reason":"No plan fits this mode."},"first_step":null},{"mode":"all_in","label":"Fuck it, let's go","active":false,"expected":{"status":"ok","value":0.004442880000000001,"source":"plan.path","unit":"title_odds"},"if_complete":{"status":"ok","value":0.0325,"source":"plan.path","unit":"title_odds"},"p_complete":{"status":"ok","value":0.13670400000000002,"source":"plan.path","unit":"probability","guess":true},"first_step":{"partner":"7","give":["367","379"],"get":["290"]}}],"source":"plan.path"},"feasibility":{"status":"unknown","source":"sim.title","reason":"Trimmed from the fixture."},"feasibility_points":{"status":"unknown","source":"sim.title","reason":"Trimmed from the fixture."},"stop_tradeoffs":{"status":"unknown","source":"plan.path","reason":"Trimmed from the fixture."},"partners":{"status":"unknown","source":"plan.path","reason":"Trimmed from the fixture."}};

const ON = { enabled: true, preview: false };
const plansOf = (...entries) => ({ status: 'ok', entries: structuredClone(entries), as_of: '2026-09-24T07:29:00.000Z', id: 'plans@1' });
const viewOf = (entry = LEAGUE4) => buildWarRoomView(entry.league, plansOf(entry), ON);
const LEAGUES = [1, 2, 3, 4, 5].map(id => ({ id, name: `League ${id}` }));

const { default: WarRoom } = await wr.mod('WarRoomV2'); // the classic dashboard is retired; the War Room is WarRoomV2
const { default: TopStrip, rankInRange } = await wr.mod('TopStrip');
const { default: FlipMap, groupFlips } = await wr.mod('FlipMap');
const { default: NoMoveCard, NOT_CLEARED } = await wr.mod('NoMoveCard');
const { default: TargetPicker } = await wr.mod('TargetPicker');
const { HealthDot } = await wr.mod('BrainCheckCard');
const { default: CoachDock, CoachStarter, STARTER_PROMPTS } = await wr.mod('coach/CoachDock');
const coachLib = await wr.mod('coach/warroomCoach');
const { useWarRoomCoach } = await wr.mod('coach/useWarRoomCoach');

const render = el => renderToStaticMarkup(el);
const room = (view, activeId = 4) => render(React.createElement(WarRoom, { view, leagues: LEAGUES, activeId, onLeague() {}, onExit() {} }));
const panel = (html, id) => {
  const at = html.indexOf(`data-panel="${id}"`);
  assert.ok(at > 0, `panel ${id}`);
  const next = html.indexOf('data-panel="', at + 12);
  return html.slice(at, next > 0 ? next : html.indexOf('class="wr-dots"'));
};

test('the fixture is a valid league entry with the audit-time shape', () => {
  assert.deepEqual(validateLeague(LEAGUE4, '$').errors, []);
  assert.equal(LEAGUE4.next_move.status, 'unknown');
  assert.match(LEAGUE4.next_move.reason, /fresh-dice check/);
  assert.deepEqual(LEAGUE4.alternatives.value, []);
  const firstFour = LEAGUE4.flip_map.value.slice(0, 4).map(f => f.player);
  assert.equal(new Set(firstFour).size, 1, 'one player four times at the top of the flip map');
  assert.ok(LEAGUE4.flip_map.value.every(f => !f.legs), 'no fair legs anywhere');
  for (const n of Object.values(LEAGUE4.names)) assert.match(n, /^Player \d+ \(\w+\)$/, 'no real names in the fixture');
});

/* ------------------------------------------------------------ 1. rank */

test('1: rankAttention ranks 1..of with one row per league', () => {
  const r = rankAttention([{ league: 1, expected: 0.02 }, { league: 2, expected: 0.05 }, { league: 1, expected: 0.01 }, { league: 3 }]);
  assert.equal(r.length, 3, 'a league listed twice is ranked once');
  for (const x of r) { assert.equal(x.of, 3); assert.ok(x.rank >= 1 && x.rank <= x.of); }
  assert.equal(attentionProblem({ rank: 6, of: 5 }), 'rank 6 of 5 is out of range');
  assert.equal(attentionProblem({ rank: 5, of: 5 }), null);
  assert.equal(attentionProblem({ rank: 0, of: 5 }), 'rank 0 of 5 is out of range');
  assert.equal(rankInRange(6, 5), false);
  assert.equal(rankInRange(5, 5), true);
});

/* ------------------------------------------------------- 2. next move */

test('2: NEXT MOVE with nothing cleared: the reason, then the closest path and the all-in option', () => {
  const html = panel(room(viewOf()), 'next');
  const text = textOf(html);
  const why = text.indexOf('None of the 116 paths searched clears the sliders and the fresh-dice check this week');
  const near = text.indexOf('Closest path');
  const allIn = text.indexOf('All-in option');
  assert.ok(why > 0 && near > why && allIn > near, 'reason on top, then closest path, then all-in');
  assert.match(text, /No move clears this week/);
  // Closest path: the risk-mode row with the highest expected gain, its first step and its numbers.
  assert.match(text, /Offer Team 7: Player 367 \(RB\) \+ Player 379 \(RB\) for Player 290 \(WR\)/);
  assert.match(text, /\+0\.4 pts expected · \+3\.3 pts if it all lands · finishes 14% of the time/);
  assert.match(text, /Finder's best single offer: \+0\.3 pts/);
  // All-in option: catch_up's all-in line.
  assert.match(text, /You are behind: the all-in plan reaches \+3\.3 pts if it lands\. \+0\.4 pts expected, 2 steps/);
  assert.equal(text.split(NOT_CLEARED).length - 1, 2, 'both labelled "did not clear the fresh-dice check"');
  assert.doesNotMatch(text, /NaN|undefined/);
});

test('2: the no-move card asks Coach, and says so when the plan wrote nothing to show', () => {
  const asked = [];
  const tree = NoMoveCard({ view: viewOf(), onAsk: q => asked.push(q) });
  const buttons = [];
  const walk = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button') buttons.push(n); walk(n.props?.children); };
  walk(tree);
  buttons.find(b => b.props.children === 'Show me the all-in plan').props.onClick();
  assert.deepEqual(asked, ['Show me the all-in plan']);
  const bare = viewOf({ ...structuredClone(LEAGUE4), risk_modes: { status: 'unknown', source: 'plan.path', reason: 'x' }, catch_up: { status: 'unknown', source: 'plan.path', reason: 'No catch-up list this run.' } });
  const text = textOf(render(React.createElement(NoMoveCard, { view: bare })));
  assert.match(text, /No path has an expected gain written for this run/);
  assert.match(text, /No catch-up list this run/);
});

/* -------------------------------------------------------- 3. flip map */

/* ------------------------------------------------------- 4. top strip */

test('4: the top strip keeps title odds now -> planned, the risk dial and both dots', () => {
  const html = render(React.createElement(TopStrip, { view: viewOf(), leagues: LEAGUES, activeId: 4, onLeague() {}, onExit() {}, theme: 'light', onTheme() {} }));
  const text = textOf(html);
  assert.match(text, /Title odds 0\.1% → plan 0\.0%/);
  assert.match(html, /data-fact="risk"[\s\S]*Balanced/);
  assert.match(html, /data-fact="checks"[\s\S]*wr-dot-grey[\s\S]*brain[\s\S]*data-health="red"/);
  const css = fs.readFileSync(path.join(WARROOM_DIR, 'warroom.css'), 'utf8');
  assert.match(css, /\.wr-top \.wr-facts \{ order: 10; flex: 1 1 100%; overflow: visible;/, 'the facts row is never squeezed out');
});

/* ----------------------------------------------------------- 5. coach */

function mountCoach(plans) {
  let coach = null;
  const Probe = () => { coach = useWarRoomCoach({ leagueId: 4, leagues: [4], plans }); return null; };
  render(React.createElement(Probe));
  return coach;
}

test('5: an empty Coach dock greets and offers four prompts that send on click', () => {
  const view = viewOf();
  const coach = mountCoach(view);
  const text = textOf(render(React.createElement(CoachDock, { coach, plans: view })));
  assert.match(text, /I read this league's plan/);
  assert.deepEqual([...STARTER_PROMPTS], ["What's my next move and why?", 'Why is nothing clearing?', 'Show me the all-in plan', 'Who should I message first?']);
  for (const q of STARTER_PROMPTS) assert.ok(text.includes(q), q);
  const asked = [];
  const tree = CoachStarter({ coach: { ...coach, busy: false, ask: q => { asked.push(q); return Promise.resolve(); } } });
  const buttons = [];
  const walk = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button') buttons.push(n); walk(n.props?.children); };
  walk(tree);
  assert.equal(buttons.length, 4);
  for (const b of buttons) b.props.onClick();
  assert.deepEqual(asked, [...STARTER_PROMPTS]);
});

/* ---------------------------------------------------------- 6. footer */

test('6: the Coach footer says none clears this week, with the reason', () => {
  const f = coachLib.coachFooter(viewOf());
  assert.equal(f.next_move, 'none clears this week (None of the 116 paths searched clears the sliders and the fresh-dice check this week)');
  assert.doesNotMatch(f.text, /Next move: not computed yet/);
  const text = textOf(render(React.createElement(CoachDock, { coach: mountCoach(viewOf()), plans: viewOf() })));
  assert.match(text, /Next move: none clears this week/);
  // A plan that was never run still says so.
  assert.equal(coachLib.coachFooter({}).next_move, 'not computed yet');
});

/* ---------------------------------------------------- 7. number health */

test('7: when the plan carries no number_health, the view reads number_audit (FIX-05)', async () => {
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
  const { writeAuditRows } = await import('../server/services/number-audit.js');
  writeAuditRows(4, [
    { check_id: 'current_week', status: 'warn', title: 'Two pages disagree on the week', detail: 'wk 3 vs wk 4' },
    { check_id: 'p_play_default', status: 'ok', title: 'Chance to play defaults', detail: 'all priced' },
  ], { asOf: '2026-09-24T07:00:00.000Z' });
  const entry = structuredClone(LEAGUE4);
  entry.number_health = { status: 'unknown', source: 'audit.numbers', reason: 'The number audit was not read for this run.' };
  const file = path.join(temp, 'plans.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'warroom-plans/1', generated_at: '2026-09-24T07:29:00.000Z', leagues: [entry] }));
  const saved = { e: process.env.GRIDIRON_WARROOM_ENABLED, p: process.env.GRIDIRON_WARROOM_PLANS };
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  process.env.GRIDIRON_WARROOM_PLANS = file;
  __resetPlansCache();
  try {
    const view = await warRoomView(4);
    assert.equal(view.number_health.status, 'ok');
    assert.equal(view.number_health.source, 'audit.numbers');
    assert.equal(view.number_health.value.overall, 'warn');
    assert.deepEqual([view.number_health.value.warn, view.number_health.value.ok], [1, 1]);
    const text = textOf(render(React.createElement(HealthDot, { health: view.number_health })));
    assert.match(text, /1 warning\(s\), 1 checked ok/);
    assert.match(text, /Two pages disagree on the week/);
    // A league the audit has never seen stays unknown with its reason.
    const other = await warRoomView(9);
    assert.equal(other.number_health.status, 'unknown');
  } finally {
    for (const [k, v] of [['GRIDIRON_WARROOM_ENABLED', saved.e], ['GRIDIRON_WARROOM_PLANS', saved.p]]) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    __resetPlansCache();
  }
});

/* ------------------------------------------------------- 8. untouchable */

test('8: targets never show a player the plan marks untouchable on his roster', () => {
  const first = LEAGUE4.targets.value[0];
  // (a) a per-roster list on the entry
  const listed = viewOf({ ...structuredClone(LEAGUE4), untouchables_by_roster: { [first.owner]: [first.player] } });
  assert.equal(listed.targets.value.some(t => t.player === first.player), false);
  assert.deepEqual(listed.targets.hidden_untouchable, [{ player: first.player, owner: first.owner, label: 'on his untouchable list' }]);
  const text = textOf(render(React.createElement(TargetPicker, { field: listed.targets, names: LEAGUE4.names, big: true })));
  assert.doesNotMatch(text.replace(/1 hidden:.*$/, ''), new RegExp(`Player ${first.player} `));
  assert.match(text, new RegExp(`1 hidden: Player ${first.player} \\(\\w+\\) \\(Team ${first.owner}, on his untouchable list\\)`));
  // (a2) the producer's own per-manager list: partners[].untouchable (RULINGS 17, integration batch 4)
  const viaPartners = viewOf({ ...structuredClone(LEAGUE4),
    partners: { status: 'ok', source: 'campaign.plan', value: [{ team: first.owner, p_responds: 0.5, basis: 'fixture',
      edge: { status: 'ok', value: 0, source: 'plan.path', unit: 'title_odds' }, untouchable: [first.player] }] } });
  assert.equal(viaPartners.targets.value.some(t => t.player === first.player), false);
  assert.deepEqual(viaPartners.targets.hidden_untouchable, [{ player: first.player, owner: first.owner, label: 'on his untouchable list' }]);
  // (b) a label on the target row itself (batch 4), even if a view slipped it through
  const marked = structuredClone(LEAGUE4.targets);
  marked.value[0].untouchable = true;
  marked.value[0].untouchable_label = 'he called him untouchable (held)';
  const t2 = textOf(render(React.createElement(TargetPicker, { field: marked, names: LEAGUE4.names, big: true })));
  assert.match(t2, /1 hidden: .*he called him untouchable \(held\)/);
  assert.equal((t2.match(new RegExp(`Player ${first.player} \\(`, 'g')) ?? []).length, 1, 'only in the hidden label');
  // (c) no marks: nothing hidden, no label
  const plain = viewOf();
  assert.equal(plain.targets.hidden_untouchable, undefined);
  assert.doesNotMatch(textOf(render(React.createElement(TargetPicker, { field: plain.targets, names: LEAGUE4.names, big: true }))), /hidden:/);
});
