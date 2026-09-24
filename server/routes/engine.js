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
 * GET /api/engine/snapshot?league_id=   the league's newest snapshot (0 = global): its cut,
 *                                       versions, fallbacks in force, dice and age (§2.7)
 * GET /api/engine/view?view=&league_id=&snapshot_id=
 *                                       a declared view resolved at ONE snapshot (§4.6);
 *                                       snapshot_id is required: a page pins one per load
 * GET /api/engine/status                 daemon heartbeat, lock, watermarks, producers,
 *                                       fallbacks, snapshots, Jev spend (UI-ENG-6 strip)
 * GET /api/engine/request/:id            one engine request the caller made, and its state
 *
 * This process is the web server: it registers nothing and imports no writer. Field
 * specs come from engine_fields (written by the engine). GET only.
 */
import { Router } from 'express';
import { db, dbPath } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { getState, readServed, isLeagueScoped, ENTITY_KEYS } from '../services/engine/state.js';
import { normalizeAsOf } from '../services/engine/events.js';
import { readFieldSpec, readFallback, freshAt } from '../services/engine/fields.js';
import { rowStatus, engineStatus } from '../services/engine/status.js';
import { VIEWS, resolveView, snapshotById, latestSnapshotFor, snapshotOut } from '../services/engine/views.js';

const r = Router();

function stateOut(row) {
  return {
    field: row.field, value: row.value, as_of: row.as_of, producer: row.producer, producer_version: row.producer_version,
    lane: row.lane, event_ids: row.event_ids, reason_chain: row.reason_chain, run_id: row.run_id, written_at: row.written_at,
  };
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
  const [status, reason] = served.fallback_used ? ['fallback', served.reason] : rowStatus(row, spec, fresh, asOf);
  res.json({ ...base, status, reason, state: stateOut(row), health: row.health, fresh_at: fresh,
    fallback_used: served.fallback_used, fallback: served.fallback });
});

/** A league id from the query (null when absent), checked for membership; throws 400 on junk. */
function leagueParam(req) {
  const raw = req.query.league_id;
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) throw Object.assign(new Error('league_id must be a non-negative integer'), { status: 400 });
  if (id !== 0) assertLeagueMember(req.auth?.userId, id);
  return id;
}

r.get('/snapshot', (req, res) => {
  const leagueId = leagueParam(req);
  const s = latestSnapshotFor(leagueId ?? 0, db);
  if (!s) return res.json({ status: 'unknown', reason: 'no_snapshot_published', league_id: leagueId ?? 0, snapshot: null });
  res.json({ status: 'ok', reason: null, league_id: s.league_id, snapshot: snapshotOut(s) });
});

r.get('/view', (req, res) => {
  const view = VIEWS[String(req.query.view ?? '')];
  if (!view) return res.status(404).json({ error: `unknown view "${req.query.view ?? ''}"`, views: Object.keys(VIEWS) });
  const leagueId = leagueParam(req);
  const snapshotId = Number(req.query.snapshot_id);
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
    return res.status(400).json({ error: 'snapshot_id is required: read /snapshot once per page and pass its id' });
  }
  if (view.scope === 'league' && leagueId == null) return res.status(400).json({ error: `view ${view.name} needs league_id` });
  const s = snapshotById(snapshotId, db);
  if (!s) return res.status(404).json({ error: `no snapshot ${snapshotId}` });
  if (s.league_id !== 0 && s.league_id !== leagueId) {
    return res.status(400).json({ error: `snapshot ${snapshotId} is league ${s.league_id}'s, not league ${leagueId ?? 0}'s` });
  }
  if (s.league_id === 0 && view.scope === 'league') {
    return res.status(400).json({ error: `snapshot ${snapshotId} is the global one; view ${view.name} needs the league's` });
  }
  res.json({ ...resolveView({ view, snapshot: s, leagueId }, db), snapshot: snapshotOut(s) });
});

r.get('/status', (_req, res) => {
  res.json(engineStatus(db, { dbPath }));
});

r.get('/request/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'request id must be a positive integer' });
  const q = db.prepare(`SELECT id, kind, params_hash, snapshot_id, requested_by, requested_at, lease_until, started_at, done_at,
      result_state_id, error FROM engine_requests WHERE id = ?`).get(id);
  // Another user's request is indistinguishable from a missing one.
  if (!q || (q.requested_by != null && q.requested_by !== req.auth?.userId)) return res.status(404).json({ error: `no request ${id}` });
  const status = q.error ? 'error' : q.done_at ? 'done' : q.started_at ? 'running' : 'queued';
  res.json({ ...q, status });
});

export default r;
