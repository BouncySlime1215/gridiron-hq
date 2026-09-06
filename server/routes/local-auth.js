import crypto from 'node:crypto';
import { Router } from 'express';
import { db, row, rows, run } from '../db/index.js';
import { hashSessionToken, requireAuthenticated } from '../platform/auth.js';

const r = Router();
const LOCAL_SUBJECT = 'gridiron-local-owner';
const PAIRING_CODE_TTL_MINUTES = 10;
const PAIRED_SESSION_DAYS = 30;

export function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * "Loopback" has to mean the browser is really on this Mac. A tunnel
 * (cloudflared, ngrok, an ssh -R) connects to 127.0.0.1 too, so the socket
 * address alone would call every phone on the internet local. Tunnels and
 * reverse proxies all announce themselves with forwarding headers, so a
 * request that carries one is treated as remote no matter what the socket says.
 */
export function isDirectLoopback(req) {
  if (!isLoopback(req.socket?.remoteAddress)) return false;
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'forwarded']) {
    if (req.get(h)) return false;
  }
  return true;
}

function requireDirectLoopback(req, res, next) {
  if (!isDirectLoopback(req)) {
    return res.status(403).json({ error: 'available only on this computer' });
  }
  next();
}

function issueSession(userId, days) {
  const token = crypto.randomBytes(32).toString('base64url');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now', ?))`, userId, hashSessionToken(token), `+${days} days`);
  // Keep the local DB tidy while preserving the current and most recent sessions.
  run(`DELETE FROM auth_sessions WHERE user_id=? AND
       (revoked_at IS NOT NULL OR expires_at <= datetime('now'))`, userId);
  return token;
}

/**
 * Gridiron HQ is installed as a local, single-user desktop app. Requiring that
 * owner to run a provisioning script and paste a bearer token made every
 * protected page look broken on a fresh clone. This endpoint provisions the
 * local owner only for a direct loopback caller; it is never available over
 * the LAN or through a tunnel (see isDirectLoopback).
 *
 * Only a digest is persisted. The raw token is returned once to this browser,
 * exactly like the old CLI provisioner, and the client stores it in localStorage.
 */
r.post('/local-session', (req, res) => {
  if (!isDirectLoopback(req)) {
    return res.status(403).json({ error: 'local sign-in is available only on this computer', pairing: true });
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

    const token = issueSession(userId, 90);
    db.exec('COMMIT');
    res.json({ token, expires_in_days: 90, leagues: rows('SELECT COUNT(*) AS n FROM league_memberships WHERE user_id=?', userId)[0].n });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

// ---------------------------------------------------------------- phone pairing

/** Where the app is currently reachable from outside, as reported by scripts/tunnel.mjs. */
let tunnelUrl = null;

r.post('/tunnel-url', requireDirectLoopback, (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  tunnelUrl = /^https:\/\/[a-z0-9.-]+$/i.test(url) ? url : null;
  res.json({ tunnel_url: tunnelUrl });
});

r.get('/pairing-info', requireDirectLoopback, requireAuthenticated, (req, res) => {
  const active = row(`SELECT COUNT(*) AS n FROM auth_pairing_codes
    WHERE user_id=? AND used_at IS NULL AND expires_at > datetime('now')`, req.auth.userId).n;
  const paired = row(`SELECT COUNT(*) AS n FROM auth_sessions
    WHERE user_id=? AND revoked_at IS NULL AND expires_at > datetime('now')`, req.auth.userId).n;
  res.json({ tunnel_url: tunnelUrl, active_codes: active, sessions: paired });
});

/**
 * Mint a one-time pairing code. Only a browser on this Mac that is already
 * signed in can do this, so possession of the code is proof the phone's owner
 * was sitting at the computer a moment ago.
 */
r.post('/pairing-code', requireDirectLoopback, requireAuthenticated, (req, res) => {
  // 8 digits from a CSPRNG, shown as 1234-5678. ~10^8 space, 10 min window,
  // and the redeem endpoint is rate limited — not brute-forceable through a tunnel.
  const code = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  run(`DELETE FROM auth_pairing_codes WHERE user_id=? AND (used_at IS NOT NULL OR expires_at <= datetime('now'))`, req.auth.userId);
  run(`INSERT INTO auth_pairing_codes (user_id, code_hash, expires_at)
       VALUES (?,?,datetime('now', ?))`, req.auth.userId, hashSessionToken(code), `+${PAIRING_CODE_TTL_MINUTES} minutes`);
  res.json({
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    expires_in_minutes: PAIRING_CODE_TTL_MINUTES,
    tunnel_url: tunnelUrl
  });
});

// Redeem attempts per source, in memory: 10 per 15 minutes is plenty for a
// human typing a code twice and nothing for a scanner.
const redeemAttempts = new Map();
const REDEEM_WINDOW_MS = 15 * 60 * 1000;
const REDEEM_MAX = 10;
export function _resetRedeemLimiter() { redeemAttempts.clear(); }

function redeemSource(req) {
  return req.get('cf-connecting-ip') || (req.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function overRedeemLimit(source) {
  const now = Date.now();
  const hits = (redeemAttempts.get(source) ?? []).filter(t => now - t < REDEEM_WINDOW_MS);
  hits.push(now);
  redeemAttempts.set(source, hits);
  return hits.length > REDEEM_MAX;
}

/** Any caller — this is the one endpoint a phone hits through the tunnel. */
r.post('/pair', (req, res) => {
  if (overRedeemLimit(redeemSource(req))) {
    return res.status(429).json({ error: 'too many attempts — wait 15 minutes' });
  }
  const code = String(req.body?.code ?? '').replace(/\D/g, '');
  if (code.length !== 8) return res.status(400).json({ error: 'enter the 8-digit code from the Mac' });

  db.exec('BEGIN IMMEDIATE');
  try {
    const pairing = row(`SELECT id, user_id FROM auth_pairing_codes
      WHERE code_hash=? AND used_at IS NULL AND expires_at > datetime('now')`, hashSessionToken(code));
    if (!pairing) {
      db.exec('ROLLBACK');
      return res.status(401).json({ error: 'code is wrong or expired — make a new one on the Mac' });
    }
    run(`UPDATE auth_pairing_codes SET used_at=datetime('now') WHERE id=?`, pairing.id);
    const token = issueSession(pairing.user_id, PAIRED_SESSION_DAYS);
    db.exec('COMMIT');
    res.json({ token, expires_in_days: PAIRED_SESSION_DAYS });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

export default r;
