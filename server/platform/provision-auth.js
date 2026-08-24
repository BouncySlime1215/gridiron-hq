#!/usr/bin/env node
/**
 * One-time administrator provisioning for self-hosted installs.
 * Example:
 *   GRIDIRON_DB_PATH=/path/to/data.sqlite node server/platform/provision-auth.js \
 *     --subject owner@example.com --league-id 1 --role commissioner --draft-team 7:1
 *
 * The raw bearer token is printed once; only its SHA-256 digest is persisted.
 */
import crypto from 'node:crypto';
import { runMigrations } from '../db/migrate.js';
import { row, run } from '../db/index.js';
import { hashSessionToken } from './auth.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const subject = args.get('--subject');
const leagueId = Number(args.get('--league-id'));
const role = args.get('--role') ?? 'member';
const draftTeam = args.get('--draft-team') ?? null;
const permissions = String(args.get('--model-permissions') ?? '').split(',').map(x => x.trim()).filter(Boolean);

if (!subject || !Number.isInteger(leagueId) || !['member', 'commissioner'].includes(role)) {
  console.error('usage: --subject <stable-id> --league-id <id> [--role member|commissioner] [--draft-team draftId:slot] [--model-permissions model:train,model:promote]');
  process.exitCode = 2;
} else {
  await runMigrations();
  if (!row('SELECT id FROM leagues WHERE id = ?', leagueId)) throw new Error('league not found');
  run('INSERT INTO users (subject) VALUES (?) ON CONFLICT(subject) DO NOTHING', subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  const validPermissions = new Set(['model:train', 'model:promote', 'model:execute', 'model:cancel', 'model:*']);
  if (permissions.some(x => !validPermissions.has(x))) throw new Error('invalid --model-permissions value');
  for (const permission of permissions) run('INSERT OR IGNORE INTO model_permissions (user_id, permission) VALUES (?,?)', userId, permission);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)
       ON CONFLICT(league_id,user_id) DO UPDATE SET role=excluded.role`, leagueId, userId, role);

  if (draftTeam) {
    const [draftText, slotText] = draftTeam.split(':');
    const draftId = Number(draftText), teamSlot = Number(slotText);
    if (!Number.isInteger(draftId) || !Number.isInteger(teamSlot)) throw new Error('--draft-team must be draftId:slot');
    const draft = row('SELECT id, league_row_id FROM drafts WHERE id = ?', draftId);
    if (!draft) throw new Error('draft not found');
    if (draft.league_row_id != null && Number(draft.league_row_id) !== leagueId) throw new Error('draft belongs to another league');
    if (draft.league_row_id == null) run('UPDATE drafts SET league_row_id = ? WHERE id = ?', leagueId, draftId);
    run(`INSERT INTO draft_team_ownership (draft_id, team_slot, user_id) VALUES (?,?,?)
         ON CONFLICT(draft_id,team_slot) DO UPDATE SET user_id=excluded.user_id`, draftId, teamSlot, userId);
    run('DELETE FROM legacy_draft_quarantine WHERE draft_id = ?', draftId);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now', '+30 days'))`, userId, hashSessionToken(token));
  console.log(JSON.stringify({ user_id: userId, league_id: leagueId, role, model_permissions: permissions, bearer_token: token }));
}
