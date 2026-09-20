import crypto from 'node:crypto';
import { Router } from 'express';
import { db, row, rows, run } from '../db/index.js';
import { hashSessionToken, requireAuthenticated } from '../platform/auth.js';
import { isDirectLoopback } from './local-auth.js';
import { requirePlatformAdmin, legacyRateLimit } from '../platform/legacy-access.js';
import {
  googleConfigured, createPkcePair, buildAuthorizationUrl, exchangeCode, verifyIdToken, GoogleAuthError
} from '../platform/google-oidc.js';
import { resolveGoogleAccount, accountSummary, SignInRefused, isAdmin } from '../platform/account-link.js';

const r = Router();

const FLOW_TTL_MINUTES = 10;
const HANDOFF_TTL_SECONDS = 120;
const SESSION_DAYS = 30;
const HANDOFF_COOKIE = 'gridiron_signin';
/** Where the browser lands after Google; the SPA redeems the handoff there. */
export const COMPLETE_PATH = '/sign-in/complete';

/**
 * The origin this deployment is actually reached at, which is what the
 * redirect URI has to be: Google compares it byte for byte against the one
 * registered on the OAuth client, so guessing wrong fails at Google with an
 * error the user cannot act on.
 *
 * `GRIDIRON_PUBLIC_URL` wins when set, because behind Fly's proxy the Host
 * header is right but nothing in the request proves the scheme except a
 * header the proxy sets. Falling back to those headers keeps local dev and a
 * plain reverse proxy working without configuration.
 */
export function publicOrigin(req) {
  const configured = (process.env.GRIDIRON_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const forwardedProto = (req.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim();
  const proto = forwardedProto || (req.secure ? 'https' : 'http');
  return host ? `${proto}://${host}` : '';
}

export function redirectUriFor(req) {
  return `${publicOrigin(req)}/api/auth/google/callback`;
}

/** Only same-origin paths, so `return_to` can never become an open redirect. */
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  // `//evil.example` and `/\evil.example` are both protocol-relative URLs to
  // a browser, and would leave this origin despite starting with a slash.
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value.slice(0, 512);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setHandoffCookie(req, res, value) {
  const secure = publicOrigin(req).startsWith('https://');
  const attrs = [
    `${HANDOFF_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/api/auth',
    'HttpOnly',
    // Lax, not Strict: the browser arrives here from accounts.google.com, and
    // Strict would withhold the cookie on that very first navigation.
    'SameSite=Lax',
    `Max-Age=${HANDOFF_TTL_SECONDS}`
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearHandoffCookie(req, res) {
  const secure = publicOrigin(req).startsWith('https://');
  const attrs = [`${HANDOFF_COOKIE}=`, 'Path=/api/auth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function issueSession(userId, days = SESSION_DAYS) {
  const token = crypto.randomBytes(32).toString('base64url');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now', ?))`, userId, hashSessionToken(token), `+${days} days`);
  run(`DELETE FROM auth_sessions WHERE user_id=? AND
       (revoked_at IS NOT NULL OR expires_at <= datetime('now'))`, userId);
  return token;
}

/** Expired attempts are worthless and hold one-time secrets; sweep on use. */
function sweepFlows() {
  run(`DELETE FROM auth_login_flows
       WHERE expires_at <= datetime('now','-1 hour')
          OR (handoff_redeemed_at IS NOT NULL AND handoff_redeemed_at <= datetime('now','-1 hour'))`);
}

function failureRedirect(res, code, returnTo) {
  const url = new URL(COMPLETE_PATH, 'http://placeholder');
  url.searchParams.set('error', code);
  if (returnTo) url.searchParams.set('next', returnTo);
  // Only the path and query are used; the origin above exists to satisfy URL().
  res.redirect(302, `${url.pathname}${url.search}`);
}

// ------------------------------------------------------------------ discovery

/**
 * What sign-in methods this deployment offers, answered before anyone is
 * signed in. The login page needs it to decide whether to draw a Google
 * button at all, and the client needs to know the token path still exists.
 */
r.get('/providers', (req, res) => {
  res.json({
    google: googleConfigured(),
    // Answered for THIS request rather than asserted: the loopback path is
    // unreachable through any proxy by construction (isDirectLoopback), so on
    // a hosted deployment this reports false and the client stops offering it,
    // while a browser on the Mac still sees true.
    local: isDirectLoopback(req),
    pairing: true,
    origin: publicOrigin(req),
    // Surfaced so the setup steps can be checked against reality rather than
    // against what someone believes they typed into the Google console.
    redirect_uri: redirectUriFor(req)
  });
});

// ------------------------------------------------------------------- sign-in

r.get('/google/start', legacyRateLimit({ limit: 30, windowMs: 60_000 }), async (req, res, next) => {
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server', code: 'not_configured' });
  }
  try {
    sweepFlows();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const { verifier, challenge } = createPkcePair();
    const redirectUri = redirectUriFor(req);
    const returnTo = safeReturnTo(req.query.return_to);

    run(`INSERT INTO auth_login_flows (state_hash, nonce_hash, code_verifier, redirect_uri, return_to, expires_at)
         VALUES (?,?,?,?,?,datetime('now', ?))`,
      hashSessionToken(state), hashSessionToken(nonce), verifier, redirectUri, returnTo,
      `+${FLOW_TTL_MINUTES} minutes`);

    const url = await buildAuthorizationUrl({
      state, nonce, codeChallenge: challenge, redirectUri,
      loginHint: typeof req.query.login_hint === 'string' ? req.query.login_hint.slice(0, 254) : null
    });
    // 302 rather than JSON: this endpoint is the href of a link, so the
    // browser navigates to Google without any JavaScript having to run.
    res.redirect(302, url);
  } catch (error) {
    if (error instanceof GoogleAuthError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// Called by Google, not by this app. Google's authorization server sends the
// user's browser here after they consent, at the redirect URI registered on
// the OAuth client and built by redirectUriFor() above. Nothing in client/
// references this path and nothing should: a route with only an external
// caller looks unreachable to a caller-graph sweep, so this is accepted, not
// dead. Deleting it breaks sign-in with no failing test to show for it.
r.get('/google/callback', legacyRateLimit({ limit: 30, windowMs: 60_000 }), async (req, res, next) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const flow = state
    ? row(`SELECT * FROM auth_login_flows WHERE state_hash=? AND consumed_at IS NULL
             AND expires_at > datetime('now')`, hashSessionToken(state))
    : null;

  // Consume the attempt before anything can go wrong with it. A state that
  // survives a failure is a state that can be replayed.
  if (flow) run(`UPDATE auth_login_flows SET consumed_at=datetime('now') WHERE id=?`, flow.id);
  const returnTo = flow?.return_to ?? null;

  if (typeof req.query.error === 'string') {
    // The user pressed cancel at Google, or Google refused the request.
    return failureRedirect(res, req.query.error === 'access_denied' ? 'cancelled' : 'google_error', returnTo);
  }
  if (!flow) return failureRedirect(res, 'expired', null);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) return failureRedirect(res, 'no_code', returnTo);

  try {
    const tokens = await exchangeCode({ code, codeVerifier: flow.code_verifier, redirectUri: flow.redirect_uri });
    // Only a digest of the nonce was stored — same discipline as every other
    // secret here — so the comparison happens on this side rather than by
    // handing verifyIdToken a value it could compare directly.
    const profile = await verifyIdToken(tokens.id_token, { nonce: null });
    if (!profile.nonce || hashSessionToken(profile.nonce) !== flow.nonce_hash) {
      return failureRedirect(res, 'bad_nonce', returnTo);
    }

    const { userId } = resolveGoogleAccount(profile);

    // The session token is minted here but never travels in the URL: the
    // browser gets a one-time handoff in an HttpOnly cookie and swaps it for
    // the token over XHR. A token in a query string lands in history, in the
    // referrer of the next request, and in any proxy log on the way.
    const handoff = crypto.randomBytes(32).toString('base64url');
    run(`UPDATE auth_login_flows SET handoff_hash=?, handoff_user_id=?,
           handoff_expires_at=datetime('now', ?) WHERE id=?`,
      hashSessionToken(handoff), userId, `+${HANDOFF_TTL_SECONDS} seconds`, flow.id);
    setHandoffCookie(req, res, handoff);

    const target = new URL(COMPLETE_PATH, 'http://placeholder');
    if (returnTo) target.searchParams.set('next', returnTo);
    res.redirect(302, `${target.pathname}${target.search}`);
  } catch (error) {
    if (error instanceof SignInRefused) return failureRedirect(res, error.code ?? 'refused', returnTo);
    if (error instanceof GoogleAuthError) return failureRedirect(res, error.code ?? 'google_error', returnTo);
    next(error);
  }
});

/**
 * Swap the one-time handoff cookie for the bearer token the client already
 * knows how to use. POST because it consumes something.
 */
r.post('/google/complete', legacyRateLimit({ limit: 30, windowMs: 60_000 }), (req, res) => {
  const handoff = parseCookies(req)[HANDOFF_COOKIE];
  clearHandoffCookie(req, res);
  if (!handoff) return res.status(401).json({ error: 'no sign-in to complete', code: 'no_handoff' });

  db.exec('BEGIN IMMEDIATE');
  try {
    const flow = row(`SELECT id, handoff_user_id FROM auth_login_flows
      WHERE handoff_hash=? AND handoff_redeemed_at IS NULL AND handoff_expires_at > datetime('now')`,
      hashSessionToken(handoff));
    if (!flow) {
      db.exec('ROLLBACK');
      return res.status(401).json({ error: 'this sign-in has already been used or has expired', code: 'expired' });
    }
    run(`UPDATE auth_login_flows SET handoff_redeemed_at=datetime('now'), code_verifier='' WHERE id=?`, flow.id);
    const token = issueSession(flow.handoff_user_id);
    const account = accountSummary(flow.handoff_user_id);
    db.exec('COMMIT');
    res.json({ token, expires_in_days: SESSION_DAYS, account });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

// ------------------------------------------------------------------- session

r.get('/session', requireAuthenticated, (req, res) => {
  res.json({ authenticated: true, account: accountSummary(req.auth.userId) });
});

r.post('/logout', requireAuthenticated, (req, res) => {
  run(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL`, req.auth.sessionId);
  res.json({ ok: true });
});

/** Sign out everywhere — the honest answer to "I lost my phone". */
r.post('/logout-all', requireAuthenticated, (req, res) => {
  run(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`, req.auth.userId);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- invites

/**
 * Sign-up is invite-only, so somebody has to be able to write an invite.
 * Admin here means the persisted `model:*` grant, the same thing /api/dev
 * already treats as administrator — no second notion of privilege.
 */
r.get('/invites', requireAuthenticated, requirePlatformAdmin, (_req, res) => {
  res.json(rows(`SELECT i.id, i.email, i.note, i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
      u.display_name AS accepted_by
    FROM auth_invites i LEFT JOIN users u ON u.id = i.accepted_user_id
    ORDER BY i.created_at DESC LIMIT 200`));
});

r.post('/invites', requireAuthenticated, requirePlatformAdmin, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  // Deliberately loose: the address only has to match what Google reports for
  // a real, verified account, and over-strict validation rejects valid ones.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'enter a valid email address' });
  }
  const note = req.body?.note == null ? null : String(req.body.note).slice(0, 200);
  const days = Number.isFinite(Number(req.body?.expires_in_days)) ? Number(req.body.expires_in_days) : 30;
  try {
    run(`INSERT INTO auth_invites (email, invited_by, note, expires_at)
         VALUES (?,?,?, ${days > 0 ? `datetime('now', ?)` : 'NULL'})`,
      ...(days > 0 ? [email, req.auth.userId, note, `+${Math.min(days, 365)} days`]
        : [email, req.auth.userId, note]));
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) {
      return res.status(409).json({ error: 'that address already has an open invite' });
    }
    throw error;
  }
  res.status(201).json(row('SELECT * FROM auth_invites WHERE id = last_insert_rowid()'));
});

r.delete('/invites/:id', requireAuthenticated, requirePlatformAdmin, (req, res) => {
  const invite = row('SELECT id, accepted_at FROM auth_invites WHERE id=?', Number(req.params.id));
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.accepted_at) {
    // Revoking an accepted invite would say nothing about the account it
    // created; disabling the user is the action that actually removes access.
    return res.status(409).json({ error: 'that invite has already been accepted — disable the account instead' });
  }
  run(`UPDATE auth_invites SET revoked_at=datetime('now') WHERE id=?`, invite.id);
  res.json({ ok: true });
});

/** Who has an account, for the admin screen. Never exposes tokens or keys. */
r.get('/accounts', requireAuthenticated, requirePlatformAdmin, (_req, res) => {
  res.json(rows(`SELECT u.id, u.display_name, u.email, u.disabled_at, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM league_memberships m WHERE m.user_id = u.id) AS leagues,
      (SELECT COUNT(*) FROM user_identities i WHERE i.user_id = u.id AND i.provider='google') AS google_linked
    FROM users u ORDER BY u.id`).map(u => ({ ...u, admin: isAdmin(u.id) })));
});

r.post('/accounts/:id/disabled', requireAuthenticated, requirePlatformAdmin, (req, res) => {
  const id = Number(req.params.id);
  const disabled = req.body?.disabled !== false;
  if (id === req.auth.userId) return res.status(409).json({ error: 'you cannot disable your own account' });
  if (!row('SELECT 1 FROM users WHERE id=?', id)) return res.status(404).json({ error: 'account not found' });
  run(`UPDATE users SET disabled_at=${disabled ? `datetime('now')` : 'NULL'} WHERE id=?`, id);
  // Disabling has to end the sessions that already exist, or it only stops
  // the next sign-in while the current browser keeps working for 30 days.
  if (disabled) run(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`, id);
  res.json({ ok: true, disabled });
});

export default r;
