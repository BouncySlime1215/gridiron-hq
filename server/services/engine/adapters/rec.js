/**
 * Decisions as events: `offer.sent` and `rec.shown` / `rec.considered` / `rec.graded`
 * (ENGINE-ARCHITECTURE.md §5, §7.1, §7.3).
 *
 * offer.sent   from `trade_outcomes` rows the app sent (source 'app_proposed'); as_of
 *              proposed_at (else created_at, first_seen). A considered-only row is not an
 *              offer: it stays `trade.considered` (backfill.js).
 * rec.*        from `rec_ledger` (#174, migration 071): shown / considered_not_shown at
 *              made_at, and `rec.graded` at graded_at once #174's settle pass fills it.
 *              #174 is on main; on a DB without it (before 071) this stream reports table_absent.
 *
 * snapshot_id  what makes "replay any decision exactly" real. For a rec row it is
 *              `predicted_json.snapshot_id` when the writer put one there (§7.1: no schema
 *              change to 071); otherwise, and always for an offer, it is the league's
 *              engine snapshot IN FORCE at the decision time (the latest engine_snapshots
 *              row with created_at <= as_of). None in force is null with
 *              snapshot_basis 'none_in_force', never a guessed id.
 *
 * The app's own numbers (the P(accept) band, the predicted payload) go under payload.model,
 * which getEvents strips for learners (a model's output is never a learner's feature).
 * The before-the-fact title-delta distribution (§7.3) is not in trade_outcomes yet:
 * `delta_dist` is null with its reason until OFFER-01 logs it.
 */
import { registerEventType } from '../registry.js';

registerEventType('offer.sent', { description: 'A trade offer the app sent (trade_outcomes app_proposed), with the snapshot in force' });
registerEventType('rec.shown', { description: 'A recommendation shown (rec_ledger), with its snapshot' });
registerEventType('rec.considered', { description: 'A recommendation considered and not shown (rec_ledger), with its snapshot' });
registerEventType('rec.graded', { description: 'A rec_ledger row settled by its own grader (score, outcome)' });

const present = v => v != null && v !== '';
// An unparseable JSON column is not dropped silently: it becomes {unparseable: true} in the payload.
const parse = (s, fallback) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return { unparseable: true }; }
};
// Keys appendEvents refuses in a payload (events.js FORBIDDEN_KEYS, free text and secrets).
// A predicted payload is the app's structured output; any such key in it is dropped here
// so one row cannot fail the whole stream.
const DROP = new Set(['text', 'body', 'message', 'messages', 'msg', 'content', 'espn_s2', 'swid', 'cookie', 'password', 'token']);
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k.toLowerCase())).map(([k, x]) => [k, clean(x)]));
}

/** {leagueId: [{id, created_at}] ascending}: the snapshot in force at a time is a lookup. */
function snapshotIndex(database) {
  const by = new Map();
  for (const s of database.prepare('SELECT id, league_id, created_at FROM engine_snapshots ORDER BY created_at, id').all()) {
    const l = Number(s.league_id);
    if (!by.has(l)) by.set(l, []);
    by.get(l).push({ id: Number(s.id), created_at: s.created_at });
  }
  return by;
}
export function snapshotInForce(index, leagueId, asOf) {
  let found = null;
  for (const s of index.get(Number(leagueId)) ?? []) {
    if (s.created_at <= asOf) found = s.id; else break;
  }
  return found;
}
const snapshotFields = id => ({ snapshot_id: id, snapshot_basis: id == null ? 'none_in_force' : 'in_force_at_decision' });

const team = (leagueId, teamId, role) => (present(teamId) && Number(teamId) > 0
  ? { type: 'league_team', id: `${leagueId}:${teamId}`, role } : null);

export const OFFER_ADAPTER = Object.freeze({
  stream: 'offers', table: 'trade_outcomes', source: 'trade_outcomes.offer',
  sql: t => `SELECT * FROM (SELECT id, league_id, season, proposer_team_id, counterparty_team_id, give_json, get_json,
               proposed_at, created_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
               idea_id FROM ${t} WHERE source = 'app_proposed' AND status <> 'not_proposed')`,
  context: database => ({ snapshots: snapshotIndex(database) }),
  map: (r, { snapshots }) => {
    const [asOf, quality] = present(r.proposed_at) ? [r.proposed_at, 'exact'] : [r.created_at, 'first_seen'];
    return [{
      event_type: 'offer.sent', as_of: asOf, as_of_quality: quality, league_id: r.league_id, team_id: r.proposer_team_id,
      natural_key: `offer:${r.id}`,
      entities: [{ type: 'offer', id: String(r.id), role: 'subject' }, team(r.league_id, r.proposer_team_id, 'from'),
        team(r.league_id, r.counterparty_team_id, 'counterparty')].filter(Boolean),
      payload: { trade_outcome_id: r.id, season: r.season, idea_id: r.idea_id ?? null,
        counterparty_team_id: r.counterparty_team_id, give: parse(r.give_json, null), get: parse(r.get_json, null),
        ...snapshotFields(snapshotInForce(snapshots, r.league_id, new Date(asOf).toISOString())),
        delta_dist: null, delta_dist_reason: 'trade_outcomes does not log the before-the-fact title-delta distribution yet (OFFER-01)',
        model: { p_accept: r.model_p_accept, p_accept_low: r.model_p_accept_low, p_accept_high: r.model_p_accept_high,
          basis: r.model_basis, version: r.model_version } },
    }];
  },
});

export const REC_ADAPTER = Object.freeze({
  stream: 'rec', table: 'rec_ledger', source: 'rec_ledger',
  sql: t => `SELECT id, league_id, kind, disposition, made_at, season, week, inputs_hash, predicted_json, baseline_call_json,
               horizon, graded_at, outcome_json, score FROM ${t}`,
  context: database => ({ snapshots: snapshotIndex(database) }),
  map: (r, { snapshots }) => {
    const predicted = parse(r.predicted_json, {}) ?? {};
    const own = Number.isInteger(predicted.snapshot_id) ? predicted.snapshot_id : null;
    const snap = own != null ? { snapshot_id: own, snapshot_basis: 'recorded' }
      : snapshotFields(snapshotInForce(snapshots, r.league_id, new Date(r.made_at).toISOString()));
    const entities = [{ type: 'rec', id: String(r.id), role: 'subject' }, { type: 'league', id: String(r.league_id), role: 'league' }];
    const base = { rec_id: r.id, kind: r.kind, season: r.season, week: r.week, horizon: r.horizon, inputs_hash: r.inputs_hash };
    const out = [{
      event_type: r.disposition === 'shown' ? 'rec.shown' : 'rec.considered', as_of: r.made_at, as_of_quality: 'exact',
      league_id: r.league_id, natural_key: `rec:${r.id}:made`, entities,
      payload: { ...base, ...snap, model: { predicted: clean(predicted), baseline_call: clean(parse(r.baseline_call_json, null)) } },
    }];
    if (present(r.graded_at)) {
      out.push({
        event_type: 'rec.graded', as_of: r.graded_at, as_of_quality: 'exact', league_id: r.league_id,
        natural_key: `rec:${r.id}:graded`, entities,
        payload: { ...base, ...snap, score: r.score ?? null, outcome: clean(parse(r.outcome_json, null)) },
      });
    }
    return out;
  },
});
