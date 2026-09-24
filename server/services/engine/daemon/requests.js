/**
 * Requests from the web (ENGINE-ARCHITECTURE.md §2.8, §9.2): `engine_requests` is the only
 * engine table the web may insert into; the daemon answers.
 *
 * The daemon claims the oldest open request with a lease (60 s by default), runs the
 * handler registered for its kind, and records done_at with the result state id or an
 * error. A request whose lease ran out (a daemon that died mid-request) is claimable again,
 * so a page never polls forever. Dedupe is the table's unique index on
 * (kind, params_hash, snapshot_id): one question at one snapshot is asked once.
 *
 * Handlers start empty: `rescore` arrives with the simulator (EA-07). A request of a kind
 * with no handler is answered with an error naming that, never left open.
 */
import { assertWriteRole } from '../role.js';

const handlers = new Map();

/** Register the handler for one request kind: (request, {database, now}) -> {resultStateId} */
export function registerRequestHandler(kind, handler) {
  if (typeof kind !== 'string' || !kind || typeof handler !== 'function') throw new Error('registerRequestHandler(kind, fn)');
  if (handlers.has(kind)) throw new Error(`request kind ${kind} already has a handler`);
  handlers.set(kind, handler);
  return () => handlers.delete(kind);
}

/** Claim the oldest open request (no done_at; lease empty or expired). Returns the row or null. */
export function claimRequest(database, { now = new Date(), leaseMs = 60000 } = {}) {
  assertWriteRole('claimRequest');
  const at = new Date(now).toISOString();
  const until = new Date(Date.parse(at) + leaseMs).toISOString();
  // Look before taking the write lock: this runs every 250 ms and is almost always empty.
  const open = database.prepare(`SELECT 1 FROM engine_requests WHERE done_at IS NULL AND (lease_until IS NULL OR lease_until < ?)
      LIMIT 1`).get(at);
  if (!open) return null;
  return database.prepare(`UPDATE engine_requests SET lease_until = ?, started_at = COALESCE(started_at, ?)
      WHERE id = (SELECT id FROM engine_requests WHERE done_at IS NULL AND (lease_until IS NULL OR lease_until < ?)
                  ORDER BY id LIMIT 1)
      RETURNING *`).get(until, at, at) ?? null;
}

export function finishRequest(database, id, { resultStateId = null, error = null, now = new Date() } = {}) {
  assertWriteRole('finishRequest');
  database.prepare('UPDATE engine_requests SET done_at = ?, result_state_id = ?, error = ? WHERE id = ?')
    .run(new Date(now).toISOString(), resultStateId, error, Number(id));
}

/**
 * Serve open requests until none is left or `budgetMs` is spent. Returns
 * [{id, kind, ok, error}]. A handler's error is recorded on its request, never thrown.
 */
export async function serveRequests(database, { now = () => new Date(), budgetMs = 1500, leaseMs = 60000 } = {}) {
  const started = Date.now();
  const out = [];
  while (Date.now() - started < budgetMs) {
    const req = claimRequest(database, { now: now(), leaseMs });
    if (!req) break;
    const handler = handlers.get(req.kind);
    if (!handler) {
      finishRequest(database, req.id, { error: `no handler for request kind "${req.kind}" in this daemon`, now: now() });
      out.push({ id: Number(req.id), kind: req.kind, ok: false, error: 'no_handler' });
      continue;
    }
    try {
      const r = await handler({ ...req, params: JSON.parse(req.params_json) }, { database, now: now() });
      finishRequest(database, req.id, { resultStateId: r?.resultStateId ?? null, now: now() });
      out.push({ id: Number(req.id), kind: req.kind, ok: true });
    } catch (error) {
      finishRequest(database, req.id, { error: String(error?.message ?? error).slice(0, 500), now: now() });
      out.push({ id: Number(req.id), kind: req.kind, ok: false, error: String(error?.message ?? error) });
    }
  }
  return out;
}
