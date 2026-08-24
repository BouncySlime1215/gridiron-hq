import crypto from 'node:crypto';
import { row } from '../db/index.js';

export class AuthenticationError extends Error {
  constructor(message = 'authentication required') { super(message); this.status = 401; }
}
export class AuthorizationError extends Error {
  constructor(message = 'forbidden') { super(message); this.status = 403; }
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Resolve an opaque bearer token to a persisted, unexpired, non-revoked session. */
export function resolveAuthenticatedUser(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(req.get('authorization') ?? '');
  if (!match) return null;
  const authenticated = row(`SELECT u.id, u.subject, u.display_name, s.id AS session_id
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
      AND s.expires_at > datetime('now') AND u.disabled_at IS NULL`, hashSessionToken(match[1]));
  return authenticated ? {
    userId: authenticated.id, subject: authenticated.subject,
    displayName: authenticated.display_name, sessionId: authenticated.session_id
  } : null;
}

export function requireAuthenticated(req, res, next) {
  const auth = resolveAuthenticatedUser(req);
  if (!auth) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'authentication required' });
  }
  req.auth = auth;
  next();
}

export function leagueAccess(userId, leagueId) {
  if (!Number.isInteger(Number(userId)) || !Number.isInteger(Number(leagueId))) return null;
  return row(`SELECT league_id, user_id, role FROM league_memberships
              WHERE league_id = ? AND user_id = ?`, Number(leagueId), Number(userId)) ?? null;
}

export function assertLeagueMember(userId, leagueId) {
  const membership = leagueAccess(userId, leagueId);
  if (!membership) throw new AuthorizationError('league membership required');
  return membership;
}

export function assertCommissioner(userId, leagueId) {
  const membership = assertLeagueMember(userId, leagueId);
  if (membership.role !== 'commissioner') throw new AuthorizationError('commissioner permission required');
  return membership;
}

export function ownsDraftTeam(userId, draftId, teamSlot) {
  return !!row(`SELECT 1 FROM draft_team_ownership
                WHERE draft_id = ? AND team_slot = ? AND user_id = ?`,
    Number(draftId), Number(teamSlot), Number(userId));
}

export function actorForDraft(userId, draftId) {
  const draft = row('SELECT id, league_row_id FROM drafts WHERE id = ?', Number(draftId));
  if (!draft) return null;
  const membership = draft.league_row_id == null ? null : leagueAccess(userId, draft.league_row_id);
  return membership ? { userId: Number(userId), leagueId: draft.league_row_id, role: membership.role } : null;
}
