/**
 * NEGOTIATOR-DEFAULTS (ONE-PLAN 4d, night 1): how every offer is made, as rules (pure).
 *
 *   defensibleLadder  the opening is never more than ANCHOR_FLOOR_PCT under even on HIS screen:
 *                     a lower opening is lifted to the first rung at or above the floor (no
 *                     door-in-the-face). The walk-away never moves.
 *   secondPackage     a second genuine package: a different give, within ANCHOR_FLOOR_PCT of the
 *                     opening on his screen, that also beats the backup (every ladder rung does).
 *                     The planner serves it only when the plan with that give passes the same rules as a
 *                     served plan: overpay cap, held floor, trade memory and main's confirm-dice gate
 *                     (planner.js confirmAlt); else `alt_dropped` says why.
 *   whyLine           one line on why it helps HIM (his engine-read hole, else what the player adds).
 *   firmOfferText     plain and firm: the why line, the package(s), "fair for both of us", the
 *                     expiry, an easy no. Never "open to tweaking".
 *   feelerText        the interest check before a formal proposal; names only the player he gives.
 *   pressureTactics   fake scarcity and ultimatum phrases; every outgoing text must have none.
 *   coolOff           he lost last week: wait COOL_OFF_HOURS, then a fair offer. Replaces the
 *                     post-loss "tilt window" (the adapter also drops its P(yes) boost).
 *
 * Switch: GRIDIRON_NEGOTIATOR_DEFAULTS=1 only (not the preview switch), read from the env the caller
 * passes (planner settings.env). The anchor lift and the cool-off move what Nick is told to send, and the
 * adapter's cool-off drops the post-loss receptiveness term, so P(yes) moves for a manager who just lost.
 * Nothing here is measured on real offers yet. The no-trade row per mode is modes.js#noTradeRow (NO-TRADE-SHRINK).
 * Every step it touches carries `levers`, so offers can be graded by lever once they are logged.
 *
 * Hand-set, not fitted: ANCHOR_FLOOR_PCT (the his-screen "even" band, messages.js EVEN_PCT),
 * OFFER_HOURS (playbook.js SWITCH_HOURS: the offer is withdrawn then anyway), COOL_OFF_HOURS,
 * and the wording. External evidence only (ONE-PLAN spot-check row 18); 0 graded offers of ours.
 */
import { SWITCH_HOURS } from './playbook.js';
import { NEGOTIATION_LEVERS } from './plans-schema.js';
import { nickOverpays } from './search.js';

export const NEGOTIATOR_DEFAULTS_ENV = 'GRIDIRON_NEGOTIATOR_DEFAULTS';
export const negotiatorDefaultsOn = (env = {}) => env?.[NEGOTIATOR_DEFAULTS_ENV] === '1';

export const ANCHOR_FLOOR_PCT = 5;
export const OFFER_HOURS = SWITCH_HOURS;
export const COOL_OFF_HOURS = 24;
export const LEVERS = NEGOTIATION_LEVERS;
export const WITHDRAW_IF = 'news lands on any player in the deal before he answers (injury status, role change, a trade): '
  + 'withdraw the offer at once; the plan re-prices it on the next refresh';

const HOUR = 3600 * 1000;
const sameSet = (a, b) => a.length === b.length && a.map(String).sort().join() === b.map(String).sort().join();

/** priceLadder result -> the same ladder with a defensible opening, plus `anchor` (null when nothing is priced). */
export function defensibleLadder(ladder, { floorPct = ANCHOR_FLOOR_PCT } = {}) {
  if (!ladder?.opening || !ladder.walk_away) return { ...ladder, anchor: null };
  const from = ladder.opening.his_pct;
  if (from >= -floorPct) return { ...ladder, anchor: { lifted: false, floor_pct: floorPct, from_pct: from, to_pct: from, defensible: true } };
  const rungs = [...(ladder.ladder ?? [])].sort((a, b) => a.his_pct - b.his_pct);
  const lifted = rungs.find(c => c.his_pct >= -floorPct && c.his_pct <= ladder.walk_away.his_pct);
  const opening = lifted ?? ladder.walk_away;
  return {
    ...ladder, opening,
    ladder: rungs.filter(c => c.his_pct >= opening.his_pct),
    anchor: { lifted: true, floor_pct: floorPct, from_pct: from, to_pct: opening.his_pct, defensible: !!lifted },
  };
}

/** A second genuine package beside the opening, or null. */
export function secondPackage(ladder, { floorPct = ANCHOR_FLOOR_PCT } = {}) {
  const o = ladder?.opening;
  if (!o) return null;
  const alts = (ladder.ladder ?? []).filter(c => !sameSet(c.give, o.give)
    && c.his_pct >= -floorPct && Math.abs(c.his_pct - o.his_pct) <= floorPct);
  if (!alts.length) return null;
  return alts.reduce((a, b) => (b.nick_gain > a.nick_gain ? b : a));
}

/**
 * The overpay cap on the second package: inside Nick's cap on market value given, or else exactly the
 * planned CAP-1C premium package that held on the confirm dice (depth_premium.confirmed).
 */
export function altWithinCap({ give, step, valueOf, maxOverpay }) {
  const sum = ids => ids.reduce((a, id) => a + Math.max(0, Number(valueOf(id)) || 0), 0);
  if (!nickOverpays(sum(give), sum(step.get), maxOverpay)) return true;
  return !!(step.depth_premium?.confirmed && sameSet(give, step.give));
}

/** who(id) -> { name, position }. One line on why the deal helps him, or null. */
export function whyLine({ who, give, holes = [] }) {
  const H = (holes ?? []).map(h => String(h).toUpperCase());
  const ps = give.map(id => who(id));
  const fit = ps.find(p => p.position && H.includes(p.position));
  if (fit) return `${fit.name} fills your ${fit.position} hole.`;
  const any = ps.find(p => p.position);
  return any ? `${any.name} gives you another ${any.position}.` : null;
}

const joinNames = (who, list) => {
  const n = list.map(id => who(id).name);
  return n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

/** The formal offer: firm, plain, fair, with its expiry and an easy no. */
export function firmOfferText({ who, give, get, alt = null, holes = [], maxChars = 280 }) {
  const why = whyLine({ who, give, holes });
  const t = joinNames(who, get);
  const pkg = `${joinNames(who, give)} for ${t}.` + (alt?.length ? ` Or ${joinNames(who, alt)} for ${t}, whichever works better for you.` : '');
  const tail = 'I think that is fair for both of us. The offer stands for two days. No worries if it is a no.';
  const tries = [[why, pkg, tail], [pkg, tail], [`${joinNames(who, give)} for ${t}.`, tail]];
  for (const parts of tries) {
    const text = parts.filter(Boolean).join(' ');
    if (text.length <= maxChars) return text;
  }
  return `${joinNames(who, give)} for ${t}.`;
}

/** The interest check before any formal proposal. Names only what he would give up. */
export function feelerText({ who, give, get }) {
  const pos = [...new Set(give.map(id => who(id).position).filter(Boolean))];
  const back = pos.length ? ` I would send a ${pos.join(' and a ')} back.` : '';
  return `Any interest in moving ${joinNames(who, get)}?${back} Just checking before I send a real offer.`;
}

const PRESSURE = [
  /\bother (offers?|teams?|managers?|guys) (on|for|interested|asking|are)\b/i,
  /\bi have other offers\b/i,
  /\bsomeone else\b/i,
  /\bwon'?t last\b/i,
  /\blast chance\b/i,
  /\btake it or leave it\b/i,
  /\bfinal offer\b/i,
  /\bbefore (anyone|someone|somebody) else\b/i,
  /\bnow or never\b/i,
  /\bact fast\b/i,
];
/** The pressure phrases a text contains ([] when none). */
export function pressureTactics(text) {
  return PRESSURE.map(re => re.exec(String(text ?? ''))?.[0]).filter(Boolean);
}

/**
 * sendWindow result + last week's margin -> the cool-off send window. A loss means wait
 * COOL_OFF_HOURS; a wait that already runs later is kept. No loss (or no margin) -> unchanged.
 */
export function coolOff(send, { margin, now }) {
  if (!Number.isFinite(margin) || margin >= 0) return send;
  const until = new Date(now + COOL_OFF_HOURS * HOUR).toISOString();
  if (send?.when === 'wait' && Date.parse(send.until) >= Date.parse(until)) return send;
  return { when: 'wait', until, n: send?.n ?? 0, fitted: false, cool_off: true,
    why: `he lost last week by ${Math.abs(margin).toFixed(0)}: give it a day to cool off, then send a fair offer` };
}

/**
 * The step's negotiation block (planner playbook): levers applied, the feeler, the expiry, the
 * withdraw rule, the second package and the anchor. who(id) -> { name, position }.
 */
export function negotiationFor({ who, give, get, ladder, alt, altDropped = null, holes, sendWhen, message }) {
  const levers = ['firm_wording', 'expiry', 'withdraw_on_news', 'feeler_first', 'no_pressure_tactics'];
  if (ladder?.anchor) levers.unshift('defensible_anchor');
  if (alt) levers.push('two_packages');
  if (message && whyLine({ who, give, holes }) && message.startsWith(whyLine({ who, give, holes }))) levers.push('why_line');
  if (sendWhen?.cool_off) levers.push('cool_off');
  return {
    levers, feeler: feelerText({ who, give, get }), expires_hours: OFFER_HOURS, withdraw_if: WITHDRAW_IF,
    ...(alt ? { alt_package: { give: alt.give, get, his_pct: alt.his_pct } } : {}),
    ...(altDropped ? { alt_dropped: altDropped } : {}),
    ...(ladder?.anchor ? { anchor: ladder.anchor } : {}),
    ...(sendWhen?.cool_off ? { cool_off: true } : {}),
  };
}
