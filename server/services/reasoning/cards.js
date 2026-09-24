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
 *
 * Cost rule (ENGINE-SPECS REASON-01): only the deck gets a panel per refresh.
 * The contract caps the deck at MAX_ALTERNATIVES (head + four), and anything
 * past it is dropped here, before any prompt is built.
 *
 * Facts are a flat map of field id -> scalar. A panel's words may state a
 * number only when a fact it cites holds that number (verify.js). Chat enters
 * ONLY as labels: raw chat text is never read from the input, so it cannot be
 * quoted back.
 */
import { MAX_ALTERNATIVES } from '../campaign/plans-schema.js';

export const MAX_CARDS_PER_LEAGUE = MAX_ALTERNATIVES;
export const DECK_SIZE = MAX_CARDS_PER_LEAGUE - 1;
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

/** The deck for one league, at most MAX_CARDS_PER_LEAGUE, in rank order (0 = the head). */
export function cardsForLeague(league) {
  const raw = list(ok(league?.alternatives)).map(cardFromMove).filter(Boolean);
  const seen = new Set();
  const cards = [];
  for (const c of raw) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    cards.push({ ...c, rank: cards.length });
    if (cards.length === MAX_CARDS_PER_LEAGUE) break;
  }
  return { cards, dropped: Math.max(0, raw.length - cards.length) };
}

/** News in the 48 h before `asOf` that touches a player on the card. */
export function recentNews(news, card, asOf) {
  const end = Date.parse(asOf);
  if (!Number.isFinite(end)) return [];
  const start = end - NEWS_WINDOW_HOURS * 3600 * 1000;
  const players = new Set([...card.give, ...card.get].map(String));
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

  put(facts, 'his.p_responds', num(partner.p_responds));
  put(facts, 'his.basis', str(partner.basis));
  list(partner.roster_holes).forEach((h, i) => put(facts, `his.hole.${i}.pos`, str(h)));
  put(facts, 'his.offers_logged', num(partner.offers_logged));
  cleanLabels(partner.chat_labels).labels.forEach((l, i) => put(facts, `his.label.${i}`, l));

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
