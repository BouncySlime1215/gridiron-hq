/**
 * CAMPAIGN-PEOPLE: the counterpart model (pure). PEOPLE-WIRING.md, section
 * CAMPAIGN-PEOPLE: one model per league-4 manager, used at every campaign step.
 *
 *   1 targets      targetWeight      sells if frustrated / urgent / wants what Nick has; untouchables skipped
 *   2 partners     respondsWeight    P(responds) x edge; contactable:false EXCLUDED; buyer:false down;
 *                                    "hard to deal with" down
 *   3 price        yesShift          his yes-point moved by values_talk; hard -> stricter walk-away
 *   4 package      packageWeight     include what he wants, avoid what he talks down, never an untouchable
 *   5 message      framing           style / bait / techniques; face-safe by construction
 *   6 reply tree   replyNotes        his "no" style, what shuts him down, posture; patient when hard
 *   7 timing       timing            send in an urgency window, wait while attached / after a win
 *   8 simulation   acceptModel       the planner's opponent model: accept / counter / decline per offer
 *   9 replanning   profileChanges    a changed profile version is a replan event
 *  10 reasoning    hisSide           trait labels (no quotes) + every feature applied
 *
 * Honesty rule: every people adjustment is a FEATURE { feature, trait, weight, effect, step, source }
 * and goes into the reason chain. Weights are hand-set, not fitted (EVAL E1/E2/C7 pending); a
 * trait that does not earn weight in grading fades by editing WEIGHTS, nowhere else.
 */
import { UNKNOWN, readProfile } from '../people/profile-adapter.js';

export const WEIGHTS_LABEL = 'hand-set people weight; ungraded (EVAL E1/E2/C7 pending)';
export const WEIGHTS = Object.freeze({
  target_frustrated: 1.3, target_urgent: 1.15, target_wants_mine: 1.2,
  respond_urgency_high: 1.25, respond_urgency_low: 0.85,
  respond_ghoster: 0.6, respond_quick: 1.15, respond_not_buyer: 0.5, respond_hard: 0.85,
  accept_hard: 0.8,
  shift_get_talked_up: 10, shift_give_talked_up: -8, shift_get_talked_down: -6, shift_hard: 5,
  /** P(accept) change per point of yes-shift on his screen. */
  shift_to_p: 0.03,
  walk_away_hard_margin: 0.15,
  package_wants: 1.2, package_dislike: 0.75,
  counter_haggler: 0.35, counter_default: 0.15,
  patience_hard: 2, patience_ghoster: 2,
  wait_attached_days: 3, wait_just_won_days: 2,
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const has = (list, id) => (list ?? []).some(x => String(x) === String(id));
const src = (cp, key) => cp.profile.sources?.[key] ?? 'profile';

function feat(cp, step, feature, key, trait, weight, effect) {
  return { step, feature: `people.${feature}`, trait, weight, effect, source: src(cp, key), label: WEIGHTS_LABEL };
}

/** Build the model for one manager. profile: typed profile (profile-adapter), or a raw one. */
export function buildCounterpart(team, profile, extra = {}) {
  const p = profile?.sources ? profile : readProfile(profile ?? null);
  return { team: String(team), profile: p, known: p.status === 'ok', ...extra };
}

/** Map team -> counterpart from adapter.managers (each carries `people`: typed or raw profile). */
export function buildCounterparts(managers) {
  const out = new Map();
  for (const [t, m] of managers ?? []) out.set(String(t), buildCounterpart(t, m?.people ?? null));
  return out;
}

/* 1 --------------------------------------------------------------- targets */

/** Weight on "ask for player `pid` from this owner". nickPositions: positions Nick can give. */
export function targetWeight(cp, pid, { nickPlayers = [], nickPositions = [] } = {}) {
  if (!cp?.known) return { w: 1, skip: false, features: [] };
  const P = cp.profile, f = [];
  if (has(P.untouchable, pid)) {
    return { w: 0, skip: true, features: [feat(cp, 'targets', 'untouchable', 'untouchable', 'untouchable', 0, 'skipped: he will not sell (face cost)')] };
  }
  let w = 1;
  if (has(P.frustrated_with, pid)) { w *= WEIGHTS.target_frustrated; f.push(feat(cp, 'targets', 'frustrated_with', 'frustrated_with', 'frustrated with player', WEIGHTS.target_frustrated, `target x${WEIGHTS.target_frustrated}`)); }
  if (P.urgency === 'high') { w *= WEIGHTS.target_urgent; f.push(feat(cp, 'targets', 'urgency', 'urgency', 'urgency high', WEIGHTS.target_urgent, `target x${WEIGHTS.target_urgent}`)); }
  const wantsMine = nickPlayers.some(id => has(P.wants_players, id)) || nickPositions.some(pos => has(P.wants_positions, pos));
  if (wantsMine) { w *= WEIGHTS.target_wants_mine; f.push(feat(cp, 'targets', 'wants', 'wants_positions', 'wants what you have', WEIGHTS.target_wants_mine, `target x${WEIGHTS.target_wants_mine}`)); }
  return { w, skip: false, features: f };
}

/* 2 --------------------------------------------------------------- partners */

/** Multiplier on P(responds). contactable:false -> excluded (p 0). */
export function respondsWeight(cp) {
  if (!cp?.known) return { w: 1, excluded: false, features: [] };
  const P = cp.profile, f = [];
  if (P.contactable === false) {
    return { w: 0, excluded: true, reason: 'not contactable', features: [feat(cp, 'partners', 'contactable', 'contactable', 'not contactable', 0, 'excluded from every plan')] };
  }
  let w = 1;
  const mul = (x, feature, key, trait) => { w *= x; f.push(feat(cp, 'partners', feature, key, trait, x, `p_responds x${x}`)); };
  if (P.urgency === 'high') mul(WEIGHTS.respond_urgency_high, 'urgency', 'urgency', 'urgency high');
  if (P.urgency === 'low') mul(WEIGHTS.respond_urgency_low, 'urgency', 'urgency', 'urgency low');
  if (P.posture === 'ghoster') mul(WEIGHTS.respond_ghoster, 'posture', 'posture', 'ghoster');
  if (P.posture === 'quick') mul(WEIGHTS.respond_quick, 'posture', 'posture', 'answers quickly');
  if (P.buyer === false) mul(WEIGHTS.respond_not_buyer, 'buyer', 'buyer', 'not a buyer');
  if (P.hard_to_deal_with === true) mul(WEIGHTS.respond_hard, 'hard_to_deal_with', 'hard_to_deal_with', 'hard to deal with');
  return { w, excluded: false, features: f };
}

/* 3 + 4 ------------------------------------------------------ price, package */

/**
 * How far his yes-point moves, in % on his screen (+ = he needs more to say yes).
 * give / get are from HIS side: `give` = what he gives (Nick gets), `get` = what he gets.
 */
export function yesShift(cp, { give = [], get = [] } = {}) {
  if (!cp?.known) return { shift: 0, features: [] };
  const P = cp.profile, f = [];
  let s = 0;
  const add = (x, feature, key, trait) => { s += x; f.push(feat(cp, 'price', feature, key, trait, x, `yes-point ${x > 0 ? '+' : ''}${x}%`)); };
  for (const id of give) if (has(P.talks_up, id)) add(WEIGHTS.shift_get_talked_up, 'values_talk', 'talks_up', 'hypes a player you ask for');
  for (const id of get) if (has(P.talks_up, id)) add(WEIGHTS.shift_give_talked_up, 'values_talk', 'talks_up', 'hypes a player you offer');
  for (const id of give) if (has(P.talks_down, id)) add(WEIGHTS.shift_get_talked_down, 'values_talk', 'talks_down', 'talks down a player you ask for');
  if (P.hard_to_deal_with === true) add(WEIGHTS.shift_hard, 'hard_to_deal_with', 'hard_to_deal_with', 'hard to deal with');
  return { shift: s, features: f };
}

/** Package fit: his wants in, his dislikes out, untouchables never. Same side convention as yesShift. */
export function packageWeight(cp, { give = [], get = [] } = {}, players = null) {
  if (!cp?.known) return { w: 1, excluded: false, features: [] };
  const P = cp.profile, f = [];
  if (give.some(id => has(P.untouchable, id))) {
    return { w: 0, excluded: true, features: [feat(cp, 'package', 'untouchable', 'untouchable', 'asks for an untouchable', 0, 'package excluded (face cost)')] };
  }
  let w = 1;
  const pos = id => players?.get?.(id)?.position ?? players?.get?.(Number(id))?.position ?? null;
  if (get.some(id => has(P.wants_players, id) || has(P.wants_positions, pos(id)))) {
    w *= WEIGHTS.package_wants; f.push(feat(cp, 'package', 'wants', 'wants_players', 'includes what he wants', WEIGHTS.package_wants, `p_accept x${WEIGHTS.package_wants}`));
  }
  if (get.some(id => has(P.talks_down, id))) {
    w *= WEIGHTS.package_dislike; f.push(feat(cp, 'package', 'talks_down', 'talks_down', 'includes a player he talks down', WEIGHTS.package_dislike, `p_accept x${WEIGHTS.package_dislike}`));
  }
  return { w, excluded: false, features: f };
}

/* 8 ------------------------------------------------------------- simulation */

/**
 * The opponent model: base P(accept) from today's model -> his accept / counter / decline.
 * give/get from his side. Returns { p, p_counter, p_decline, features }.
 */
export function acceptModel(cp, baseP, deal, players = null) {
  const pk = packageWeight(cp, deal, players);
  if (pk.excluded) return { p: 0, p_counter: 0, p_decline: 1, features: pk.features };
  const ys = yesShift(cp, deal);
  let p = baseP * pk.w * Math.exp(-WEIGHTS.shift_to_p * ys.shift);
  const f = [...pk.features, ...ys.features];
  if (cp?.known && cp.profile.hard_to_deal_with === true) {
    p *= WEIGHTS.accept_hard;
    f.push(feat(cp, 'simulation', 'hard_to_deal_with', 'hard_to_deal_with', 'hard to deal with', WEIGHTS.accept_hard, `p_accept x${WEIGHTS.accept_hard}`));
  }
  p = clamp(p, 0, 0.97);
  const counterRate = cp?.known && cp.profile.posture === 'haggler' ? WEIGHTS.counter_haggler : WEIGHTS.counter_default;
  const p_counter = (1 - p) * counterRate;
  return { p, p_counter, p_decline: 1 - p - p_counter, features: f };
}

/** Wrap priceStep(team, theyGive, theyGet) with the counterpart models; excluded teams price at 0. */
export function withOpponentModel(priceStep, counterparts, players = null) {
  return (team, theyGive, theyGet) => {
    const base = priceStep(team, theyGive, theyGet);
    const cp = counterparts.get(String(team));
    if (!cp?.known) return base;
    if (respondsWeight(cp).excluded) return { ...base, p: 0, people: [] };
    const m = acceptModel(cp, base.p, { give: theyGive, get: theyGet }, players);
    return { ...base, p: m.p, p_base: base.p, p_counter: m.p_counter, people: m.features };
  };
}

/** Curve points on his screen after his yes-shift; `his_pct_market` keeps the raw number. */
export function shiftCurve(cp, curve, theyGive) {
  if (!cp?.known) return { curve, features: [] };
  let features = [];
  const out = curve.map(c => {
    const ys = yesShift(cp, { give: theyGive, get: c.give });
    if (ys.features.length > features.length) features = ys.features;
    return { ...c, his_pct_market: c.his_pct, his_pct: c.his_pct - ys.shift };
  });
  return { curve: out, features };
}

/** Stricter walk-away for a hard counterpart: the deal must beat the BATNA by a margin. */
export function strictBatna(cp, batna) {
  if (!cp?.known || cp.profile.hard_to_deal_with !== true) return { batna, features: [] };
  const b = batna + Math.abs(batna) * WEIGHTS.walk_away_hard_margin;
  return { batna: b, features: [feat(cp, 'price', 'hard_to_deal_with', 'hard_to_deal_with', 'hard to deal with', WEIGHTS.walk_away_hard_margin, `walk-away must beat backup by ${WEIGHTS.walk_away_hard_margin * 100}%`)] };
}

/* 5 -------------------------------------------------------------- message */

const OPENERS = Object.freeze({
  numbers: 'Ran the numbers on this one and it lines up for both of us.',
  need: 'Saw a spot on your roster this could help with.',
  casual: 'Got an idea that could work for both of us.',
  direct: 'Straight offer:',
  [UNKNOWN]: null,
});
/** Phrases a face-safe message never contains (public loss, gloating, pressure). */
export const FACE_UNSAFE = Object.freeze([/\bwin(s|ning)? (the|this) trade\b/i, /\blos(e|t|ing) (the|this) trade\b/i,
  /\bfleece/i, /\brip(ped)? off\b/i, /\beveryone (will|can) see\b/i, /\blast chance\b/i, /\bor else\b/i, /\bdesperate\b/i]);
export const faceSafe = text => !FACE_UNSAFE.some(re => re.test(String(text ?? '')));

/** Framing for his message: opener + bait line + what to avoid. offer.give = Nick gives. */
export function framing(cp, offer, players = null) {
  if (!cp?.known) return { opener: null, bait: null, avoid: [], techniques: [], face_safe: true, features: [] };
  const P = cp.profile, f = [];
  const opener = OPENERS[P.approach_style] ?? null;
  if (opener) f.push(feat(cp, 'message', 'how_to_approach', 'approach_style', `approach: ${P.approach_style}`, 1, 'opener chosen'));
  const name = id => players?.get?.(id)?.name ?? players?.get?.(Number(id))?.name ?? `player ${id}`;
  const pos = id => players?.get?.(id)?.position ?? players?.get?.(Number(id))?.position ?? null;
  const baitId = (offer?.give ?? []).find(id => has(P.bait_players, id) || has(P.wants_players, id) || has(P.wants_positions, pos(id)));
  const bait = baitId != null ? `${name(baitId)} is in it.` : null;
  if (bait) f.push(feat(cp, 'message', 'best_bait', 'bait_players', 'leads with what he wants', 1, 'bait line added'));
  if (P.face === 'high') f.push(feat(cp, 'message', 'face', 'face', 'face matters', 1, 'private, no public-loss framing'));
  return { opener, bait, avoid: P.shuts_down ?? [], techniques: P.techniques ?? [], face_safe: true, features: f };
}

/** Apply a framing to a playbook message; drops any line that would not be face-safe. */
export function frameMessage(message, fr) {
  const lines = [fr.opener, message.text, fr.bait].filter(Boolean).filter(faceSafe);
  return { ...message, text: lines.join(' '), framing: { avoid: fr.avoid, techniques: fr.techniques, face_safe: lines.every(faceSafe) } };
}

/* 6 ------------------------------------------------------------ reply tree */

/** Annotate the replyTable rows with his "no" style, what shuts him down, posture and patience. */
export function replyNotes(cp, rows) {
  if (!cp?.known) return { rows, features: [] };
  const P = cp.profile, f = [];
  const patience = (P.hard_to_deal_with === true ? WEIGHTS.patience_hard : 1) * (P.posture === 'ghoster' ? WEIGHTS.patience_ghoster : 1);
  if (patience > 1) f.push(feat(cp, 'replies', P.hard_to_deal_with ? 'hard_to_deal_with' : 'posture', P.hard_to_deal_with ? 'hard_to_deal_with' : 'posture',
    P.hard_to_deal_with ? 'hard to deal with' : 'ghoster', patience, `reply clock x${patience}`));
  const out = rows.map(r => {
    if (r.kind === 'decline') {
      const note = P.no_holds === 'rarely' ? 'His no rarely holds: wait a day, then re-offer once at the next rung.'
        : P.no_holds === 'yes' ? 'His no holds: go straight to the backup.' : null;
      if (note) f.push(feat(cp, 'replies', 'says_no', 'no_holds', `no holds: ${P.no_holds}`, 1, 'decline branch set'));
      return note ? { ...r, people_note: note } : r;
    }
    if (r.kind === 'counter') {
      const note = P.posture === 'haggler' ? 'Expect a counter asking for one more piece: answer with the next rung, never the walk-away first.' : null;
      if (note) f.push(feat(cp, 'replies', 'posture', 'posture', 'haggler', WEIGHTS.counter_haggler, 'counter branch set'));
      return { ...r, ...(note ? { people_note: note } : {}), avoid: P.shuts_down ?? [] };
    }
    if (r.kind === 'silence' && patience > 1) {
      return { ...r, people_note: `Be patient: nudge after ${24 * patience} h, switch after ${48 * patience} h.`,
        nudge_hours: 24 * patience, switch_hours: 48 * patience };
    }
    return r;
  });
  return { rows: out, features: f };
}

/* 7 ---------------------------------------------------------------- timing */

/** { when: 'now'|'wait'|null, why, until?, features }. null when the profile says nothing. */
export function timing(cp, nowMs) {
  if (!cp?.known) return { when: null, features: [] };
  const P = cp.profile;
  const win = (P.urgency_windows ?? []).find(w => Date.parse(w.from) <= nowMs && nowMs <= Date.parse(w.to));
  if (win) return { when: 'now', why: `his urgency window is open (${win.why})`, features: [feat(cp, 'timing', 'urgency_window', 'urgency_windows', win.why, 1, 'send now')] };
  if (P.just_won_trade === true) {
    return { when: 'wait', days: WEIGHTS.wait_just_won_days, why: 'he just won a trade', features: [feat(cp, 'timing', 'just_won_trade', 'just_won_trade', 'just won a trade', WEIGHTS.wait_just_won_days, 'wait')] };
  }
  if (P.attached === true) {
    return { when: 'wait', days: WEIGHTS.wait_attached_days, why: 'he is attached to his roster right now', features: [feat(cp, 'timing', 'attached', 'attached', 'attached', WEIGHTS.wait_attached_days, 'wait')] };
  }
  if (P.urgency === 'high') return { when: 'now', why: 'his urgency is high', features: [feat(cp, 'timing', 'urgency', 'urgency', 'urgency high', 1, 'send now')] };
  return { when: null, features: [] };
}

/* 9 ------------------------------------------------------------- replanning */

export const profileVersions = counterparts => Object.fromEntries([...counterparts]
  .map(([t, cp]) => [t, cp.known ? String(cp.profile.version ?? cp.profile.as_of ?? 'unversioned') : UNKNOWN]));

/** Teams whose profile version changed since the previous plan (a replan event). */
export function profileChanges(prevVersions, nextVersions) {
  if (!prevVersions || !nextVersions) return [];
  return Object.keys(nextVersions).filter(t => prevVersions[t] !== undefined && prevVersions[t] !== nextVersions[t]).sort();
}

/* 10 ------------------------------------------------------------- reasoning */

/** "His side of the table": trait labels only (no quotes) and where each came from. */
export function hisSide(cp) {
  if (!cp?.known) return { status: UNKNOWN, traits: [], reason: 'no profile for this manager (thin chat): no people adjustments' };
  const P = cp.profile, t = [];
  const push = (key, label) => t.push({ key, label, source: src(cp, key) });
  if (P.urgency !== UNKNOWN) push('urgency', `urgency ${P.urgency}`);
  if (P.posture !== UNKNOWN) push('posture', P.posture);
  if (P.no_holds !== UNKNOWN) push('no_holds', `his no ${P.no_holds === 'yes' ? 'holds' : `${P.no_holds} holds`}`);
  if (P.face !== UNKNOWN) push('face', `face ${P.face}`);
  if (P.hard_to_deal_with === true) push('hard_to_deal_with', 'hard to deal with');
  if (P.buyer === false) push('buyer', 'not a buyer');
  if (P.contactable === false) push('contactable', 'not contactable');
  if (P.approach_style !== UNKNOWN) push('approach_style', `approach: ${P.approach_style}`);
  for (const s of P.shuts_down ?? []) push('shuts_down', `shut down by: ${s}`);
  return { status: 'ok', traits: t, as_of: P.as_of, version: P.version, override_fields: P.override_fields };
}
