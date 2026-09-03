import { db, rows, row, run } from '../db/index.js';
import { slotForPick, isDraftComplete, assignRosterSlots, DEFAULT_ROSTER_POSITIONS } from './engine.js';
import { AuthenticationError, AuthorizationError, assertCommissioner, assertLeagueMember, ownsDraftTeam } from '../platform/auth.js';

export class DraftNotFoundError extends Error { constructor(msg) { super(msg); this.status = 404; } }
export class DraftValidationError extends Error { constructor(msg) { super(msg); this.status = 400; } }
export class DraftConflictError extends Error { constructor(msg) { super(msg); this.status = 409; } }

// Module-private capability: unlike a boolean/object flag, external callers cannot
// construct this identity to impersonate the durable clock.
const SYSTEM_CLOCK_ACTOR = Symbol('draft-system-clock');

// node:sqlite's DatabaseSync executes every statement synchronously and this
// module never awaits mid-transaction, so within one Node process a single
// read-modify-write here always runs to completion before the next request's
// handler starts (no interleaving to race). BEGIN IMMEDIATE additionally
// takes the write lock up front, so it also fails fast/serializes correctly
// against any other process (a second CLI script, a test runner) touching the
// same SQLite file concurrently, rather than relying on Node's single
// threading alone.
function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function requireDraft(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw new DraftNotFoundError('draft not found');
  return draft;
}

function authenticatedActor(actor) {
  if (!actor || !Number.isInteger(Number(actor.userId))) throw new AuthenticationError();
  return Number(actor.userId);
}

// A mock draft has no league_row_id, so there is no league_memberships row to
// check — assertLeagueMember/assertCommissioner reject every leagueless draft
// unconditionally. Its one owner is implicitly its own commissioner: the real
// per-team gate for actual picks is ownsDraftTeam() against draft_team_ownership,
// not a league role, so synthesising 'commissioner' here only grants access to
// the commissioner-only *draft-management* actions (pause, undo, simulate),
// which for a solo mock draft the owner should always have anyway.
function memberActor(actor, draft) {
  const userId = authenticatedActor(actor);
  if (draft.league_row_id == null) return { userId, role: 'commissioner' };
  const membership = assertLeagueMember(userId, draft.league_row_id);
  return { userId, role: membership.role };
}

function commissionerActor(actor, draft) {
  const userId = authenticatedActor(actor);
  if (draft.league_row_id == null) return { userId, role: 'commissioner' };
  return { userId, role: assertCommissioner(userId, draft.league_row_id).role };
}

function logEvent(draftId, type, payload, actor, role) {
  const seq = (row('SELECT COALESCE(MAX(seq),0) AS m FROM draft_events WHERE draft_id = ?', draftId).m) + 1;
  run('INSERT INTO draft_events (draft_id, seq, type, payload, actor, role) VALUES (?,?,?,?,?,?)',
    draftId, seq, type, JSON.stringify(payload), actor ?? null, role ?? null);
  return seq;
}

/** Bumps revision, recomputes the server-owned pick clock, and flips status to completed when done. */
function toSqliteDatetime(ms) {
  // Convert to SQLite's `YYYY-MM-DD HH:MM:SS` form so comparisons with
  // datetime('now') work correctly inside SQL. Keep seconds precision.
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseRosterPositions(json) {
  if (!json) return DEFAULT_ROSTER_POSITIONS;
  try { return JSON.parse(json); } catch { return DEFAULT_ROSTER_POSITIONS; }
}

function advanceDraftState(draft, picksMade) {
  const complete = isDraftComplete(draft, picksMade);
  const deadline = (!complete && draft.type === 'mock' && !draft.paused)
    ? toSqliteDatetime(Date.now() + (draft.pick_seconds ?? 90) * 1000)
    : null;
  run('UPDATE drafts SET revision = revision + 1, turn_deadline = ?, status = ? WHERE id = ?',
    deadline, complete ? 'completed' : 'active', draft.id);
  return row('SELECT * FROM drafts WHERE id = ?', draft.id);
}

export function getDraft(draftId) {
  return requireDraft(draftId);
}

/**
 * Makes one pick, atomically inserting draft_picks, clearing the player from
 * every team's queue, logging the event, and advancing draft state (revision
 * bump, next turn's deadline, completion) as a single transaction.
 *
 * - `expectedRevision`, if given, rejects the request with 409 when the
 *   draft has moved on since the client last read it (stale request guard).
 * - `idempotencyKey`, if given and already used for this draft, replays the
 *   original result instead of erroring — safe to retry on a timeout/network
 *   drop without risking a duplicate or a false "already drafted" error.
 */
export function makePick({ draftId, playerId, expectedRevision = null, idempotencyKey = null, actor = null, source = 'user', reason = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    let actorId = 'system', actorRole = 'system';
    if (source === 'auto' && actor === SYSTEM_CLOCK_ACTOR) {
      // The durable clock is the sole non-user mutation path.
    } else {
      const access = memberActor(actor, draft);
      actorId = access.userId;
      actorRole = access.role;
      // memberActor() already synthesised 'commissioner' for a leagueless draft;
      // re-checking against league_memberships here would reject it again.
      if (source !== 'user' && draft.league_row_id != null) assertCommissioner(actorId, draft.league_row_id);
    }

    if (idempotencyKey) {
      const existing = row('SELECT * FROM draft_picks WHERE draft_id = ? AND idempotency_key = ?', draftId, idempotencyKey);
      if (existing) return { pick: existing, draft, replayed: true };
    }

    if (expectedRevision != null && Number(expectedRevision) !== draft.revision) {
      throw new DraftConflictError(`stale request: draft is at revision ${draft.revision}, request expected ${expectedRevision}`);
    }

    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
    if (isDraftComplete(draft, picksMade)) throw new DraftValidationError('draft is complete');

    // Validate player existence early so we can check position-related rules.
    const playerRow = row('SELECT id, position FROM players WHERE id = ?', playerId);
    if (!Number.isInteger(playerId) || !playerRow) {
      throw new DraftValidationError('player not found');
    }
    if (row('SELECT 1 FROM draft_picks WHERE draft_id = ? AND player_id = ?', draftId, playerId)) {
      throw new DraftValidationError('player already drafted');
    }

    const pickNumber = picksMade + 1;
    const teamSlot = slotForPick(pickNumber, draft.team_count, draft.order_type);

    // Enforce paused state: no user picks while paused.
    if (draft.paused) throw new DraftValidationError('draft is paused');

    // Ordinary pick submission is always an owner action. Commissioners have
    // explicit correction/undo/simulation capabilities, but their league role
    // must never silently confer ownership of every team.
    if (source === 'user' && !ownsDraftTeam(actorId, draftId, teamSlot)) {
      throw new AuthorizationError('team ownership required for the team on the clock');
    }

    // Basic roster/bench safety: disallow drafting if the team would exceed its bench cap.
    const teamExisting = rows(`SELECT p.position FROM draft_picks dp JOIN players p ON p.id = dp.player_id WHERE dp.draft_id = ? AND dp.team_slot = ? ORDER BY dp.pick_number`, draftId, teamSlot)
      .map(r => ({ position: r.position }));
    const rosterPositions = parseRosterPositions(draft.roster_positions);
    const afterAssign = assignRosterSlots([...teamExisting, { position: playerRow.position }], rosterPositions);
    const benchCap = rosterPositions.BENCH ?? Infinity;
    if ((afterAssign.bench?.length ?? 0) > benchCap && actorRole !== 'commissioner') {
      throw new DraftValidationError('team bench is full');
    }

    let pickRow;
    try {
      run(`INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, idempotency_key, source, reason)
           VALUES (?,?,?,?,?,?,?)`, draftId, pickNumber, teamSlot, playerId, idempotencyKey, source, reason);
      pickRow = row('SELECT * FROM draft_picks WHERE draft_id = ? AND pick_number = ?', draftId, pickNumber);
    } catch {
      // UNIQUE(draft_id, pick_number) or UNIQUE(draft_id, player_id) fired — a
      // concurrent/duplicate request for the same slot or the same player.
      throw new DraftValidationError('player already drafted');
    }

    run('DELETE FROM draft_queue WHERE draft_id = ? AND player_id = ?', draftId, playerId);
    logEvent(draftId, 'pick', { pick_number: pickNumber, team_slot: teamSlot, player_id: playerId, source }, actorId, actorRole);
    const updated = advanceDraftState(draft, pickNumber);
    return { pick: pickRow, draft: updated, replayed: false };
  });
}

export function undoLastPick({ draftId, actor = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    const access = commissionerActor(actor, draft);
    const last = row('SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_number DESC LIMIT 1', draftId);
    if (!last) throw new DraftValidationError('no picks to undo');
    run('DELETE FROM draft_picks WHERE id = ?', last.id);
    logEvent(draftId, 'undo', {
      pick_number: last.pick_number, team_slot: last.team_slot, player_id: last.player_id,
      idempotency_key: last.idempotency_key, source: last.source
    }, access.userId, access.role);
    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
    const updated = advanceDraftState(draft, picksMade);
    return { undone: last, draft: updated };
  });
}

/** Redo is only available immediately after an undo, before any new pick is made — a fresh action clears it. */
export function redoLastUndo({ draftId, actor = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    const access = commissionerActor(actor, draft);
    const lastEvent = row('SELECT * FROM draft_events WHERE draft_id = ? ORDER BY seq DESC LIMIT 1', draftId);
    if (!lastEvent || lastEvent.type !== 'undo') throw new DraftValidationError('nothing to redo');
    const payload = JSON.parse(lastEvent.payload);
    try {
      run(`INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, idempotency_key, source)
           VALUES (?,?,?,?,?,?)`, draftId, payload.pick_number, payload.team_slot, payload.player_id,
        payload.idempotency_key, payload.source ?? 'user');
    } catch {
      throw new DraftValidationError('cannot redo: current draft state conflicts with the undone pick');
    }
    logEvent(draftId, 'redo', payload, access.userId, access.role);
    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
    const updated = advanceDraftState(draft, picksMade);
    return { redone: payload, draft: updated };
  });
}

/**
 * Commissioner-only fix for the most recent pick (e.g. someone mis-clicked).
 * Deliberately scoped to the last pick only — correcting an arbitrary earlier
 * pick would ripple through every subsequent snake-slot assignment and roster,
 * which is a much larger, higher-risk feature this does not attempt.
 */
export function correctLastPick({ draftId, playerId, actor = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    const access = commissionerActor(actor, draft);
    const last = row('SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_number DESC LIMIT 1', draftId);
    if (!last) throw new DraftValidationError('no picks to correct');
    if (!Number.isInteger(playerId) || !row('SELECT id FROM players WHERE id = ?', playerId)) {
      throw new DraftValidationError('player not found');
    }
    if (playerId === last.player_id) throw new DraftValidationError('correction must select a different player');
    if (row('SELECT 1 FROM draft_picks WHERE draft_id = ? AND player_id = ? AND id != ?', draftId, playerId, last.id)) {
      throw new DraftValidationError('player already drafted');
    }
    run('UPDATE draft_picks SET player_id = ? WHERE id = ?', playerId, last.id);
    logEvent(draftId, 'correction', {
      pick_number: last.pick_number, team_slot: last.team_slot,
      from_player_id: last.player_id, to_player_id: playerId
    }, access.userId, access.role);
    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
    const updated = advanceDraftState(draft, picksMade);
    return { corrected: { pick_number: last.pick_number, team_slot: last.team_slot, player_id: playerId }, draft: updated };
  });
}

export function setPaused({ draftId, paused, actor = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    const access = commissionerActor(actor, draft);
    run('UPDATE drafts SET paused = ? WHERE id = ?', paused ? 1 : 0, draftId);
    const refreshed = row('SELECT * FROM drafts WHERE id = ?', draftId);
    logEvent(draftId, paused ? 'pause' : 'resume', {}, access.userId, access.role);
    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
    return advanceDraftState(refreshed, picksMade);
  });
}

export function getQueue(draftId, teamSlot) {
  return rows('SELECT player_id, position FROM draft_queue WHERE draft_id = ? AND team_slot = ? ORDER BY position',
    draftId, teamSlot);
}

/** Replaces a team's entire queue with `playerIds`, in order — simplest robust model for drag-to-reorder. */
export function setQueue({ draftId, teamSlot, playerIds, actor = null }) {
  return withTransaction(() => {
    const draft = requireDraft(draftId);
    const access = memberActor(actor, draft);
    if (!ownsDraftTeam(access.userId, draftId, teamSlot)) {
      throw new AuthorizationError('team ownership required');
    }
    run('DELETE FROM draft_queue WHERE draft_id = ? AND team_slot = ?', draftId, teamSlot);
    playerIds.forEach((pid, i) => {
      run('INSERT INTO draft_queue (draft_id, team_slot, player_id, position) VALUES (?,?,?,?)', draftId, teamSlot, pid, i);
    });
    logEvent(draftId, 'queue', { team_slot: teamSlot, player_ids: playerIds }, access.userId, access.role);
    return getQueue(draftId, teamSlot);
  });
}

export function firstAvailableFromQueue(draftId, teamSlot) {
  for (const item of getQueue(draftId, teamSlot)) {
    if (!row('SELECT 1 FROM draft_picks WHERE draft_id = ? AND player_id = ?', draftId, item.player_id)) {
      return item.player_id;
    }
  }
  return null;
}

/**
 * Server-owned clock enforcement: picks up any mock draft whose turn_deadline
 * has passed (including ones missed entirely because the server was down —
 * this is what makes the clock durable across restarts) and auto-picks for
 * whoever is on the clock, preferring their persisted queue and falling back
 * to `chooseFallback(draft, teamSlot)` when the queue is empty or exhausted.
 */
export function autoPickOverdueDrafts({ chooseFallback }) {
  const overdue = rows(`SELECT * FROM drafts WHERE status = 'active' AND paused = 0 AND type = 'mock'
                        AND turn_deadline IS NOT NULL AND turn_deadline <= datetime('now')`);
  const results = [];
  for (const draft of overdue) {
    const picksMade = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
    if (isDraftComplete(draft, picksMade)) continue;
    const teamSlot = slotForPick(picksMade + 1, draft.team_count, draft.order_type);
    let playerId = firstAvailableFromQueue(draft.id, teamSlot);
    if (playerId == null) playerId = chooseFallback(draft, teamSlot);
    if (playerId == null) continue; // nothing pickable; leave the deadline for the next tick rather than spin
    try {
      results.push({ draftId: draft.id, ...makePick({
        draftId: draft.id, playerId, expectedRevision: draft.revision, actor: SYSTEM_CLOCK_ACTOR, source: 'auto'
      }) });
    } catch (e) {
      console.error(`[draft] auto-pick failed for draft ${draft.id}:`, e.message);
    }
  }
  return results;
}
