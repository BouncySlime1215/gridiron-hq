/**
 * FIX-07: the War Room card a request names, read from the plans file.
 *
 * A request carries only a `move_id` (schema.js). What Nick saw on that card
 * (partner, give, get, the chance he says yes and its band, the title-odds
 * gain) lives in the plans file the producer wrote (contract: #238
 * plans-schema.js, `warroom-plans/1`). This file finds the card and turns it
 * into what the two writers need: the deal `trade-outcomes.js#recordSentOffer`
 * grades, and the partner/players a deck skip down-weights.
 *
 * Pure: it reads the parsed plans entries it is given, never the disk.
 */

import { SENT_AS } from './schema.js';

export { SENT_AS };

/**
 * sent_as -> 083's price_band. The card's step is the deal the chance-he-says-yes
 * was priced on, so it is the yes-point. The opening asks him for the same and
 * gives less (below the point); the walk-away gives the most Nick will (above).
 */
export const PRICE_BAND_OF = Object.freeze({ opening: 'below', card: 'at_point', walk_away: 'above' });

const val = f => (f && typeof f === 'object' && 'status' in f ? (f.status === 'ok' ? f.value : undefined) : f);
const num = f => { const v = val(f); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
const ids = a => (Array.isArray(a) ? a.map(String) : []);

/** The league's entry in a plans file (the entries array loadPlans returns). */
export function leagueEntry(entries, leagueId) {
  return (entries ?? []).find(e => String(e?.league) === String(leagueId)) ?? null;
}

/** Every move the entry shows: the next move first, then the deck. */
function movesOf(entry) {
  const out = [];
  const next = val(entry?.next_move);
  if (next?.move_id) out.push(next);
  for (const m of val(entry?.alternatives) ?? []) if (m?.move_id) out.push(m);
  return out;
}

/** The band a step carries: `p_yes_band` as `{low, high}` or as a typed field of it. */
function bandOf(step) {
  const b = val(step?.p_yes_band);
  const low = Number(b?.low), high = Number(b?.high);
  return Number.isFinite(low) && Number.isFinite(high) && low <= high ? { low, high, basis: b?.basis ?? null } : null;
}

/**
 * The card for (league, move_id, step_index). Returns null when the plans file
 * has no such move (a stale tap, or a pre-contract plans file).
 */
export function findCard(entries, leagueId, moveId, stepIndex = 0) {
  const entry = leagueEntry(entries, leagueId);
  const move = movesOf(entry).find(m => String(m.move_id) === String(moveId));
  const step = move?.steps?.[stepIndex];
  if (!step) return null;
  const delta = step.title_odds_delta;
  return {
    move_id: String(move.move_id), step_index: stepIndex, me: entry.me != null ? String(entry.me) : null,
    partner: String(step.partner), give: ids(step.give), get: ids(step.get),
    p_yes: num(step.p_yes), p_yes_band: bandOf(step),
    title_odds_delta: num(delta), title_odds_delta_se: num(delta?.se ?? null),
    opening: val(step.opening) ?? null, walk_away: val(step.walk_away) ?? null,
  };
}

/**
 * The two sides of the deal Nick sent, by how he sent it. The opening is its
 * own give/get; the walk-away gives `max_give` for the card's get.
 */
export function sentSides(card, sentAs = 'card') {
  if (sentAs === 'opening') {
    if (!card.opening?.give?.length) return { error: 'this card has no opening offer' };
    return { give: ids(card.opening.give), get: ids(card.opening.get?.length ? card.opening.get : card.get) };
  }
  if (sentAs === 'walk_away') {
    if (!card.walk_away?.max_give?.length) return { error: 'this card has no walk-away offer' };
    return { give: ids(card.walk_away.max_give), get: card.get };
  }
  return { give: card.give, get: card.get };
}

/**
 * The deal `recordSentOffer` records. `players` maps a player id to
 * `{ id, name, espn_id }` (ESPN ids let the settle job match the proposal);
 * an id it does not know goes in as `{ id }`. The acceptance band is the card's
 * `p_yes_band` with its `p_yes` as the midpoint. No band -> `{ error }`: the
 * ledger refuses a point without its band (trade-outcomes.js#predictionOf).
 */
export function sentDeal(card, sentAs = 'card', players = new Map()) {
  const sides = sentSides(card, sentAs);
  if (sides.error) return sides;
  if (!card.p_yes_band || card.p_yes == null) {
    return { error: 'this card carries no p_yes_band, so the offer cannot be graded (the producer writes it from FIX-03 on)' };
  }
  if (card.p_yes < card.p_yes_band.low || card.p_yes > card.p_yes_band.high) {
    return { error: `this card's p_yes_band (${card.p_yes_band.low}-${card.p_yes_band.high}) does not contain its p_yes, so the producer wrote an inconsistent card` };
  }
  const who = id => players.get(String(id)) ?? { id: String(id) };
  return {
    deal: {
      partner_id: card.partner, i_give: sides.give.map(who), i_get: sides.get.map(who),
      acceptance: { band: { low: card.p_yes_band.low, mid: card.p_yes, high: card.p_yes_band.high },
        basis: card.p_yes_band.basis ?? 'campaign.p_yes_band' },
    },
    price_band: PRICE_BAND_OF[sentAs],
  };
}
