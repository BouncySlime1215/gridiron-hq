/**
 * WARROOM-CONTRACT: the one shape of the War Room plans file.
 *
 * The campaign producer writes this file offline; the War Room view
 * (server/services/war-room-view.js, PR #231) and Coach's War Room actions
 * (client/src/components/warroom/coach/warroomCoach.ts, PR #230) read it.
 * Nothing on the request thread computes a plan, so this file is the whole
 * interface between them, and a key one side renames silently becomes
 * "not computed yet" on the other. This module is the single list of keys.
 *
 * Plain JS, no dependencies. `validatePlans(doc)` returns every problem it
 * finds with its path; it never throws on bad input and never repairs it.
 * `schemaPaths()` lists every path a producer may write, so a test can prove
 * that each key a consumer reads is one the producer writes.
 *
 * Typed field (every section, and every number inside one):
 *   { status: 'ok' | 'unknown' | 'failed', value?, reason?, source, se?, clears_2se?, as_of?, n?, unit?, guess? }
 * `unit` says what a number measures (UNITS); `guess: true` marks a number
 * built on an unvalidated model, which the UI badges as a guess.
 * `value` is present exactly when status is 'ok'. 'unknown' and 'failed'
 * carry a plain-words `reason` and no value, so a missing number can never
 * render as 0. `source` is a key of SOURCE_IDS (WAR-ROOM-UI.md 2.3).
 */

export const SCHEMA_VERSION = 'warroom-plans/1';

export const STATUSES = Object.freeze(['ok', 'unknown', 'failed']);

export const SOURCE_IDS = Object.freeze([
  'sim.title', 'clone.accept', 'clone.price', 'market.fc', 'plan.path',
  'coach.text', 'eval.check', 'audit.numbers', 'campaign.plan',
  // FIX-03: real sources the producer writes. plan.template = text built by a
  // template from engine facts only; chat.labels = chat-DB labels and counts,
  // no text; asset.ros = a player's rest-of-season rate.
  'plan.template', 'chat.labels', 'asset.ros',
  // PLAYER-SCORE: people.score = the blue-chip score (draft pick x production, people/player-score.js);
  // fp.ros = FantasyPros' rest-of-season rank via the public DynastyProcess scrape (people/fantasypros-ros.js).
  'people.score', 'fp.ros',
  // PYES-ONE: P(yes) from the E1 activity baseline (p-yes.js, GRIDIRON_PYES_BASELINE=1),
  // "activity baseline (E1 pending)"; clone.accept stays the source with the flag off.
  'activity.accept',
  // LIVE-BLEND: P(yes) from the online-weighted blend of the activity baseline and the clone (p-yes-blend.js).
  'blend.accept'
]);

export const UNITS = Object.freeze(['title_odds', 'playoff_odds', 'points_per_week', 'probability', 'market_value']);

// Vocabularies shared with Coach's action schema (PR #230,
// server/services/warroom-actions/schema.js). Same values, same spelling.
export const GOALS = Object.freeze(['title', 'playoffs', 'get_player', 'points']);
export const RISK_MODES = Object.freeze(['safe', 'balanced', 'all_in']);
export const STOP_KINDS = Object.freeze(['get', 'sell', 'flip', 'claim', 'cover_bye', 'untouchable', 'custom']);
export const TOLERANCE_KEYS = Object.freeze([
  'max_assets', 'max_offers_per_manager_week', 'max_downside_per_step', 'reputation_budget', 'ai_spend'
]);
export const STOP_STATUSES = Object.freeze(['next', 'waiting', 'done', 'dropped', 'blocked']);
export const REASONING_SLOTS = Object.freeze(['case_for', 'his_side', 'devils_advocate', 'news_check', 'confidence', 'counter']);
/** Report-card check ids: E1-E7 plus the graders' sub-checks (E3-live on main; E4-live #294 and E3-ESPN #322 pending),
 *  C8 (REASON-02 #271, reasoning/grade.js in eval GRADERS), and L01B-ACT / L01B-SIM / L01B-GATE (eval/living-gate.js).
 *  A grader that adds a new id must add it here, or every league's plan fails its contract check (9/24 incident). */
export const BRAIN_CHECK_IDS = Object.freeze(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E3-live', 'E4-live', 'E3-ESPN', 'C8', 'L01B-ACT', 'L01B-SIM', 'L01B-GATE']);
export const MAX_ALTERNATIVES = 5;
/** Why Nick skipped a deck card: the War Room deck, Coach and the producer's skip weights share these ids. */
export const SKIP_REASONS = Object.freeze(['player', 'cost', 'manager', 'not_now']);
/** Why a manager said no (north-star row 21): logged by Nick, read by the producer and the E2 grader. */
export const DECLINE_REASONS = Object.freeze(['wants_more', 'likes_his_player', 'not_interested', 'not_now', 'other']);
/** Catch-up kinds (campaign/catchup.js#CATCHUP_ORDER) and speed levers (campaign/speed.js#CURVE_LEVERS). */
export const CATCHUP_KINDS = Object.freeze(['free', 'flip', 'desperate', 'swing', 'timing']);
/** NEGOTIATOR-DEFAULTS levers (negotiator-defaults.js reads this list). */
export const NEGOTIATION_LEVERS = Object.freeze(['defensible_anchor', 'two_packages', 'firm_wording', 'why_line', 'expiry',
  'withdraw_on_news', 'feeler_first', 'no_pressure_tactics', 'cool_off']);
/** Why a second package was not served (planner.js confirmAlt): the rules a served plan must pass. */
export const ALT_DROP_REASONS = Object.freeze(['over_cap', 'path_conflict', 'floor', 'trade_memory', 'confirm_dice']);
export const SPEED_LEVERS = Object.freeze(['sequential', 'parallel', 'concede', 'package', 'all_in']);
/** PLAYER-SCORE vocabularies (people/player-score.js LABEL_NAMES / GAP_TYPES; a test pins them equal). */
export const SCORE_LABELS = Object.freeze(['Elite blue chip', 'Blue chip', 'Level below', 'Solid starter', 'Flex', 'Depth', 'Bench']);
export const SCORE_GAPS = Object.freeze(['undervalued_blue_chip', 'fading_blue_chip', 'riser', 'we_value_lower', 'we_value_higher']);
/** LADDER-01 rung tiers (campaign/ladder.js TIERS; a test pins them equal). */
export const LADDER_TIERS = Object.freeze(['blue_chip', 'level_below', 'depth', 'unscored']);
export const NUMBER_HEALTH_STATUSES = Object.freeze(['ok', 'warn', 'broken']);

/**
 * stop_tradeoffs keys, exactly as Coach builds them (warroomCoach.ts tradeoffKey):
 *   add:<kind>:<player_id | week | label lower-cased>   remove:<stop_id>
 *   mode:<mode>[:until:<week>]   tolerance:<key>:<value>   objective:<goal>[:<player_id | points>]
 */
export const TRADEOFF_KEY = new RegExp('^(?:' + [
  `add:(?:${STOP_KINDS.join('|')}):.+`,
  'remove:[A-Za-z0-9:_.-]+',
  `mode:(?:${RISK_MODES.join('|')})(?::until:(?:[1-9]|1[0-8]))?`,
  `tolerance:(?:${TOLERANCE_KEYS.join('|')}):-?\\d+(?:\\.\\d+)?`,
  `objective:(?:${GOALS.join('|')})(?::[A-Za-z0-9_.-]+)?`
].join('|') + ')$');

/** The producer's side of Coach's tradeoffKey: the key a plan change is priced under. */
export function tradeoffKey(a) {
  switch (a?.type) {
    case 'add_stop': return `add:${a.stop.kind}:${a.stop.player_id ?? a.stop.week ?? a.stop.label.trim().toLowerCase()}`;
    case 'remove_stop': return `remove:${a.stop_id}`;
    case 'set_risk_mode': return `mode:${a.mode}${a.until_week ? `:until:${a.until_week}` : ''}`;
    case 'set_tolerance': return `tolerance:${a.key}:${a.value}`;
    case 'set_objective': return `objective:${a.goal}${a.player_id ? `:${a.player_id}` : a.points_per_week ? `:${a.points_per_week}` : ''}`;
    default: return '';
  }
}

/* ------------------------------------------------------------ type kit */

const str = { t: 'str' };
const int = (min = -Infinity, max = Infinity) => ({ t: 'int', min, max });
const num = { t: 'num' };
const prob = { t: 'prob' };
const bool = { t: 'bool' };
const iso = { t: 'iso' };
/** A player id: must also be a key of this league's `names`. */
const pid = { t: 'pid' };
/** A team id or other opaque id. */
const id = { t: 'id' };
const lit = v => ({ t: 'lit', v });
const oneOf = values => ({ t: 'enum', values });
const arr = (item, { min = 0, max = Infinity } = {}) => ({ t: 'arr', item, min, max });
const map = (key, value) => ({ t: 'map', key, value });
const nullable = inner => ({ t: 'nullable', inner });
/** obj(required, optional) */
const obj = (req, opt = {}) => ({ t: 'obj', req, opt });
/** Any JSON value. Only under `_run` (bookkeeping no consumer reads). */
const json = { t: 'json' };
/** A typed field; `value` follows `inner` when status is 'ok'. */
const field = inner => ({ t: 'field', inner });
/** A number with its uncertainty, as a typed field. */
const numF = field(num);
const probF = field(prob);

const reasoning = obj(
  { ...Object.fromEntries(REASONING_SLOTS.map(k => [k, str])), cites: arr(str) },
  { check_first: bool }
);

const reply = obj({ do: str }, {
  when: str, message: str, odds_after: numF, move_id: id,
  counter_rules: obj({ accept_if: str, counter_with: str, walk_away_if: str })
});

/* ONE-COUNTERPART (RULINGS 17): the counterpart model's served numbers are typed fields, not squeezed into
 * existing keys. reply_mix = the M6 reply prior (league-wide, not fitted per manager); p_accept_challenger =
 * the model's P(accept) beside the served p_yes (chat weight 0 until E1 grades a feature: equal today);
 * yes_point_his_pct = where the step's price curve first reaches P(yes) 0.5 on his screen. */
const replyMix = obj({ ignore: prob, counter: prob, decline: prob, accept: prob });
const cpFeature = obj({ feature: str, effect: str }, { value: num, basis: str, player: id, n: num });
const stepCounterpart = obj({
  reply_mix: replyMix, p_accept_challenger: prob, p_accept_served: prob, yes_point_his_pct: nullable(num),
  reason_chain: arr(cpFeature)
}, { reply_mix_label: str });

/* NEGOTIATOR-DEFAULTS: the levers an offer uses (for grading by lever once offers are logged), the interest
 * check sent before it, how long it stands, when it is withdrawn, the second package and the anchor lift. */
const stepNegotiation = obj({
  levers: arr(oneOf(NEGOTIATION_LEVERS), { min: 1 }), feeler: str, expires_hours: int(1), withdraw_if: str
}, {
  alt_package: obj({ give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }) }, { his_pct: num, dice: oneOf(['confirm']), expected: num }),
  anchor: obj({ lifted: bool, floor_pct: num, from_pct: num, to_pct: num, defensible: bool }),
  cool_off: bool, alt_dropped: oneOf(ALT_DROP_REASONS)
});

/** One offer in a plan, with its playbook. */
const step = obj({
  partner: id,
  give: arr(pid, { min: 1 }),
  get: arr(pid, { min: 1 }),
  p_yes: probF,
  title_odds_delta: numF,
  title_after: probF,
  message: field(str),
  opening: field(obj({ give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }) }, { text: str })),
  walk_away: field(obj({ text: str, max_give: arr(pid) })),
  send_when: field(str),
  reply_table: field(obj({ accept: field(reply), decline: field(reply), counter: field(reply), silence: field(reply) }))
}, {
  reasoning: field(reasoning),
  // The acceptance band p_yes is the midpoint of; "I sent it" grades against it (#239 recordSentOffer).
  p_yes_band: obj({ low: prob, high: prob }, { basis: oneOf(['no_information', 'heuristic_unanchored', 'heuristic_anchored']) }),
  counterpart: field(stepCounterpart),
  // CAP-1C: the premium over the 0 cap on a depth-only 2-for-1, and the lineup / title gains that allowed it.
  depth_premium: field(obj({ pct: num, cap: num, lineup_points_delta: num, title_odds_delta: num, text: str },
    { confirmed_lineup_points_delta: num, confirmed_title_odds_delta: num })),
  // NEGOTIATOR-DEFAULTS (GRIDIRON_NEGOTIATOR_DEFAULTS, default off): how this offer is made, tagged by lever.
  negotiation: field(stepNegotiation)
});

/** A plan: one deck card. */
const move = obj({
  move_id: id,
  rank: int(1, MAX_ALTERNATIVES),
  target: nullable(pid),
  target_owner: nullable(id),
  chained: bool,
  steps: arr(step, { min: 1 }),
  p_complete: probF,
  delta_final: numF,
  expected: numF,
  reasoning: field(reasoning)
});

const destination = obj({
  goal: field(obj({ kind: oneOf(GOALS), label: str }, { player_id: pid, points_per_week: num })),
  risk_mode: field(obj({ mode: oneOf(RISK_MODES) }, { until_week: int(1, 18) })),
  tolerances: field(obj({}, Object.fromEntries(TOLERANCE_KEYS.map(k => [k, num])))),
  arrive_by: field(int(1, 18)),
  eta_week: field(int(1, 18)),
  title_now: probF,
  title_planned_now: probF,
  path: field(arr(obj({ week: int(1, 18), planned: num }, { actual: num }))),
  ground_lost: numF
});

const stop = obj({
  id: id, order: int(1), kind: oneOf(STOP_KINDS), label: str,
  status: oneOf(STOP_STATUSES), added_by: oneOf(['plan', 'nick', 'coach'])
}, { player_id: pid, week: int(1, 18), move_id: id, p_yes: probF, title_odds_delta: numF });

const tradeoff = obj({
  stop_label: str, cost: numF, extra_steps: int(0), gain: numF, net: numF,
  verdict: oneOf(['worth_it', 'not_worth_it', 'close']), because: str, new_next_move_changes: bool
}, { gain_text: str });

const flip = obj({
  player: pid, buy_from: id, sell_to: id, spread: numF, price_a: numF, price_b: numF,
  legs: nullable(obj({ give_a: pid, get_b: pid, p1: probF, p2: probF, p_both: probF, nick_after: numF },
    // FLIP-LEGS-2: the whole packages (give_a / get_b stay the lead id); served only when the planner priced packages.
    { give_a_ids: arr(pid, { min: 1 }), get_b_ids: arr(pid, { min: 1 }) }))
}, { legs_why_not: str, reasoning: field(reasoning) });

const readStatus = oneOf(['ok', 'none', 'unknown', 'unread']);
const players = obj({ players: arr(pid), n: int(0) });
/** HIS-SIDE-WIRE (campaign/his-side.js): the owner's needs, shops and blocks, each with its n. */
const hisSide = obj({
  reads: obj({ needs: readStatus, chat: readStatus, espn_block: readStatus, ledger: readStatus }),
  needs: arr(str), target_protected: bool, text: str
}, {
  espn_block: players, target_on_block: bool,
  shops: obj({ players: arr(pid), n: int(0), source: lit('chat') }),
  protects: obj({ players: arr(pid), n: int(0), credibility: nullable(obj({ value: num, n: int(0) })) }),
  wants: arr(pid),
  // The seller's floor (TRADE-MEMORY ledger): what he paid for this player this season, market value.
  floor: obj({ value: num, basis: str }),
  currency: obj({ wants: arr(str), sells: arr(str) })
});

const target = obj({
  player: pid, owner: id, gain_if_landed: numF, p_reach: probF,
  mode_fit: field(oneOf(['fits', 'needs_all_in', 'too_risky_for_safe'])),
  why: field(str), approved: bool, is_plan_target: bool
}, { reasoning: field(reasoning), his_side: field(hisSide) });

const brainReport = obj({
  overall: oneOf(['passing', 'not_enough_data', 'failing']),
  checks: arr(obj({
    id: oneOf(BRAIN_CHECK_IDS), name: str, bar: str,
    status: oneOf(['passing', 'not_enough_data', 'failing', 'running', 'not_run'])
  }, { result: str, n: int(0), as_of: iso })),
  blocks: arr(str)
}, { fell_back_to: lit('balanced') });

/** PLAYER-SCORE: one board row. Names are read at run time from the league (the plans file is local). */
const blueChipRow = obj({
  player: id, name: str, position: oneOf(['QB', 'RB', 'WR', 'TE']), mine: bool,
  score: int(0, 100), label: oneOf(SCORE_LABELS), hurt: bool,
  parts: obj({ pick_pct: int(0, 100), prod_basis: oneOf(['season_ppg', 'ros_ppg']), prod_pct: int(0, 100),
    games: int(0), team_games: int(0), missed: int(0) }, { pick: int(1), prod_value: num, pos_rank: int(1), pos_n: int(1) }),
  model_value: numF, fp_ros_rank: numF, gaps: arr(oneOf(SCORE_GAPS)), protected: bool
}, { owner: id, model_rank: int(1), fp_pos_rank: num, fp_rank: int(1), fp_prev_rank: int(1), title_add: numF });

/** Every section a league entry carries unless the whole run failed (`error`). */
export const SECTIONS = Object.freeze({
  attention: field(obj({ rank: int(1), of: int(1), reason: str })),
  destination: field(destination),
  feasibility: field(obj({
    points_per_week: num, projected_points: numF, p_hit: probF, by_week: field(int(1, 18))
  }, { cost_text: str })),
  // FEAS-140: the points question on a league planned on something else (title, playoffs,
  // get-player), as its own card next to `feasibility`; never nested in it. A points
  // league writes this as 'unknown' and keeps its answer in `feasibility`.
  feasibility_points: field(obj({
    points_per_week: num, league_objective: oneOf(['title', 'playoffs', 'get_player']),
    outlook: oneOf(['on_track', 'reachable', 'out_of_reach']),
    projected_points: numF, p_hit: probF, by_week: field(int(1, 18)),
    cost_players: int(0), cost_offers: int(0), objective_cost: numF,
    bye_warnings: int(0), injury_warnings: int(0)
  }, { cost_text: str })),
  finder_best_expected: numF,
  next_move: field(move),
  alternatives: field(arr(move, { max: MAX_ALTERNATIVES })),
  itinerary: field(obj({
    version: int(1), stops: arr(stop), stops_left: int(0), untouchables: arr(pid), conflicts: arr(obj({ text: str }))
  })),
  stop_tradeoffs: field(map(TRADEOFF_KEY, tradeoff)),
  flip_map: field(arr(flip)),
  targets: field(arr(target)),
  // kind / partner / discount (CATCHUP-LIVE) are optional: older producers omit them.
  catch_up: field(arr(obj({ text: str, gain: numF, steps: int(0) },
    { move_id: id, kind: oneOf(CATCHUP_KINDS), partner: id, discount_pct: numF }))),
  // lever / p_land / levers (CATCHUP-LIVE): the lever that wins week N and every lever priced there.
  speed_curve: field(arr(obj({
    arrive_by: int(1, 18), cost: numF, net: numF, variance_note: str, offers_used: int(0), before_deadline: bool
  }, { lever: oneOf(SPEED_LEVERS), p_land: probF,
    levers: arr(obj({ lever: oneOf(SPEED_LEVERS), cost: numF, p_land: probF, offers_used: int(0) })) }))),
  brain_report: field(brainReport),
  number_health: field(obj({
    overall: oneOf(NUMBER_HEALTH_STATUSES), broken: int(0), warn: int(0), ok: int(0),
    checks: arr(obj({ check_id: str, status: oneOf(NUMBER_HEALTH_STATUSES), title: str }, { detail: str, cause: str }))
  })),
  // The three modes' best plans on the same dice (the risk-mode sheet, north-star row 8).
  risk_modes: field(arr(obj({
    mode: oneOf(RISK_MODES), label: str, active: bool, expected: numF, if_complete: numF, p_complete: probF,
    first_step: nullable(obj({ partner: id, give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }) }))
  }, {
    // NO-TRADE-SHRINK: the do-nothing option beside the mode's best plan, and which one the mode's objective picks.
    no_trade: obj({ expected: numF, p_complete: probF, pick: oneOf(['plan', 'no_trade']), why: str })
  }))),
  // Who to deal with: P(responds) from activity x the best edge through him. Labels and counts only.
  partners: field(arr(obj({ team: id, p_responds: prob, basis: str, edge: numF }, {
    chat_labels: arr(str), roster_holes: arr(str), offers_logged: int(0), checked_out: bool, blocked: bool,
    // Nick's untouchables on his roster (profile-reader nick block): never a target, a get or a flip leg.
    untouchable: arr(pid),
    // ONE-COUNTERPART (RULINGS 17): P(responds) before the model, each named adjustment, the reply prior.
    p_responds_before_counterpart: prob, reason_chain: arr(cpFeature), reply_mix: replyMix
  }))),
  // TEAM-NAMES: who each roster is (ESPN team name, the manager Nick knows), read from the league
  // payload at run time and never committed. A roster left out (or the section unknown) reads 'Team N'.
  // Optional (OPTIONAL_SECTIONS): a file written before it still validates.
  teams: field(map(/^[A-Za-z0-9_.:-]{1,64}$/, obj({}, { name: str, manager: str }))),
  // PLAYER-SCORE (flag GRIDIRON_PLAYER_SCORE / preview): every rostered player and the top free agents,
  // scored 0-100 with a label, the engine's value, FantasyPros' rest-of-season rank and the gaps between them.
  // Optional (OPTIONAL_SECTIONS): a file written before it still validates.
  blue_chips: field(obj({
    weights: obj({ pick: num, production: num, basis: str }), labels: arr(oneOf(SCORE_LABELS)), rows: arr(blueChipRow),
    coverage: obj({ rostered: int(0), board: int(0), score: prob, model_value: prob, fp_ros_rank: prob }),
    fp: obj({ status: oneOf(STATUSES), sync: str }, { reason: str, scrape_date: str, prev_date: str }),
    draft: obj({ season: int(2000, 2100), picks: int(0) }, { reason: str })
  })),
  // LADDER-01 (flag GRIDIRON_LADDER, default off): chained paths depth -> level below -> blue chip, P(yes)
  // per rung (a guess), what a "no" leaves at each rung. Shadow: never re-ranks the deck. Optional.
  ladders: field(obj({
    mode: oneOf(RISK_MODES), floor: num, rank_basis: str, dice: oneOf(['planning']), basis: str, considered: int(0),
    dropped_by_reason: map(/^[a-z_]{1,40}$/, int(0)),
    cards: arr(obj({
      target: pid, owner: id, climb: arr(oneOf(LADDER_TIERS), { min: 2 }), rank_basis: str,
      rungs: arr(obj({
        partner: id, give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }), get_tier: oneOf(LADDER_TIERS), p: probF, if_yes: numF,
        on_no: obj({ kind: oneOf(['backup', 'stop']) }, { partner: id, give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }), expected: numF, keep: numF,
          dice: oneOf(['confirm']) })
      }), { min: 2 }),
      p_complete: probF, if_complete: numF, expected: numF, confirmed_expected: numF
    }), { max: 5 })
  })),
  // LIVE-BLEND: which P(yes) the steps serve. Blend: per model its served weight, prior, n, mean log
  // loss and wins/losses vs the baseline over every league's graded offers ("clone 3-1 vs baseline,
  // 30% weight"). Fallback: why the clone band is served. Optional (OPTIONAL_SECTIONS).
  p_yes_basis: field(obj({ mode: oneOf(['blend', 'baseline']), source: str, label: str }, {
    fallback: str, n_graded: int(0), league_n: int(0), lambda: prob, shrink_k: num, clamp: arr(prob, { min: 2, max: 2 }),
    as_of: str, activity: str,
    models: arr(obj({ id: oneOf(['baseline', 'clone']), weight: prob, prior_weight: prob, n: int(0), log_loss: nullable(num) },
      { wins: int(0), losses: int(0) }))
  }))
});

/** Sections an entry may leave out; the view then reads them as unknown. */
export const OPTIONAL_SECTIONS = Object.freeze(['teams', 'blue_chips', 'ladders', 'p_yes_basis']);

/** Run bookkeeping: the producer's own memory between runs. No consumer reads it. */
const run = obj({
  seed: json, confirm_seed: json, week: nullable(int(1, 18)), deadline_week: nullable(int(1, 18)), behind: bool,
  objective_version: int(0), objective_source: str, risk_mode: oneOf(RISK_MODES),
  next_step: json, trajectory: arr(obj({ week: int(1, 18), planned: num })),
  changed: obj({ changed: bool, reason: str }, { previous_key: nullable(str), next_key: str }),
  roster_key: nullable(str), confirm: json, outlook: json, feasibility_detail: json, feasibility_points_detail: json,
  candidates_scored: int(0), rescores: int(0), runtime_ms: num, phases_ms: json, inputs: json
}, {
  dropped_by_reason: json, trade_memory: json,
  // NO-TRADE-SHRINK: the shadow pre-rank shrinkage report (modes.js#shadowShrink). Optional: older files validate.
  shrink: json
});

const league = obj(
  { league: int(1), me: id, names: map(/^[A-Za-z0-9_.:-]{1,64}$/, str) },
  { error: str, sanity_composed_equals_direct: bool, _run: run, ...SECTIONS }
);

const HEAD = { schema: lit(SCHEMA_VERSION), generated_at: iso, producer: str, producer_version: str };

export const PLANS_SCHEMA = obj({ ...HEAD, leagues: arr(league) });

/* ------------------------------------------------------------ validator */

const FIELD_META = ['status', 'reason', 'source', 'se', 'clears_2se', 'as_of', 'n', 'unit', 'guess'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/;

function check(node, v, path, ctx) {
  const err = msg => ctx.errors.push({ path, message: msg });
  switch (node.t) {
    case 'str': if (typeof v !== 'string' || !v.trim()) err('must be a non-empty string'); return;
    case 'iso': if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) err('must be an ISO date string'); return;
    case 'bool': if (typeof v !== 'boolean') err('must be true or false'); return;
    case 'num': if (typeof v !== 'number' || !Number.isFinite(v)) err('must be a finite number'); return;
    case 'prob': if (typeof v !== 'number' || !(v >= 0 && v <= 1)) err('must be a probability from 0 to 1'); return;
    case 'int':
      if (!Number.isInteger(v) || v < node.min || v > node.max) err(`must be a whole number from ${node.min} to ${node.max}`);
      return;
    case 'id': case 'pid':
      if (typeof v !== 'string' || !ID_RE.test(v)) { err('must be an id string'); return; }
      if (node.t === 'pid' && ctx.names && !Object.hasOwn(ctx.names, v)) err(`player ${v} is not in this league's names`);
      return;
    case 'json': if (v === undefined || typeof v === 'function') err('must be a JSON value'); return;
    case 'lit': if (v !== node.v) err(`must be ${JSON.stringify(node.v)}`); return;
    case 'enum': if (!node.values.includes(v)) err(`must be one of ${node.values.join(', ')}`); return;
    case 'nullable': if (v !== null) check(node.inner, v, path, ctx); return;
    case 'arr':
      if (!Array.isArray(v)) { err('must be a list'); return; }
      if (v.length < node.min) err(`must have at least ${node.min} item(s)`);
      if (v.length > node.max) err(`must have at most ${node.max} items`);
      v.forEach((x, i) => check(node.item, x, `${path}[${i}]`, ctx));
      return;
    case 'map':
      if (!isObj(v)) { err('must be an object'); return; }
      for (const [k, x] of Object.entries(v)) {
        if (!node.key.test(k)) ctx.errors.push({ path: `${path}.${k}`, message: 'key does not match the contract' });
        check(node.value, x, `${path}.${k}`, ctx);
      }
      return;
    case 'obj': {
      if (!isObj(v)) { err('must be an object'); return; }
      for (const [k, sub] of Object.entries(node.req)) {
        if (!(k in v)) ctx.errors.push({ path: `${path}.${k}`, message: 'is required' });
        else check(sub, v[k], `${path}.${k}`, ctx);
      }
      for (const [k, x] of Object.entries(v)) {
        if (k in node.req) continue;
        if (k in node.opt) check(node.opt[k], x, `${path}.${k}`, ctx);
        else ctx.errors.push({ path: `${path}.${k}`, message: 'is not in the contract' });
      }
      return;
    }
    case 'field': {
      if (!isObj(v) || !('status' in v)) { err('must be a typed field { status, source, ... }'); return; }
      for (const k of Object.keys(v)) {
        if (k !== 'value' && !FIELD_META.includes(k)) ctx.errors.push({ path: `${path}.${k}`, message: 'is not a typed-field key' });
      }
      if (!STATUSES.includes(v.status)) { err(`status must be one of ${STATUSES.join(', ')}`); return; }
      if (!SOURCE_IDS.includes(v.source)) err(`source must be one of ${SOURCE_IDS.join(', ')}`);
      if ('se' in v && !(typeof v.se === 'number' && v.se >= 0)) err('se must be a number >= 0');
      if ('clears_2se' in v && typeof v.clears_2se !== 'boolean') err('clears_2se must be true or false');
      if ('as_of' in v) check(iso, v.as_of, `${path}.as_of`, ctx);
      if ('n' in v) check(int(0), v.n, `${path}.n`, ctx);
      if ('unit' in v && !UNITS.includes(v.unit)) err(`unit must be one of ${UNITS.join(', ')}`);
      if ('guess' in v && typeof v.guess !== 'boolean') err('guess must be true or false');
      if (v.status === 'ok') {
        if (!('value' in v)) err("an 'ok' field must carry a value");
        else check(node.inner, v.value, `${path}.value`, ctx);
      } else {
        if ('value' in v) err(`a '${v.status}' field must not carry a value`);
        if (typeof v.reason !== 'string' || !v.reason.trim()) err(`a '${v.status}' field must say why in reason`);
      }
      return;
    }
    default: throw new Error(`plans-schema: unknown node ${node.t}`);
  }
}

const okValue = f => (isObj(f) && f.status === 'ok' ? f.value : undefined);

/** Cross-key rules a shape check cannot see. */
function crossCheck(entry, path, ctx) {
  const err = (p, message) => ctx.errors.push({ path: `${path}.${p}`, message });
  if (entry.error === undefined) {
    for (const k of Object.keys(SECTIONS)) {
      if (!(k in entry) && !OPTIONAL_SECTIONS.includes(k)) err(k, "is required (write it as 'unknown' with a reason when it is not computed)");
    }
  }
  const deck = okValue(entry.alternatives);
  if (Array.isArray(deck)) {
    const seen = new Set();
    deck.forEach((m, i) => {
      if (m?.rank !== i + 1) err(`alternatives.value[${i}].rank`, `must be ${i + 1}: the deck is written best first`);
      if (seen.has(m?.move_id)) err(`alternatives.value[${i}].move_id`, 'is used twice in the deck');
      seen.add(m?.move_id);
    });
  }
  const next = okValue(entry.next_move);
  if (next && Array.isArray(deck) && deck.length && next.move_id !== deck[0]?.move_id) {
    err('next_move.value.move_id', 'must be the head of the deck (alternatives.value[0].move_id)');
  }
  if (next && entry.alternatives?.status === 'ok' && Array.isArray(deck) && !deck.length) {
    err('next_move', 'is ok but the deck is empty');
  }
}

/**
 * Validate a whole plans file.
 * @returns {{ ok: boolean, errors: { path: string, message: string }[] }}
 */
export function validatePlans(doc) {
  const ctx = { errors: [], names: null };
  if (!isObj(doc)) return { ok: false, errors: [{ path: '$', message: 'must be an object with leagues[]' }] };
  const { leagues, ...head } = doc;
  check(obj(HEAD), head, '$', ctx);
  if (!Array.isArray(leagues)) {
    ctx.errors.push({ path: '$.leagues', message: 'must be a list of league entries' });
    return { ok: false, errors: ctx.errors };
  }
  const seen = new Set();
  leagues.forEach((entry, i) => {
    const r = validateLeague(entry, `$.leagues[${i}]`);
    ctx.errors.push(...r.errors);
    if (seen.has(entry?.league)) ctx.errors.push({ path: `$.leagues[${i}].league`, message: 'is listed twice' });
    seen.add(entry?.league);
  });
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

/** Validate one league entry. */
export function validateLeague(entry, path = '$.leagues[0]') {
  const ctx = { errors: [], names: isObj(entry?.names) ? entry.names : null };
  check(league, entry, path, ctx);
  if (isObj(entry)) crossCheck(entry, path, ctx);
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

/* ---------------------------------------------------------------- paths */

/**
 * Every path a producer may write, in one notation: `.key` for an object key,
 * `[]` for a list item, `{}` for a map entry, and a typed field's value under
 * `.value`. Example: `leagues[].alternatives.value[].steps[].p_yes.value`.
 */
export function schemaPaths() {
  const out = new Set();
  const walk = (node, p) => {
    if (p) out.add(p);
    switch (node.t) {
      case 'nullable': walk(node.inner, p); return;
      case 'arr': walk(node.item, `${p}[]`); return;
      case 'map': walk(node.value, `${p}{}`); return;
      case 'obj':
        for (const [k, sub] of [...Object.entries(node.req), ...Object.entries(node.opt)]) walk(sub, p ? `${p}.${k}` : k);
        return;
      case 'field':
        for (const k of FIELD_META) out.add(`${p}.${k}`);
        walk(node.inner, `${p}.value`);
        return;
      default:
    }
  };
  walk(PLANS_SCHEMA, '');
  return out;
}

/** The same notation for a concrete document: which contract paths it actually writes. */
export function writtenPaths(doc) {
  const out = new Set();
  const walk = (v, p) => {
    if (p) out.add(p);
    if (Array.isArray(v)) { v.forEach(x => walk(x, `${p}[]`)); return; }
    if (!isObj(v)) return;
    // The two maps: their keys are data, not contract keys.
    if (/(^|\.)stop_tradeoffs\.value$|^leagues\[\]\.names$|^leagues\[\]\.teams\.value$/.test(p)) { for (const x of Object.values(v)) walk(x, `${p}{}`); return; }
    for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(doc, '');
  return out;
}
