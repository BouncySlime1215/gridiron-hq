/**
 * GET /api/engine/state — the read-only door pages and Coach use into the engine's
 * world state (ENGINE-00a).
 *
 *   ?entity=<type>:<id>   e.g. engine:events, player:9001, league_team:3:10
 *                         (split on the FIRST colon; ids may contain colons)
 *   &field=<field>        a registered field, e.g. engine.ingest
 *   &as_of=<ISO time>     optional, default now; nothing stamped after it is returned
 *   &league_id=<id>       optional; league-scoped rows need league membership
 *
 * Returns the row with its value, as_of, producer, producer_version, event_ids and
 * reason_chain, or `state: null` with the absence named. No writes: this router
 * registers GET only.
 */
import { Router } from 'express';
import { assertLeagueMember } from '../platform/auth.js';
import { getState } from '../services/engine/state.js';
import { normalizeAsOf } from '../services/engine/events.js';
import { fieldSpec } from '../services/engine/registry.js';
// Registers the spine's event types and its own field before any read.
import '../services/engine/backfill.js';

const r = Router();

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
  let leagueId = null;
  if (req.query.league_id != null && req.query.league_id !== '') {
    leagueId = Number(req.query.league_id);
    if (!Number.isInteger(leagueId)) return res.status(400).json({ error: 'league_id must be an integer' });
    assertLeagueMember(req.auth?.userId, leagueId);
  }
  const entityType = entity.slice(0, cut);
  const entityId = entity.slice(cut + 1);
  const base = { entity_type: entityType, entity_id: entityId, field, league_id: leagueId, as_of_requested: asOf };
  if (!fieldSpec(field)) return res.json({ ...base, state: null, absence: 'field_not_registered' });
  const state = getState(entityType, entityId, field, { asOf, leagueId });
  if (!state) return res.json({ ...base, state: null, absence: 'no_row_as_of' });
  res.json({
    ...base,
    state: {
      value: state.value, as_of: state.as_of, producer: state.producer, producer_version: state.producer_version,
      event_ids: state.event_ids, reason_chain: state.reason_chain, written_at: state.written_at,
    },
    absence: null,
  });
});

export default r;
