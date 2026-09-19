import crypto from 'node:crypto';

/**
 * Google sign-in, implemented against the OpenID Connect spec directly
 * rather than through a library.
 *
 * This app has three runtime dependencies (express, the Anthropic SDK, ai).
 * Adding passport or openid-client to establish `req.auth.userId` a second
 * way would be the largest dependency in the tree for about 150 lines of
 * work that node:crypto already does. Everything below is the authorization
 * code flow with PKCE plus RS256 ID-token verification, which is the whole
 * of what Google requires.
 *
 * Nothing here touches the database or express. It is a pure client for
 * Google's endpoints so the route layer stays readable and this half can be
 * tested with a stubbed fetch.
 */

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

// Google publishes cache headers on both documents; these are the floors we
// respect if a response arrives without one. Keys rotate roughly daily.
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

let discoveryCache = null;
let jwksCache = null;

/** Test seam — the process-wide caches would otherwise leak between cases. */
export function _resetOidcCaches() { discoveryCache = null; jwksCache = null; }

export class GoogleAuthError extends Error {
  constructor(message, { status = 502, code = 'google_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function googleClientId() {
  return process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GRIDIRON_GOOGLE_CLIENT_ID || null;
}

export function googleClientSecret() {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GRIDIRON_GOOGLE_CLIENT_SECRET || null;
}

/**
 * Whether Google sign-in can be offered at all. The login page asks this
 * before rendering a button, so an unconfigured deployment shows the token
 * path alone instead of a button that dead-ends at Google with an error.
 */
export function googleConfigured() {
  return Boolean(googleClientId() && googleClientSecret());
}

async function fetchJson(url, init, what) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new GoogleAuthError(`could not reach Google to ${what}: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok || body == null) {
    // Google returns {error, error_description} on failure. Surface the code
    // but never the raw body, which on the token endpoint echoes the request.
    const detail = body?.error_description || body?.error || `HTTP ${response.status}`;
    throw new GoogleAuthError(`Google refused to ${what}: ${detail}`);
  }
  return { body, headers: response.headers };
}

function maxAgeMs(headers, fallback) {
  const match = /max-age=(\d+)/i.exec(headers?.get?.('cache-control') ?? '');
  return match ? Math.min(Number(match[1]) * 1000, 24 * 60 * 60 * 1000) : fallback;
}

export async function discovery() {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.document;
  const { body, headers } = await fetchJson(DISCOVERY_URL, undefined, 'read its OpenID configuration');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof body[field] !== 'string') {
      throw new GoogleAuthError(`Google's OpenID configuration is missing ${field}`);
    }
  }
  discoveryCache = { document: body, expiresAt: Date.now() + maxAgeMs(headers, DISCOVERY_TTL_MS) };
  return body;
}

async function signingKeys({ force = false } = {}) {
  if (!force && jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const { jwks_uri } = await discovery();
  const { body, headers } = await fetchJson(jwks_uri, undefined, 'read its signing keys');
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) throw new GoogleAuthError('Google returned no signing keys');
  jwksCache = { keys, expiresAt: Date.now() + maxAgeMs(headers, JWKS_TTL_MS) };
  return keys;
}

/** RFC 7636 PKCE: a high-entropy verifier and its S256 challenge. */
export function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function buildAuthorizationUrl({ state, nonce, codeChallenge, redirectUri, loginHint = null }) {
  const { authorization_endpoint } = await discovery();
  const url = new URL(authorization_endpoint);
  url.searchParams.set('client_id', googleClientId());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  // No Drive, no contacts. An address and a display name is the entire need.
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Nothing here acts on the user's behalf at Google, so no refresh token is
  // requested: there is nothing to refresh it for, and not holding one is one
  // less long-lived secret on the volume.
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

export async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const { token_endpoint } = await discovery();
  const form = new URLSearchParams({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  });
  const { body } = await fetchJson(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString()
  }, 'exchange the sign-in code');
  if (typeof body.id_token !== 'string') {
    throw new GoogleAuthError('Google returned no ID token for this sign-in');
  }
  return body;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verify an ID token end to end: RS256 signature against Google's published
 * keys, then every claim that makes the token mean anything.
 *
 * OpenID Connect Core 3.1.3.7 permits skipping signature validation when the
 * token came straight back from the token endpoint over TLS, which it did.
 * It is checked anyway — it costs one cached HTTP request and it is the
 * difference between trusting the transport and trusting the issuer.
 */
export async function verifyIdToken(idToken, { nonce, clockToleranceSeconds = 60 } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new GoogleAuthError('malformed ID token', { status: 401, code: 'bad_token' });

  let header, claims;
  try {
    header = decodeSegment(parts[0]);
    claims = decodeSegment(parts[1]);
  } catch {
    throw new GoogleAuthError('unreadable ID token', { status: 401, code: 'bad_token' });
  }
  if (header.alg !== 'RS256') {
    // Refusing anything else by name is what closes the alg=none and
    // alg-confusion families, rather than trusting whatever the header asks for.
    throw new GoogleAuthError(`unexpected ID token algorithm ${header.alg}`, { status: 401, code: 'bad_token' });
  }

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = Buffer.from(parts[2], 'base64url');
  // A key id that is not in the cache is the normal shape of a rotation, so
  // one forced refresh is tried before calling the token unverifiable.
  let verified = false;
  for (const force of [false, true]) {
    const keys = await signingKeys({ force });
    const candidates = header.kid ? keys.filter(k => k.kid === header.kid) : keys;
    if (!candidates.length && !force) continue;
    for (const jwk of candidates) {
      let key;
      try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { continue; }
      if (crypto.verify('RSA-SHA256', signed, key, signature)) { verified = true; break; }
    }
    if (verified) break;
  }
  if (!verified) {
    throw new GoogleAuthError('ID token signature did not verify', { status: 401, code: 'bad_token' });
  }

  const now = Math.floor(Date.now() / 1000);
  const fail = message => { throw new GoogleAuthError(message, { status: 401, code: 'bad_token' }); };

  if (!GOOGLE_ISSUERS.includes(claims.iss)) fail(`ID token issuer ${claims.iss} is not Google`);
  // aud pins the token to THIS client. Without it, an ID token minted for any
  // other Google app would sign its holder in here.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(googleClientId())) fail('ID token was issued for a different application');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== googleClientId()) {
    fail('ID token authorized party does not match this application');
  }
  if (!Number.isFinite(claims.exp) || claims.exp + clockToleranceSeconds < now) fail('ID token has expired');
  if (Number.isFinite(claims.iat) && claims.iat - clockToleranceSeconds > now) fail('ID token is not valid yet');
  // The nonce ties the token to the flow this browser started, which is what
  // stops a token replayed from somewhere else completing a sign-in here.
  if (nonce != null && claims.nonce !== nonce) fail('ID token does not match this sign-in attempt');
  if (!claims.sub) fail('ID token carries no subject');
  // Accounts are matched on email (invites, the admin bootstrap), so an
  // unverified address would let anyone claim an invite by naming it.
  if (!claims.email) fail('Google did not return an email address for this account');
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new GoogleAuthError('this Google account has an unverified email address',
      { status: 403, code: 'email_unverified' });
  }

  return {
    subject: String(claims.sub),
    email: String(claims.email).trim().toLowerCase(),
    emailVerified: true,
    displayName: claims.name ? String(claims.name) : null,
    avatarUrl: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null,
    hostedDomain: claims.hd ? String(claims.hd) : null
  };
}
