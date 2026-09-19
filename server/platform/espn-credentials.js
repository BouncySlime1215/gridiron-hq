/**
 * Whose ESPN account is this?
 *
 * Every ESPN request this app makes carries somebody's `espn_s2`/`SWID` pair,
 * and until 2026-09-19 there was only ever one pair per install to carry. This
 * module is the answer to "whose", and it is deliberately the ONLY place that
 * answer is computed, because the bug being fixed here was the same
 * global-then-guess logic written out twice in two files that drifted apart.
 *
 * The rule, in order:
 *
 *   1. A league's own stored pair, if it has one. That is the connection the
 *      league was added with, and PR #14 already scopes league access to
 *      members, so reading it is not reaching into a stranger's account.
 *   2. Otherwise a member of that league, commissioner first. A league with no
 *      pair of its own belongs to whoever is in it, and one of them has
 *      credentials that can see it.
 *   3. Otherwise nothing, and the caller says so out loud.
 *
 * What is NOT in that list is the thing being removed: "whichever league was
 * fetched most recently, install-wide". That is how one person's cookies ended
 * up making another person's requests.
 */
import crypto from 'node:crypto';
import { row, rows, run } from '../db/index.js';

/**
 * No credential could be found for a league.
 *
 * A distinct error type rather than a null return, because the failure this
 * replaces was silent: an unauthenticated ESPN fetch does not error, it
 * answers with a thin public payload that a sync will happily write down as
 * though it were the league's real data. `status` is 409 rather than 401 —
 * the CALLER is authenticated, it is the ESPN connection that is missing, and
 * a 401 here would send the client to the sign-in page for the wrong reason.
 */
export class EspnCredentialsMissing extends Error {
  constructor(message) {
    super(message);
    this.name = 'EspnCredentialsMissing';
    this.status = 409;
    this.code = 'espn_not_connected';
  }
}

const mintToken = () => crypto.randomBytes(24).toString('base64url');

/** ESPN's API wants the SWID in braces; the cookie sometimes already has them. */
export const braceSwid = v => (String(v).startsWith('{') ? String(v) : `{${v}}`);

/** One user's stored pair, or nulls. Never falls back to anyone else. */
export function credentialsForUser(userId) {
  if (!userId) return { s2: null, swid: null };
  const c = row(`SELECT espn_s2, swid FROM espn_credentials WHERE user_id = ?`, userId);
  return { s2: c?.espn_s2 ?? null, swid: c?.swid ?? null };
}

/**
 * The credentials to use when talking to ESPN about one specific league.
 *
 * Returns `{ s2, swid, source, userId }` or nulls. `source` is for diagnostics
 * and for the connect UI, never for a decision.
 */
export function credentialsForLeague(leagueRowId) {
  const none = { s2: null, swid: null, source: null, userId: null };
  if (!leagueRowId) return none;

  const lg = row(`SELECT id, espn_s2, swid FROM leagues WHERE id = ?`, leagueRowId);
  if (!lg) return none;
  if (lg.espn_s2 && lg.swid) {
    return { s2: lg.espn_s2, swid: lg.swid, source: 'league', userId: null };
  }

  // Commissioner first, then the lowest user id, so the choice is deterministic
  // and does not change under it because someone else happened to sync.
  const member = row(
    `SELECT c.user_id, c.espn_s2, c.swid
       FROM league_memberships lm
       JOIN espn_credentials c ON c.user_id = lm.user_id
      WHERE lm.league_id = ?
        AND c.espn_s2 IS NOT NULL AND c.swid IS NOT NULL
      ORDER BY CASE lm.role WHEN 'commissioner' THEN 0 ELSE 1 END, lm.user_id ASC
      LIMIT 1`, leagueRowId);

  if (member) {
    return { s2: member.espn_s2, swid: member.swid, source: 'member', userId: member.user_id };
  }
  return none;
}

/**
 * As above, but throws rather than returning nulls.
 *
 * Every ESPN call that is about a particular league goes through this. The
 * message names the league because "ESPN not connected" on an install with
 * five leagues sends the reader looking in the wrong place.
 */
export function requireCredentialsForLeague(leagueRowId) {
  const found = credentialsForLeague(leagueRowId);
  if (found.s2 && found.swid) return found;
  const lg = row(`SELECT name, league_id FROM leagues WHERE id = ?`, leagueRowId);
  const label = lg?.name ?? (lg ? `ESPN league ${lg.league_id}` : `league ${leagueRowId}`);
  throw new EspnCredentialsMissing(
    `no ESPN connection for ${label} — connect ESPN on the Settings page, then sync it again`);
}

/** The Cookie header for a pair, or undefined when there is none to send. */
export function cookieHeader({ s2, swid } = {}) {
  return s2 && swid ? `espn_s2=${s2}; SWID=${swid}` : undefined;
}

/**
 * Store a validated pair for one user.
 *
 * `validated_at` is stamped because the only paths that reach here have just
 * had ESPN confirm the pair works — an unvalidated write would make the column
 * a lie, and a column that is sometimes a lie is worse than no column.
 */
export function saveCredentials(userId, espn_s2, swid) {
  if (!userId) throw new Error('saveCredentials requires a user');
  run(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token, updated_at, validated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         espn_s2 = excluded.espn_s2, swid = excluded.swid,
         updated_at = datetime('now'), validated_at = datetime('now')`,
    userId, espn_s2, braceSwid(swid), mintToken());
}

/** Forget one user's pair. Their token survives, so their bookmarklet still works. */
export function clearCredentials(userId) {
  if (!userId) return;
  run(`UPDATE espn_credentials SET espn_s2 = NULL, swid = NULL, updated_at = datetime('now'),
         validated_at = NULL WHERE user_id = ?`, userId);
}

/**
 * The token baked into this user's bookmarklet, minted on first request.
 *
 * Per user, not per install. The old single token meant any holder could
 * overwrite the one credential slot; now a token only ever writes the
 * credentials of the account it was minted for, so the worst a leaked one can
 * do is put cookies on its own owner's row — which is also the only thing its
 * owner could do with it.
 */
export function connectTokenForUser(userId) {
  if (!userId) throw new Error('connectTokenForUser requires a user');
  const existing = row(`SELECT connect_token FROM espn_credentials WHERE user_id = ?`, userId);
  if (existing?.connect_token) return existing.connect_token;
  const token = mintToken();
  run(`INSERT INTO espn_credentials (user_id, connect_token) VALUES (?, ?)
       ON CONFLICT(user_id) DO NOTHING`, userId, token);
  return row(`SELECT connect_token FROM espn_credentials WHERE user_id = ?`, userId).connect_token;
}

/**
 * Which user a presented bookmarklet token belongs to, or null.
 *
 * Compared in constant time against every token rather than looked up by
 * equality: a SQL lookup on a secret leaks its prefix through timing, and the
 * number of accounts here is small enough that scanning costs nothing. Fixed
 * 64-byte buffers so a short or over-long value is never a length-mismatch
 * throw.
 */
export function userForConnectToken(presented) {
  if (typeof presented !== 'string' || presented.length === 0) return null;
  const pad = s => Buffer.from(String(s).slice(0, 64).padEnd(64, '.'));
  const offered = pad(presented);
  let found = null;
  for (const c of rows(`SELECT user_id, connect_token FROM espn_credentials`)) {
    // No early break: the loop runs the same number of comparisons whichever
    // token matches, which is the point of doing it this way at all.
    if (crypto.timingSafeEqual(offered, pad(c.connect_token))) found = c.user_id;
  }
  return found;
}
