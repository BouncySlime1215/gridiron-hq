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
 *   fallback  the monitor has the field on its fallback: the fallback field's row is served,
 *             or, when it has none, the field's row as of the last healthy snapshot
 *   thin      the row is healthy but built on missing/fallback inputs
 *   degraded  the row's own health is degraded
 *   league_id_required  a league-scoped entity asked for without league_id (400)
 * plus `health` and `fresh_at` (the later of the row's as_of and the producer's last
 * successful run). A failed row is never served: the last good row is.
 *
 * This process is the web server: it registers nothing and imports no writer. Field
 * specs come from engine_fields (written by the engine). GET only.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { getState, isLeagueScoped, ENTITY_KEYS } from '../services/engine/state.js';
import { normalizeAsOf } from '../services/engine/events.js';
import { readFieldSpec, readFallback, freshAt } from '../services/engine/fields.js';
import { readServed } from '../services/engine/served.js';

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
  const absent = (status, reason, extra = {}) => ({ ...base, status, reason, state: null, health: null, fresh_at: null, ...extra });
  if (isLeagueScoped(entityType) && leagueId == null) {
    return res.status(400).json(absent('league_id_required', `${entityType} is league-scoped: pass league_id`));
  }
  if (!ENTITY_KEYS[entityType]) return res.json(absent('unknown', 'entity_type_not_registered'));
  const spec = readFieldSpec(field, db);
  if (!spec) return res.json(absent('unknown', 'field_not_registered'));

  const fb = lane === 'live' ? readFallback(field, leagueId, db) : null;
  if (fb && fb.since <= asOf) {
    // the fallback field's row, else the field as of the last healthy snapshot (served.js, EA-06)
    const served = readServed(entityType, entityId, field, { asOf, leagueId }, db);
    if (!served.row) return res.json(absent('unknown', served.absence.reason, { fallback: served.fallback }));
    const target = served.fallback.kind === 'snapshot' ? `the last healthy snapshot #${served.fallback.snapshot_id}` : fb.fallback_field;
    return res.json({ ...base, status: 'fallback', reason: `${field} is on its fallback ${target}: ${fb.reason}`,
      state: { ...stateOut(served.row), reason_chain: served.reason_chain }, health: served.row.health, fallback: served.fallback,
      fresh_at: freshAt({ producer: served.row.producer, leagueId, rowAsOf: served.row.as_of, ref: asOf }, db) });
  }
  const row = getState(entityType, entityId, field, { asOf, leagueId, lane });
  if (!row) return res.json(absent('unknown', 'no_row_as_of'));
  const fresh = freshAt({ producer: row.producer, leagueId, rowAsOf: row.as_of, ref: asOf }, db);
  const [status, reason] = statusOf(row, spec, fresh, asOf);
  res.json({ ...base, status, reason, state: stateOut(row), health: row.health, fresh_at: fresh });
});

export default r;
