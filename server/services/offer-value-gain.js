/**
 * PROJ-ESPN Q3: the value-gain hint. INFO ONLY: it is not a probability and nothing is served
 * from it as one.
 *
 * Why: the ML testbench (#446) found an exploratory, not pre-registered lead: when the
 * responder gains FantasyCalc value, 5 of 11 offers were accepted, against 2 of 30 otherwise
 * (Fisher p = 0.01, current values). Too small and too post-hoc to serve. So this module
 *   1. LOGS, per decided offer, the counterparty's FantasyCalc gain, whether the offer meets one
 *      of his positional needs, whether it hands him a blue chip, and the days to the trade
 *      deadline (offer_value_gain_log, migration 112; first write wins), for the test
 *      pre-registered in docs/tdd/PROJ-ESPN-PREREG.md (value-gain logistic vs the activity
 *      baseline, out of sample, at n >= 100);
 *   2. adds the counterparty's FantasyCalc gain to each trade-finder idea as a labelled hint,
 *      and an opt-in sort on it (GET /api/trades/:id/find?sort=value_gain).
 * E-DATA (#429, the offer feature log) is not on main; when it lands this log folds into it.
 *
 * FantasyCalc values are the current ones (history starts 2026-09-24), so a feature logged for
 * an older offer uses values as of the logging time, not as of the offer (features_as_of).
 */
import { db } from '../db/index.js';
import { fcValues, fcValueOf, FC_VALUE_LABEL } from './fc-value.js';
import { BLUE_CHIP_SCORE } from './campaign/search.js';

const DAY_MS = 86400e3;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
export const VALUE_GAIN_NOTE = 'Info only: how much FantasyCalc value the other manager gains. Not a chance he says yes.';

const sum = (ids, fc) => {
  let t = 0;
  for (const id of ids) {
    const v = fcValueOf(fc, id);
    if (v == null) return null;
    t += v;
  }
  return t;
};

/**
 * One team's positional needs: positions where his best player's rate (ros_ppg) is below the
 * league median of every team's best at that position. teams: [{ roster_id, players: [asset] }].
 */
export function positionalNeeds(teams) {
  const best = new Map(teams.map(t => [String(t.roster_id), Object.fromEntries(SKILL.map(pos => [pos,
    Math.max(0, ...t.players.filter(p => p.position === pos).map(p => Number(p.ros_ppg) || 0))]))]));
  const median = Object.fromEntries(SKILL.map(pos => {
    const xs = [...best.values()].map(b => b[pos]).sort((a, b) => a - b);
    return [pos, xs.length ? xs[Math.floor(xs.length / 2)] : 0];
  }));
  return new Map([...best].map(([id, b]) => [id, new Set(SKILL.filter(pos => b[pos] < median[pos]))]));
}

/**
 * The four features for one offer, from the COUNTERPARTY's side.
 * received / sent: our player ids he gets / gives. -> { fc_gain, need_met, blue_chip_given, days_to_deadline }
 * Each is null when it cannot be read (an unpriced player, no score board, no deadline), never a guess.
 */
export function valueGainFeatures({ received, sent }, { fc, scores = null, needs = null, positionOf = () => null,
  deadlineMs = null, atMs = Date.now() }) {
  const gets = sum(received, fc), gives = sum(sent, fc);
  const fcGain = gets == null || gives == null ? null : +(gets - gives).toFixed(1);
  const blue = scores ? (received.some(id => (scores.get(String(id)) ?? -Infinity) >= BLUE_CHIP_SCORE) ? 1 : 0) : null;
  const need = needs ? (received.some(id => needs.has(positionOf(id))) ? 1 : 0) : null;
  const days = Number.isFinite(deadlineMs) && Number.isFinite(atMs) ? +((deadlineMs - atMs) / DAY_MS).toFixed(1) : null;
  return { fc_gain: fcGain, need_met: need, blue_chip_given: blue, days_to_deadline: days };
}

/** The league's trade deadline (ESPN settings.tradeSettings.deadlineDate, ms), or null. */
export function tradeDeadlineMs(lg) {
  try {
    const p = typeof lg?.payload === 'string' ? JSON.parse(lg.payload) : lg?.payload;
    const d = Number(p?.settings?.tradeSettings?.deadlineDate);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (e) {
    throw new Error(`league ${lg?.id}: payload does not parse (${e.message})`);
  }
}

/**
 * The finder hint: each idea gains `value_gain_hint` (the counterparty's FantasyCalc gain: what
 * I give minus what I get, at FantasyCalc value). `sort: 'value_gain'` reorders ideas by it
 * (unpriced last); anything else keeps the finder's own order. Returns a new object.
 */
export function withValueGainHint(out, { sort = null, fc = null, database = db } = {}) {
  if (!out || !Array.isArray(out.deals)) return out;
  const values = fc ?? fcValues({ rows: (sql, ...p) => database.prepare(sql).all(...p) });
  const ids = list => (list ?? []).map(p => p?.id ?? p);
  const deals = out.deals.map(d => {
    const gain = values.status === 'ok' ? (() => {
      const give = sum(ids(d.i_give), values), get = sum(ids(d.i_get), values);
      return give == null || get == null ? null : +(give - get).toFixed(1);
    })() : null;
    return { ...d, value_gain_hint: { their_fc_gain: gain, basis: FC_VALUE_LABEL, info_only: true, note: VALUE_GAIN_NOTE,
      ...(values.status === 'ok' ? {} : { reason: values.reason }) } };
  });
  if (sort === 'value_gain') {
    deals.sort((a, b) => (b.value_gain_hint.their_fc_gain ?? -Infinity) - (a.value_gain_hint.their_fc_gain ?? -Infinity));
  }
  return { ...out, deals, value_gain_sort: sort === 'value_gain' ? 'value_gain (info only)' : 'finder order' };
}

/**
 * The log (scheduled with the PROJ-ESPN job): every decided offer not yet logged gets one row.
 * Heavy readers are injected so a test can run it on fixtures:
 *   loadOffers(database) -> { offers: [{ offer_id, league_id, season, counterparty_team_id, proposed_at, y, terms }] }
 *   leagueContext(lg)    -> { teams, espnToId: Map<espn id, player id>, positionOf: id -> pos, scores: Map|null }
 */
export async function logOfferValueGains({ database = db, now = Date.now(), loadOffers = null, leagueContext = null } = {}) {
  const has = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'offer_value_gain_log'`).get();
  if (!has) return { skipped: 'migration 112 not applied' };
  const load = loadOffers ?? (async d => (await import('./eval/decided-offers.js')).loadDecidedOffers(d));
  const ctxOf = leagueContext ?? defaultLeagueContext;
  const built = await load(database);
  const done = new Set(database.prepare('SELECT offer_id FROM offer_value_gain_log').all().map(r => r.offer_id));
  const fc = fcValues({ rows: (sql, ...p) => database.prepare(sql).all(...p) });
  const at = new Date(now).toISOString();
  const cache = new Map();
  let wrote = 0, skipped = 0;
  const insert = database.prepare(`INSERT OR IGNORE INTO offer_value_gain_log (offer_id, league_id, season, counterparty_team_id,
      proposed_at, fc_gain, need_met, blue_chip_given, days_to_deadline, outcome, features_as_of, logged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const o of built.offers ?? []) {
    const id = offerKey(o);
    if (done.has(id)) continue;
    const items = termItems(o.terms);
    if (!items) { skipped++; continue; }
    if (!cache.has(o.league_id)) {
      const lg = database.prepare('SELECT * FROM leagues WHERE id = ?').get(o.league_id);
      cache.set(o.league_id, lg ? { lg, ...(await ctxOf(lg)) } : null);
    }
    const c = cache.get(o.league_id);
    if (!c) { skipped++; continue; }
    const cp = String(o.counterparty_team_id);
    const toId = e => c.espnToId.get(Number(e)) ?? null;
    const received = items.filter(i => String(i.toTeamId) === cp).map(i => toId(i.playerId));
    const sent = items.filter(i => String(i.fromTeamId) === cp).map(i => toId(i.playerId));
    const f = received.includes(null) || sent.includes(null)
      ? { fc_gain: null, need_met: null, blue_chip_given: null, days_to_deadline: null }
      : valueGainFeatures({ received, sent }, { fc, scores: c.scores, needs: c.needs?.get(cp) ?? null,
        positionOf: c.positionOf, deadlineMs: tradeDeadlineMs(c.lg), atMs: Date.parse(o.proposed_at) });
    const r = insert.run(id, o.league_id, o.season ?? null, cp, o.proposed_at ?? null, f.fc_gain, f.need_met, f.blue_chip_given,
      f.days_to_deadline, Number.isFinite(o.y) ? o.y : null, at, at);
    wrote += Number(r.changes ?? 0);
    done.add(id);
  }
  return { logged: wrote, skipped, fc: fc.status };
}

/**
 * A stable id per offer. decided-offers.js ids an offer by its ESPN proposal tx; an app-made
 * offer with no tx id reads '<league>:null' there (four on league 4, 2026-09-25), so those are
 * keyed on their answer, proposal time and counterparty instead.
 */
export function offerKey(o) {
  const id = o.offer_id != null ? String(o.offer_id) : null;
  if (id && !id.endsWith(':null')) return id;
  return `${o.league_id}:app:${o.decision_tx_id ?? ''}:${o.proposed_at ?? ''}:${o.counterparty_team_id ?? ''}`;
}

function termItems(t) {
  if (!t) return null;
  const list = Array.isArray(t) ? t : [...(t.give ?? []), ...(t.get ?? [])];
  const xs = list.filter(i => i && i.playerId != null);
  return xs.length ? xs : null;
}

async function defaultLeagueContext(lg) {
  const te = await import('./trade-engine.js');
  const { deriveFormat } = await import('./format.js');
  const { servedScores } = await import('./campaign/never-give.js');
  const assets = te.assetUniverse(lg, deriveFormat(lg).formatKey);
  const teams = te.loadRosters(lg, assets);
  const espnToId = new Map();
  const pos = new Map();
  for (const a of assets.values()) {
    if (a.espn_id != null) espnToId.set(Number(a.espn_id), a.id);
    pos.set(a.id, a.position);
  }
  const bc = servedScores(lg.id);
  return { teams, espnToId, positionOf: id => pos.get(id) ?? null, needs: positionalNeeds(teams),
    scores: bc.status === 'ok' ? bc.byId : null };
}
