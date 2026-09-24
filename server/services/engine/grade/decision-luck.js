/**
 * Decision vs luck, point in time (ENGINE-ARCHITECTURE.md §7.3; ML I8). Pure functions over
 * events already read by the grader: no database.
 *
 *   decision  what was knowable at the decision time T: the call's expected value from
 *             inputs in force at T only.
 *   realised  what the call came to.
 *   luck      realised - decision; and, when a before-the-fact distribution was recorded,
 *             the realised value's PIT in it (uniform PITs per stream = honest forecasts).
 *
 * THE POINT-IN-TIME RULE. An input is used for a decision at T only when its as_of <= T
 * (`inForceAt`). A settings change, a market value, or a rewritten forecast that arrived
 * after T is never used for that decision; where nothing was in force the decision is
 * excluded by reason, never filled from a later row.
 *
 * Streams:
 *   offers  (offer.sent)  T = proposed_at. The league's format in force at T
 *           (league.settings.format_key) prices both sides with market.player_value in
 *           force at T: decision = value received - value sent. realised = the same deal at
 *           the latest values (same format), so luck = how the market moved after the
 *           decision. No PIT: trade_outcomes does not log a delta distribution (OFFER-01).
 *   recs    (rec.shown / rec.considered, settled by rec.graded)  T = made_at. The forecast
 *           is the FIRST logged version of the rec (a later rewrite of predicted_json is a
 *           new event and is ignored, counted in ignored.rewritten_after_decision):
 *           `expected_delta` or `delta` (a number), else the median of `delta_dist`
 *           {levels, values}. realised = rec_ledger's own score (rec-ledger.js gradeRow:
 *           called minus baseline points over the horizon).
 */
import { pitFromQuantiles, ksUniform, mean } from './scorers.js';

const r6 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(6));
const byAsOfThenId = (a, b) => (a.as_of < b.as_of ? -1 : a.as_of > b.as_of ? 1 : a.id - b.id);

/** The latest event with as_of <= T (ties: the later id), or null. Nothing after T is ever returned. */
export function inForceAt(events, T) {
  let found = null;
  for (const e of events ?? []) {
    if (!(e.as_of <= T)) continue;
    if (!found || byAsOfThenId(found, e) < 0) found = e;
  }
  return found;
}
const latest = events => (events ?? []).reduce((a, e) => (!a || byAsOfThenId(a, e) < 0 ? e : a), null);

const group = (events, key) => {
  const m = new Map();
  for (const e of events) { const k = key(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
  return m;
};

function quantilesOf(d) {
  if (!Array.isArray(d?.levels) || !Array.isArray(d?.values) || d.levels.length !== d.values.length || !d.levels.length) return null;
  const levels = d.levels.map(Number); const values = d.values.map(Number);
  return levels.every(Number.isFinite) && values.every(Number.isFinite) ? { levels, values } : null;
}
/** The quantile function at tau, linear between the recorded levels; null outside them. */
function quantileAt({ levels, values }, tau) {
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i] === tau) return values[i];
    if (i > 0 && levels[i - 1] < tau && tau < levels[i]) {
      return values[i - 1] + ((tau - levels[i - 1]) / (levels[i] - levels[i - 1])) * (values[i] - values[i - 1]);
    }
  }
  return null;
}

const ids = side => (Array.isArray(side) ? side.map(x => Number(typeof x === 'object' && x ? x.id : x)) : null);

export function offerSplits(offers, settingsEvents, valueEvents) {
  const settings = group(settingsEvents, e => Number(e.payload.league_id ?? e.league_id));
  const values = group(valueEvents, e => `${e.payload.format_key}:${e.payload.player_id}`);
  const excluded = { no_settings_in_force: 0, no_value_in_force: 0, malformed: 0 };
  const ignored = { rewritten_after_decision: 0 };
  const items = [];
  for (const [, list] of [...group(offers, e => e.natural_key)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const offer = list.reduce((a, e) => (e.id < a.id ? e : a));
    ignored.rewritten_after_decision += list.length - 1;
    const T = offer.as_of;
    const give = ids(offer.payload.give); const get = ids(offer.payload.get);
    if (!give || !get || [...give, ...get].some(p => !(p > 0))) { excluded.malformed += 1; continue; }
    const s = inForceAt(settings.get(Number(offer.league_id)), T);
    if (!s?.payload?.format_key) { excluded.no_settings_in_force += 1; continue; }
    const fk = s.payload.format_key;
    const atT = pid => inForceAt(values.get(`${fk}:${pid}`), T)?.payload?.value;
    const now = pid => latest(values.get(`${fk}:${pid}`))?.payload?.value;
    if ([...give, ...get].some(p => atT(p) == null)) { excluded.no_value_in_force += 1; continue; }
    const side = (list2, f) => list2.reduce((sum, p) => sum + Number(f(p)), 0);
    const decision = side(get, atT) - side(give, atT);
    const realised = side(get, now) - side(give, now);
    items.push({ id: offer.payload.trade_outcome_id ?? offer.natural_key, league_id: Number(offer.league_id), decision_time: T,
      format_key: fk, settings_event_id: s.id, decision: r6(decision), realised: r6(realised), luck: r6(realised - decision),
      pit: null, pit_reason: 'no before-the-fact distribution logged for offers (OFFER-01)',
      realised_basis: 'the same deal at the latest market values, same format' });
  }
  return { 'offer.sent@app': { items, excluded, ignored } };
}

export function recSplits(madeEvents, gradedEvents) {
  const graded = new Map();
  for (const e of gradedEvents) {
    const k = Number(e.payload.rec_id);
    if (!graded.has(k) || graded.get(k).id < e.id) graded.set(k, e);
  }
  const out = {};
  const stream = key => {
    out[key] ??= { items: [], excluded: { no_forecast: 0, not_scored: 0 }, ignored: { rewritten_after_decision: 0 } };
    return out[key];
  };
  for (const [, list] of [...group(madeEvents, e => e.natural_key)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const made = list.reduce((a, e) => (e.id < a.id ? e : a));
    const settle = graded.get(Number(made.payload.rec_id));
    if (!settle) continue; // not settled yet: nothing to grade
    const s = stream(`rec.${made.payload.kind}@${made.event_type === 'rec.shown' ? 'shown' : 'considered'}`);
    s.ignored.rewritten_after_decision += list.length - 1;
    const predicted = made.payload.model?.predicted ?? {};
    const dist = quantilesOf(predicted.delta_dist);
    const point = [predicted.expected_delta, predicted.delta].find(v => typeof v === 'number' && Number.isFinite(v));
    const decision = point ?? (dist ? quantileAt(dist, 0.5) : null);
    if (decision == null) { s.excluded.no_forecast += 1; continue; }
    const realised = typeof settle.payload.score === 'number' ? settle.payload.score : null;
    if (realised == null) { s.excluded.not_scored += 1; continue; }
    s.items.push({ id: made.payload.rec_id, league_id: Number(made.league_id), decision_time: made.as_of,
      decision: r6(decision), decision_basis: point != null ? 'point' : 'median of delta_dist', realised: r6(realised),
      luck: r6(realised - decision), pit: dist ? r6(pitFromQuantiles(dist.levels, dist.values, realised)) : null });
  }
  return out;
}

/** The row value for one stream. */
export function summariseSplit({ items, excluded, ignored }) {
  const pits = items.map(i => i.pit).filter(v => v != null);
  const ks = pits.length ? ksUniform(pits) : null;
  return {
    n: items.length,
    decision: { mean: r6(mean(items.map(i => i.decision))), positive_share: items.length
      ? r6(items.filter(i => i.decision > 0).length / items.length) : null },
    luck: { mean: r6(mean(items.map(i => i.luck))) },
    pit_ks: ks ? { d: r6(ks.d), p: r6(ks.p), n: ks.n } : null,
    excluded: { ...excluded }, ignored: { ...ignored }, items,
  };
}
