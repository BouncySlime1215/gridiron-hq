/**
 * REASON-01 input side: which cards get a reasoning panel, and the facts each
 * panel is allowed to state.
 *
 * The input is the campaign producer's plans JSON (one entry per league). Two
 * shapes are read, because the producer has not landed on main yet and the
 * prototype it grows from writes the second one:
 *
 *   league.cards[]                     explicit cards, rank 0 = the top card
 *   league.acq { best, alternatives }  planner paths; the card is each path's
 *                                      first step (the next move)
 *
 * Cost rule (ENGINE-SPECS REASON-01): only the top card and the swipe deck get
 * a panel per refresh. Everything past DECK_SIZE is dropped here, before any
 * prompt is built, so no later step can spend on it.
 *
 * Facts are a flat map of field id -> scalar. A panel's words may state a
 * number only when a fact it cites holds that number (verify.js). Chat enters
 * ONLY as labels: raw chat text is never read from the input, so it cannot be
 * quoted back.
 */

export const DECK_SIZE = 5;
export const MAX_CARDS_PER_LEAGUE = 1 + DECK_SIZE;
export const NEWS_WINDOW_HOURS = 48;

/** A chat-derived label is a short tag, never a sentence or a quote. */
const LABEL = /^[A-Za-z][A-Za-z _-]{0,39}$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = v => (Array.isArray(v) ? v : []);

function cardFromPlan(plan, rank, leagueId) {
  const step = list(plan?.steps)[0];
  if (!step) return null;
  return {
    id: plan.id ?? `${leagueId}:${rank}`,
    rank,
    partner_team: step.team ?? null,
    give: list(step.give), get: list(step.get),
    p_yes: num(step.p), p_yes_n: num(step.p_n ?? plan.p_yes_n), p_yes_basis: step.basis ?? plan.p_yes_basis ?? null,
    title_delta: num(plan.delta_final ?? step.delta), title_delta_se: num(step.se),
    clears_2se: typeof step.clears === 'boolean' ? step.clears : null,
    reason_chain: list(plan.reason_chain), reply_table: list(plan.reply_table ?? step.reply_table),
    walk_away: plan.walk_away ?? null
  };
}

function normaliseCard(card, rank) {
  return {
    id: String(card.id ?? rank), rank,
    partner_team: card.partner_team ?? null,
    give: list(card.give), get: list(card.get),
    p_yes: num(card.p_yes), p_yes_n: num(card.p_yes_n), p_yes_basis: card.p_yes_basis ?? null,
    title_delta: num(card.title_delta), title_delta_se: num(card.title_delta_se),
    clears_2se: typeof card.clears_2se === 'boolean' ? card.clears_2se : null,
    reason_chain: list(card.reason_chain), reply_table: list(card.reply_table),
    walk_away: card.walk_away ?? null
  };
}

/** Top card + deck for one league, at most MAX_CARDS_PER_LEAGUE, in rank order. */
export function cardsForLeague(league) {
  let raw;
  if (Array.isArray(league?.cards)) {
    raw = [...league.cards].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map(normaliseCard);
  } else if (league?.acq) {
    const plans = [league.acq.best, ...list(league.acq.alternatives)].filter(Boolean);
    raw = plans.map((p, i) => cardFromPlan(p, i, league.league_id)).filter(Boolean);
  } else {
    raw = [];
  }
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
  const partner = league.partners?.[card.partner_team] ?? {};
  const names = league.names ?? {};

  for (const k of ['rank', 'p_yes', 'p_yes_n', 'p_yes_basis', 'title_delta', 'title_delta_se', 'clears_2se', 'walk_away']) {
    put(facts, `card.${k}`, card[k]);
  }
  put(facts, 'card.partner_team', card.partner_team);
  card.give.forEach((p, i) => put(facts, `card.give.${i}`, names[p] ?? String(p)));
  card.get.forEach((p, i) => put(facts, `card.get.${i}`, names[p] ?? String(p)));
  card.reason_chain.forEach((r, i) => put(facts, `reason.${i}`, typeof r === 'string' ? r : null));
  card.reply_table.forEach((r, i) => {
    put(facts, `reply.${i}.reply`, r?.reply);
    put(facts, `reply.${i}.action`, r?.action ?? r?.answer);
    put(facts, `reply.${i}.counter`, typeof r?.counter === 'string' ? r.counter : null);
    put(facts, `reply.${i}.p`, num(r?.p));
  });

  list(partner.roster_holes).forEach((h, i) => {
    put(facts, `his.hole.${i}.pos`, h?.pos);
    put(facts, `his.hole.${i}.gap`, num(h?.gap));
  });
  for (const [pid, v] of Object.entries(partner.paper_values ?? {})) {
    put(facts, `his.paper_value.${pid}`, num(v));
    put(facts, `his.paper_value.${pid}.name`, names[pid] ?? null);
  }
  list(partner.recent_moves).forEach((m, i) => {
    put(facts, `his.move.${i}.type`, m?.type);
    put(facts, `his.move.${i}.summary`, m?.summary);
  });
  put(facts, 'his.offers_logged', num(partner.offers_logged));
  cleanLabels(partner.chat_labels).labels.forEach((l, i) => put(facts, `his.label.${i}`, l));

  const cal = league.calibration?.['clone.accept'] ?? {};
  put(facts, 'calibration.calibrated', typeof cal.calibrated === 'boolean' ? cal.calibrated : null);
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
