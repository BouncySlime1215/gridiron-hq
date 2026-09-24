/**
 * GET /api/engine/state — the read-only door pages and Coach use into the engine's world
 * state (ENGINE-00a; EA-00 typed status, ENGINE-ARCHITECTURE.md §2.12, §3.5).
 *
 *   ?entity=<type>:<id>   e.g. engine:events, player:9001, league_team:3:10
 *                         (split on the FIRST colon; ids may contain colons)
 *   &field=<field>        a field with a spec in engine_fields
 *   &as_of=<ISO time>     optional, default now; nothing stamped after it is returned
 *   &league_id=<id>       required for league-scoped entities; needs league membership
 *   &lane=live|shadow     optional, default live
 *
 * Every answer carries a typed `status` and a `reason`:
 *   ok        a healthy row
 *   zero      a measured absence of the thing (value null, absence zero): a real 0
 *   unknown   no row as of then, the field is not registered, or the row says unknown
 *   stale     the producer has not run within the field's max_age_sec before as_of
 *   fallback  the monitor has the field on its fallback: the fallback field's row is served
 *   thin      the row is healthy but built on missing/fallback inputs
 *   degraded  the row's own health is degraded and nothing healthy can stand in for it
 *   failed    the row failed its checks and there is no fallback or healthy row: state null
 *   league_id_required  a league-scoped entity asked for without league_id (400)
 * plus `health`, `fresh_at` (the later of the row's as_of and the producer's last
 * successful run), `fallback_used` and `fallback`. A failed or degraded row is never
 * served as itself when something healthy can stand in: the field's declared fallback
 * field, else its last good row (HEALTH-01b, engine/state.js#readServed), labelled
 * `fallback` with the reason. The failed value itself is never in the response.
 *
 * This process is the web server: it registers nothing and imports no writer. Field
 * specs come from engine_fields (written by the engine). GET only.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { getState, readServed, isLeagueScoped, ENTITY_KEYS } from '../services/engine/state.js';
import { normalizeAsOf } from '../services/engine/events.js';
import { readFieldSpec, readFallback, freshAt } from '../services/engine/fields.js';

const r = Router();

function stateOut(row) {
  return {
    field: row.field, value: row.value, as_of: row.as_of, producer: row.producer, producer_version: row.producer_version,
    lane: row.lane, event_ids: row.event_ids, reason_chain: row.reason_chain, run_id: row.run_id, written_at: row.written_at,
  };
}

function statusOf(row, spec, fresh, asOf) {
  const absence = row.health?.absence;
  if (row.value == null && absence) {
    return absence.status === 'zero' ? ['zero', absence.reason] : ['unknown', `${absence.status}: ${absence.reason}`];
  }
  if (row.health?.status === 'degraded') return ['degraded', 'the row was built on degraded inputs'];
  if (row.health?.inputs_health === 'thin') return ['thin', 'some inputs were missing or served from a fallback'];
  if (spec.maxAgeSec != null && (!fresh || Date.parse(asOf) - Date.parse(fresh) > spec.maxAgeSec * 1000)) {
    return ['stale', `no run of ${spec.producer} within ${spec.maxAgeSec}s before ${asOf}`];
  }
  return ['ok', null];
}

r.get('/state', (req, res) => {
  const entity = String(req.query.entity ?? '');
  const field = String(req.query.field ?? '');
  const cut = entity.indexOf(':');
  if (cut <= 0 || cut === entity.length - 1 || !field) {
    return res.status(400).json({ error: 'entity=<type>:<id> and field=<field> are required' });
  }
  let asOf;
  try {
    asOf = normalizeAsOf(req.query.as_of ?? new Date());
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const lane = req.query.lane == null || req.query.lane === '' ? 'live' : String(req.query.lane);
  if (!['live', 'shadow'].includes(lane)) return res.status(400).json({ error: 'lane must be live or shadow' });
  const entityType = entity.slice(0, cut);
  const entityId = entity.slice(cut + 1);
  let leagueId = null;
  if (req.query.league_id != null && req.query.league_id !== '') {
    leagueId = Number(req.query.league_id);
    if (!Number.isInteger(leagueId)) return res.status(400).json({ error: 'league_id must be an integer' });
    assertLeagueMember(req.auth?.userId, leagueId);
  }
  const base = { entity_type: entityType, entity_id: entityId, field, league_id: leagueId, lane, as_of_requested: asOf };
  const absent = (status, reason, extra = {}) => ({ ...base, status, reason, state: null, health: null, fresh_at: null,
    fallback_used: false, fallback: null, ...extra });
  if (isLeagueScoped(entityType) && leagueId == null) {
    return res.status(400).json(absent('league_id_required', `${entityType} is league-scoped: pass league_id`));
  }
  if (!ENTITY_KEYS[entityType]) return res.json(absent('unknown', 'entity_type_not_registered'));
  const spec = readFieldSpec(field, db);
  if (!spec) return res.json(absent('unknown', 'field_not_registered'));

  const fb = lane === 'live' ? readFallback(field, leagueId, db) : null;
  if (fb && fb.since <= asOf) {
    const fbRow = getState(entityType, entityId, fb.fallback_field, { asOf, leagueId, lane });
    if (!fbRow) return res.json(absent('unknown', `fallback ${fb.fallback_field} in force (${fb.reason}); it has no row as of then`));
    return res.json({ ...base, status: 'fallback', reason: `${field} is on its fallback ${fb.fallback_field}: ${fb.reason}`,
      state: stateOut(fbRow), health: fbRow.health, fallback_used: true,
      fallback: { kind: 'monitor', field: fb.fallback_field, row_id: fbRow.id, as_of: fbRow.as_of },
      fresh_at: freshAt({ producer: fbRow.producer, leagueId, rowAsOf: fbRow.as_of, ref: asOf }, db) });
  }
  const served = readServed(entityType, entityId, field, { asOf, leagueId, lane }, db);
  if (!served.row) return res.json(absent(served.status, served.reason, { health: served.health }));
  const row = served.row;
  const fresh = freshAt({ producer: row.producer, leagueId, rowAsOf: row.as_of, ref: asOf }, db);
  const [status, reason] = served.fallback_used ? ['fallback', served.reason] : statusOf(row, spec, fresh, asOf);
  res.json({ ...base, status, reason, state: stateOut(row), health: row.health, fresh_at: fresh,
    fallback_used: served.fallback_used, fallback: served.fallback });
});

export default r;
