/**
 * REASON-01 input side: which moves get a reasoning panel, and the facts each
 * panel is allowed to state.
 *
 * The input is the War Room plans file in the contract shape
 * (server/services/campaign/plans-schema.js, `warroom-plans/1`). Every read
 * below is a contract path, listed for the contract test in
 * test/fixtures/warroom-contract/consumer-reads.js (pr 234):
 *
 *   alternatives.value[]              the deck, best first; its head is next_move
 *     .move_id                        the card id (stable across refreshes, so reuse works)
 *     .delta_final.value              title-odds gain of the whole move
 *     .steps[0].partner/give/get      the offer to send now
 *     .steps[0].p_yes.{value,n}       chance he says yes, and how many offers it rests on
 *     .steps[0].title_odds_delta.{value,se,clears_2se}
 *     .steps[0].reply_table.value.*   what to do on accept / decline / counter / silence
 *     .steps[0].walk_away.value.text
 *   partners.value[]                  his side, one row per team (FIX-03's shape: p_responds
 *                                     a bare probability, roster_holes position strings,
 *                                     chat_labels 'key:value' tags, offers_logged)
 *   brain_report.value.checks[E1]     whether the accept model has passed calibration
 *   flip_map.value[]                  FIX-234-1: one card per flip (player, buy_from, sell_to,
 *                                     spread, price_a/b, legs.p1/p2/p_both/nick_after, legs_why_not)
 *   targets.value[]                   FIX-234-1: one card per target (player, owner, gain_if_landed,
 *                                     p_reach, mode_fit, why, approved, is_plan_target)
 *
 * Cost rule (ENGINE-SPECS REASON-01): only the deck is considered on every
 * refresh. The contract caps the deck at MAX_ALTERNATIVES (head + four), and
 * anything past it is dropped here, before any prompt is built. Flips and
 * targets (FIX-234-1) are capped the same way (MAX_ITEMS_PER_KIND each), and
 * produce.js only writes one when its inputs changed or it was opened.
 *
 * Facts are a flat map of field id -> scalar. A panel's words may state a
 * number only when a fact it cites holds that number (verify.js). Chat enters
 * ONLY as labels: raw chat text is never read from the input, so it cannot be
 * quoted back.
 */
import { MAX_ALTERNATIVES } from '../campaign/plans-schema.js';

export const MAX_CARDS_PER_LEAGUE = MAX_ALTERNATIVES;
export const DECK_SIZE = MAX_CARDS_PER_LEAGUE - 1;
/** FIX-234-1: at most this many flips and this many targets per league ever reach a prompt. */
export const MAX_ITEMS_PER_KIND = 5;
export const NEWS_WINDOW_HOURS = 48;
export const REPLY_KEYS = Object.freeze(['accept', 'decline', 'counter', 'silence']);

/** A chat-derived label is a short tag (FIX-03 writes 'open_to_trade:high'), never a sentence or a quote. */
const LABEL = /^[A-Za-z][A-Za-z _:-]{0,39}$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = v => (Array.isArray(v) ? v : []);
/** A typed field's value when it is ok; undefined otherwise (never a stand-in 0). */
const ok = f => (f && typeof f === 'object' && f.status === 'ok' ? f.value : undefined);
const str = v => (typeof v === 'string' && v.trim() ? v : null);

/** The contract's league id. */
export const leagueIdOf = league => league?.league ?? null;

/** His row in `partners.value[]`, or null. */
export function partnerFor(league, team) {
  if (team == null) return null;
  return list(ok(league?.partners)).find(p => String(p?.team) === String(team)) ?? null;
}

/**
 * The calibration fact for P(yes): E1 in the brain report. `calibrated` is
 * true only when E1 is passing; a missing report says so rather than passing.
 */
export function calibrationOf(league) {
  const report = ok(league?.brain_report);
  if (!report) return { calibrated: false, status: 'brain report not available' };
  const e1 = list(report.checks).find(c => c?.id === 'E1');
  if (!e1) return { calibrated: false, status: 'E1 not reported' };
  return { calibrated: e1.status === 'passing', status: `E1 ${e1.status}` };
}

function replyRows(step) {
  const table = ok(step?.reply_table);
  if (!table) return [];
  return REPLY_KEYS.flatMap(key => {
    const r = ok(table[key]);
    if (!r) return [];
    return [{
      reply: key, action: str(r.do), when: str(r.when),
      counter: str(r.counter_rules?.counter_with), accept_if: str(r.counter_rules?.accept_if),
      walk_away_if: str(r.counter_rules?.walk_away_if), odds_after: num(ok(r.odds_after))
    }];
  });
}

function cardFromMove(move) {
  const step = list(move?.steps)[0];
  if (!step || typeof move?.move_id !== 'string') return null;
  const tod = step.title_odds_delta ?? {};
  return {
    id: move.move_id,
    rank: 0,
    partner_team: step.partner ?? null,
    give: list(step.give), get: list(step.get),
    p_yes: num(ok(step.p_yes)), p_yes_n: num(step.p_yes?.n),
    title_delta: num(ok(move.delta_final)),
    step_title_delta: num(ok(tod)),
    title_delta_se: tod.status === 'ok' ? num(tod.se) : null,
    clears_2se: tod.status === 'ok' && typeof tod.clears_2se === 'boolean' ? tod.clears_2se : null,
    send_when: str(ok(step.send_when)),
    opening: str(ok(step.opening)?.text),
    reply_table: replyRows(step),
    walk_away: str(ok(step.walk_away)?.text)
  };
}

/** De-duplicated by id, capped at `max`, ranked 0.. in order. */
function capCards(raw, max) {
  const seen = new Set();
  const cards = [];
  for (const c of raw) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    cards.push({ ...c, rank: cards.length });
    if (cards.length === max) break;
  }
  return { cards, dropped: Math.max(0, raw.length - cards.length) };
}

/** The deck for one league, at most MAX_CARDS_PER_LEAGUE, in rank order (0 = the head). */
export function cardsForLeague(league) {
  return capCards(list(ok(league?.alternatives)).map(cardFromMove).filter(Boolean), MAX_CARDS_PER_LEAGUE);
}

/* ------------------------------------------------ flips and targets (FIX-234-1) */

const idOf = v => (v == null || v === '' ? null : String(v));

/** A flip has no id in the contract; this one is stable across refreshes, so reuse works. */
export const flipCardId = f => `flip:${f.player}:${f.buy_from}:${f.sell_to}`;
/** A target has no id in the contract; player + owner is stable across refreshes. */
export const targetCardId = t => `target:${t.player}:${t.owner}`;

function cardFromFlip(f) {
  if ([f?.player, f?.buy_from, f?.sell_to].some(v => idOf(v) == null)) return null;
  const legs = f.legs && typeof f.legs === 'object' ? f.legs : null;
  const after = legs?.nick_after ?? {};
  const spread = f.spread ?? {};
  return {
    id: flipCardId(f), kind: 'flip', rank: 0,
    partner_team: String(f.buy_from), other_team: String(f.sell_to),
    give: legs && idOf(legs.give_a) ? [String(legs.give_a)] : [],
    get: legs && idOf(legs.get_b) ? [String(legs.get_b)] : [],
    players: [f.player, legs?.give_a, legs?.get_b].map(idOf).filter(Boolean),
    // Confidence reads these: both legs landing is the flip's "he says yes".
    p_yes: num(ok(legs?.p_both)), p_yes_n: null,
    title_delta: num(ok(after)),
    title_delta_se: after.status === 'ok' ? num(after.se) : null,
    clears_2se: after.status === 'ok' && typeof after.clears_2se === 'boolean' ? after.clears_2se : null,
    reply_table: [],
    flip: {
      player: String(f.player),
      spread: num(ok(spread)), spread_se: spread.status === 'ok' ? num(spread.se) : null,
      spread_clears_2se: spread.status === 'ok' && typeof spread.clears_2se === 'boolean' ? spread.clears_2se : null,
      price_a: num(ok(f.price_a)), price_b: num(ok(f.price_b)),
      p1: num(ok(legs?.p1)), p2: num(ok(legs?.p2)), p_both: num(ok(legs?.p_both)), nick_after: num(ok(after)),
      legs_why_not: str(f.legs_why_not)
    }
  };
}

function cardFromTarget(t) {
  if (idOf(t?.player) == null || idOf(t?.owner) == null) return null;
  const gain = t.gain_if_landed ?? {};
  return {
    id: targetCardId(t), kind: 'target', rank: 0,
    partner_team: String(t.owner),
    give: [], get: [String(t.player)], players: [String(t.player)],
    // Confidence reads these: the chance the path to him lands is the target's "he says yes".
    p_yes: num(ok(t.p_reach)), p_yes_n: null,
    title_delta: num(ok(gain)),
    title_delta_se: gain.status === 'ok' ? num(gain.se) : null,
    clears_2se: gain.status === 'ok' && typeof gain.clears_2se === 'boolean' ? gain.clears_2se : null,
    reply_table: [],
    target: {
      player: String(t.player), gain_if_landed: num(ok(gain)), p_reach: num(ok(t.p_reach)),
      mode_fit: str(ok(t.mode_fit)), why: str(ok(t.why)),
      approved: typeof t.approved === 'boolean' ? t.approved : null,
      is_plan_target: typeof t.is_plan_target === 'boolean' ? t.is_plan_target : null
    }
  };
}

/** The flips and targets of one league, each capped at MAX_ITEMS_PER_KIND, in the plan's order. */
export function itemCardsForLeague(league) {
  const flips = capCards(list(ok(league?.flip_map)).map(cardFromFlip).filter(Boolean), MAX_ITEMS_PER_KIND);
  const targets = capCards(list(ok(league?.targets)).map(cardFromTarget).filter(Boolean), MAX_ITEMS_PER_KIND);
  return { flips: flips.cards, targets: targets.cards, dropped_flips: flips.dropped, dropped_targets: targets.dropped };
}

/** News in the 48 h before `asOf` that touches a player on the card. */
export function recentNews(news, card, asOf) {
  const end = Date.parse(asOf);
  if (!Number.isFinite(end)) return [];
  const start = end - NEWS_WINDOW_HOURS * 3600 * 1000;
  const players = new Set((card.players ?? [...card.give, ...card.get]).map(String));
  return list(news).filter(n => {
    const t = Date.parse(n?.published_at);
    if (!Number.isFinite(t) || t < start || t > end) return false;
    return list(n.player_ids).some(p => players.has(String(p)));
  });
}

/** Chat labels that are tags; anything shaped like a sentence or quote is dropped and counted. */
export function cleanLabels(labels) {
  const kept = [];
  let rejected = 0;
  for (const l of list(labels)) {
    if (typeof l === 'string' && LABEL.test(l)) kept.push(l);
    else rejected += 1;
  }
  return { labels: kept, rejected };
}

function put(facts, id, value) {
  if (value == null) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (!['number', 'string', 'boolean'].includes(typeof value)) return;
  facts[id] = value;
}

/** One partners.value[] row as facts under `prefix` (labels only, never chat text). */
function putPartner(facts, prefix, partner) {
  put(facts, `${prefix}.p_responds`, num(partner.p_responds));
  put(facts, `${prefix}.basis`, str(partner.basis));
  list(partner.roster_holes).forEach((h, i) => put(facts, `${prefix}.hole.${i}.pos`, str(h)));
  put(facts, `${prefix}.offers_logged`, num(partner.offers_logged));
  cleanLabels(partner.chat_labels).labels.forEach((l, i) => put(facts, `${prefix}.label.${i}`, l));
}

/**
 * Every fact one card's panel may cite. Ids are stable dotted paths so a
 * cite reads as where the number came from.
 */
export function factsForCard({ card, league, news }) {
  const facts = {};
  const partner = partnerFor(league, card.partner_team) ?? {};
  const names = league.names ?? {};

  for (const k of ['rank', 'p_yes', 'p_yes_n', 'title_delta', 'step_title_delta', 'title_delta_se',
    'clears_2se', 'send_when', 'opening', 'walk_away']) {
    put(facts, `card.${k}`, card[k]);
  }
  put(facts, 'card.partner_team', card.partner_team);
  card.give.forEach((p, i) => put(facts, `card.give.${i}`, names[p] ?? String(p)));
  card.get.forEach((p, i) => put(facts, `card.get.${i}`, names[p] ?? String(p)));
  for (const r of card.reply_table) {
    for (const k of ['action', 'when', 'counter', 'accept_if', 'walk_away_if', 'odds_after']) {
      put(facts, `reply.${r.reply}.${k}`, r[k]);
    }
  }

  putPartner(facts, 'his', partner);

  if (card.kind === 'flip') {
    for (const [k, v] of Object.entries(card.flip)) put(facts, `flip.${k}`, k === 'player' ? names[v] ?? v : v);
    put(facts, 'flip.buy_from', card.partner_team);
    put(facts, 'flip.sell_to', card.other_team);
    if (card.give[0] != null) put(facts, 'flip.give_a', names[card.give[0]] ?? card.give[0]);
    if (card.get[0] != null) put(facts, 'flip.get_b', names[card.get[0]] ?? card.get[0]);
    // The team he sells to is the second side of a flip; its read sits under buyer.*.
    putPartner(facts, 'buyer', partnerFor(league, card.other_team) ?? {});
  } else if (card.kind === 'target') {
    for (const [k, v] of Object.entries(card.target)) put(facts, `target.${k}`, k === 'player' ? names[v] ?? v : v);
    put(facts, 'target.owner', card.partner_team);
  }

  const cal = calibrationOf(league);
  put(facts, 'calibration.calibrated', cal.calibrated);
  put(facts, 'calibration.status', cal.status);

  for (const n of news) {
    put(facts, `news.${n.id}.headline`, n.headline);
    put(facts, `news.${n.id}.published_at`, n.published_at);
  }
  return facts;
}

/**
 * The ledger verify.js checks against, over a flat fact map. Same two methods
 * verifyAnswer calls on the Coach ledger; nothing here is collected by hand.
 */
export function factLedger(facts) {
  return {
    cell: cite => (typeof cite === 'string' && Object.hasOwn(facts, cite) ? { id: cite, value: facts[cite], kind: 'row' } : null),
    handCollected: () => []
  };
}
