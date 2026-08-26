/**
 * Authoritative, transactional reconciliation of a live ESPN draft board against
 * local mirrored state (Phase 3B).
 *
 * Kept separate from espn-draft.js on purpose: this module is the safety-critical
 * core (one DB transaction, no network calls, no `await` inside the transaction)
 * and is unit-testable with synthetic ESPN snapshots with no fetch mocking at all.
 * espn-draft.js owns polling/orchestration and calls into this with pre-resolved
 * player ids and team slots.
 *
 * Invariants this module exists to guarantee:
 *  - A reconciliation either fully applies or fully rolls back (one transaction).
 *  - Replaying an identical snapshot produces zero mutations and zero new audit rows.
 *  - Team ownership and player identity are never guessed; unresolved data is
 *    quarantined, never assigned a fabricated position or team.
 *  - Every applied correction (not every no-op) produces exactly one audit row.
 */
import { rows, row, run, db } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS draft_pick_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    espn_pick_number INTEGER NOT NULL,
    espn_player_id INTEGER NOT NULL,
    espn_team_id INTEGER,
    reason TEXT NOT NULL,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_attempt_at TEXT DEFAULT (datetime('now')),
    attempt_count INTEGER DEFAULT 1,
    resolved_at TEXT,
    UNIQUE(draft_id, espn_pick_number, espn_player_id)
  );

  CREATE TABLE IF NOT EXISTS draft_pick_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    espn_league_id TEXT,
    season INTEGER,
    espn_pick_number INTEGER NOT NULL,
    previous_state TEXT,
    corrected_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_snapshot TEXT,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

/** Stable identity for a pick's mirrored fields — used to detect real changes, not to hash the whole snapshot. */
function pickSignature(p) {
  return JSON.stringify({ player_id: p.player_id, team_slot: p.team_slot, espn_team_id: p.espn_team_id, keeper: Boolean(p.keeper) });
}

/**
 * Reconcile one ESPN snapshot against local state, inside one transaction.
 *
 * @param draftId
 * @param made - ESPN's authoritative picks, already filtered to real (non -1) picks and sorted by overallPickNumber.
 * @param idMap - Map<espnPlayerId, localPlayerId> for every id that WAS resolvable. Missing keys mean "unresolved".
 * @param slotOf - Map<espnTeamId, teamSlot> from the current pick order.
 * @param snapshotId - a caller-supplied identifier for this poll (e.g. ISO timestamp), recorded on any correction rows.
 */
export function reconcileDraftBoard(draftId, made, idMap, slotOf, snapshotId) {
  const local = new Map(rows('SELECT * FROM draft_picks WHERE draft_id = ?', draftId).map(p => [p.pick_number, p]));
  const byPlayer = new Map(rows('SELECT * FROM draft_picks WHERE draft_id = ?', draftId).map(p => [p.player_id, p]));
  const madeNumbers = new Set(made.map(p => p.overallPickNumber));

  const added = [], corrected = [], removed = [], quarantined = [];

  const seenNumbers = new Set();
  db.exec('BEGIN');
  try {
    for (const p of made) {
      const dupWithinSnapshot = seenNumbers.has(p.overallPickNumber);
      seenNumbers.add(p.overallPickNumber);

      const playerId = idMap.get(p.playerId);
      const slot = slotOf.get(p.teamId);
      const reason = playerId == null ? 'player could not be resolved' : slot == null ? `team ${p.teamId} not in pick order` : null;
      if (reason) {
        const existingQ = row('SELECT * FROM draft_pick_quarantine WHERE draft_id=? AND espn_pick_number=? AND espn_player_id=?',
          draftId, p.overallPickNumber, p.playerId);
        if (existingQ) {
          run(`UPDATE draft_pick_quarantine SET last_attempt_at=datetime('now'), attempt_count=attempt_count+1, reason=?, espn_team_id=? WHERE id=?`,
            reason, p.teamId ?? null, existingQ.id);
        } else {
          run(`INSERT INTO draft_pick_quarantine (draft_id, espn_pick_number, espn_player_id, espn_team_id, reason) VALUES (?,?,?,?,?)`,
            draftId, p.overallPickNumber, p.playerId, p.teamId ?? null, reason);
        }
        quarantined.push({ pick: p.overallPickNumber, reason });
        continue;
      }

      // A previously-quarantined pick that just became resolvable: clear it.
      run(`UPDATE draft_pick_quarantine SET resolved_at=datetime('now') WHERE draft_id=? AND espn_pick_number=? AND espn_player_id=? AND resolved_at IS NULL`,
        draftId, p.overallPickNumber, p.playerId);

      const next = { player_id: playerId, team_slot: slot, espn_team_id: p.teamId, keeper: p.keeper ? 1 : 0 };
      const existingAtNumber = local.get(p.overallPickNumber);
      const existingForPlayer = byPlayer.get(playerId);

      if (dupWithinSnapshot) {
        // Same pick number appeared twice in one ESPN response. If it's the exact same
        // player both times, the first occurrence already applied it — harmless. If it
        // names a DIFFERENT player, that's a genuine ESPN data anomaly: writing it would
        // either collide with UNIQUE(draft_id, pick_number) or silently overwrite a valid
        // pick based on response ordering alone. Quarantine rather than guess.
        if (!existingAtNumber || existingAtNumber.player_id !== playerId) {
          const q = row('SELECT * FROM draft_pick_quarantine WHERE draft_id=? AND espn_pick_number=? AND espn_player_id=?',
            draftId, p.overallPickNumber, p.playerId);
          const dupReason = 'duplicate pick number within one ESPN snapshot';
          if (q) run(`UPDATE draft_pick_quarantine SET last_attempt_at=datetime('now'), attempt_count=attempt_count+1, reason=? WHERE id=?`, dupReason, q.id);
          else run(`INSERT INTO draft_pick_quarantine (draft_id, espn_pick_number, espn_player_id, espn_team_id, reason) VALUES (?,?,?,?,?)`,
            draftId, p.overallPickNumber, p.playerId, p.teamId ?? null, dupReason);
          quarantined.push({ pick: p.overallPickNumber, reason: dupReason });
        }
        continue;
      }

      if (existingForPlayer && existingForPlayer.pick_number !== p.overallPickNumber) {
        // Same player now claims a different pick number: a renumber, not a new pick.
        // Moving it (not inserting a second row) is what keeps replay idempotent —
        // UNIQUE(draft_id, player_id) would otherwise reject a naive insert here.
        const previous = { pick_number: existingForPlayer.pick_number, ...JSON.parse(pickSignature(existingForPlayer)) };
        run(`UPDATE draft_picks SET pick_number=?, team_slot=?, espn_team_id=?, keeper=? WHERE id=?`,
          p.overallPickNumber, slot, p.teamId, next.keeper, existingForPlayer.id);
        recordCorrection(draftId, p.overallPickNumber, previous, { pick_number: p.overallPickNumber, ...next }, 'renumbered', snapshotId);
        corrected.push(p.overallPickNumber);
        local.delete(existingForPlayer.pick_number);
        const movedRecord = { ...existingForPlayer, pick_number: p.overallPickNumber, ...next };
        local.set(p.overallPickNumber, movedRecord);
        byPlayer.set(playerId, movedRecord);
        continue;
      }

      if (!existingAtNumber) {
        run(`INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, espn_team_id, keeper)
             VALUES (?,?,?,?,?,?)`, draftId, p.overallPickNumber, slot, playerId, p.teamId, next.keeper);
        added.push(p.overallPickNumber);
        const inserted = { id: row('SELECT last_insert_rowid() AS id').id, draft_id: draftId, pick_number: p.overallPickNumber, ...next };
        local.set(p.overallPickNumber, inserted);
        byPlayer.set(playerId, inserted);
        continue;
      }

      if (pickSignature(existingAtNumber) !== pickSignature(next)) {
        const previous = { pick_number: existingAtNumber.pick_number, ...JSON.parse(pickSignature(existingAtNumber)) };
        run(`UPDATE draft_picks SET player_id=?, team_slot=?, espn_team_id=?, keeper=? WHERE id=?`,
          playerId, slot, p.teamId, next.keeper, existingAtNumber.id);
        recordCorrection(draftId, p.overallPickNumber, previous, { pick_number: p.overallPickNumber, ...next }, 'corrected', snapshotId);
        corrected.push(p.overallPickNumber);
        const updated = { ...existingAtNumber, ...next };
        local.set(p.overallPickNumber, updated);
        byPlayer.set(playerId, updated);
      }
      // else identical to what we already have — no-op, which is what makes an
      // identical replay produce zero mutations and zero audit rows.
    }

    // Stale local picks: pick numbers we mirrored that ESPN no longer reports as
    // filled (an undo, or a correction that moved the player elsewhere and was
    // already handled above via the byPlayer branch — this only catches picks
    // ESPN dropped outright).
    for (const [pickNum, localPick] of local) {
      if (!madeNumbers.has(pickNum) && row('SELECT 1 FROM draft_picks WHERE id=?', localPick.id)) {
        const previous = { pick_number: pickNum, ...JSON.parse(pickSignature(localPick)) };
        run('DELETE FROM draft_picks WHERE id=?', localPick.id);
        recordCorrection(draftId, pickNum, previous, null, 'removed-stale', snapshotId);
        removed.push(pickNum);
      }
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { added, corrected, removed, quarantined };
}

function recordCorrection(draftId, pickNumber, previous, corrected, reason, snapshotId) {
  const draft = row('SELECT espn_league_id, season FROM drafts WHERE id=?', draftId);
  run(`INSERT INTO draft_pick_corrections (draft_id, espn_league_id, season, espn_pick_number, previous_state, corrected_state, reason, source_snapshot)
       VALUES (?,?,?,?,?,?,?,?)`,
    draftId, draft?.espn_league_id ?? null, draft?.season ?? null, pickNumber,
    previous ? JSON.stringify(previous) : null, corrected ? JSON.stringify(corrected) : JSON.stringify({ removed: true }),
    reason, snapshotId ?? null);
}

/** Open (unresolved) quarantine entries for a draft, oldest first. */
export function openQuarantine(draftId) {
  return rows('SELECT * FROM draft_pick_quarantine WHERE draft_id=? AND resolved_at IS NULL ORDER BY first_seen_at', draftId);
}

/** Correction audit trail for a draft, most recent first — safe to expose (contains no credentials). */
export function correctionHistory(draftId, limit = 50) {
  return rows('SELECT * FROM draft_pick_corrections WHERE draft_id=? ORDER BY applied_at DESC LIMIT ?', draftId, limit);
}
