import crypto from 'node:crypto';
import { Router } from 'express';
import { db, row, rows, run } from '../db/index.js';
import { hashSessionToken } from '../platform/auth.js';

const r = Router();
const LOCAL_SUBJECT = 'gridiron-local-owner';

export function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Gridiron HQ is installed as a local, single-user desktop app. Requiring that
 * owner to run a provisioning script and paste a bearer token made every
 * protected page look broken on a fresh clone. This endpoint provisions the
 * local owner only for a loopback caller; it is never available over the LAN.
 *
 * Only a digest is persisted. The raw token is returned once to this browser,
 * exactly like the old CLI provisioner, and the client stores it in localStorage.
 */
r.post('/local-session', (req, res) => {
  if (!isLoopback(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: 'local sign-in is available only on this computer' });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    run(`INSERT INTO users (subject, display_name) VALUES (?, 'Local owner')
         ON CONFLICT(subject) DO UPDATE SET display_name=excluded.display_name`, LOCAL_SUBJECT);
    const userId = row('SELECT id FROM users WHERE subject = ?', LOCAL_SUBJECT).id;

    for (const lg of rows('SELECT id FROM leagues')) {
      run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')
           ON CONFLICT(league_id,user_id) DO UPDATE SET role='commissioner'`, lg.id, userId);
    }
    run(`INSERT OR IGNORE INTO model_permissions (user_id, permission) VALUES (?, 'model:*')`, userId);

    // Bind already-confirmed local drafts to the owner when the slot is known.
    // Unconfirmed slots remain unowned so the UI must still ask instead of guessing.
    for (const draft of rows(`SELECT id, my_slot FROM drafts
      WHERE league_row_id IS NOT NULL AND my_slot_confirmed=1 AND my_slot IS NOT NULL`)) {
      run(`INSERT OR IGNORE INTO draft_team_ownership (draft_id, team_slot, user_id)
           VALUES (?,?,?)`, draft.id, draft.my_slot, userId);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES (?,?,datetime('now', '+90 days'))`, userId, hashSessionToken(token));
    // Keep the local DB tidy while preserving the current and most recent sessions.
    run(`DELETE FROM auth_sessions WHERE user_id=? AND
         (revoked_at IS NOT NULL OR expires_at <= datetime('now'))`, userId);
    db.exec('COMMIT');
    res.json({ token, expires_in_days: 90, leagues: rows('SELECT COUNT(*) AS n FROM league_memberships WHERE user_id=?', userId)[0].n });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

export default r;
