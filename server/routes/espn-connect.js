/**
 * One-click ESPN connection.
 *
 * Private ESPN leagues need two cookies, `espn_s2` and `SWID`, and the usual way to get
 * them is a nine-step DevTools walkthrough that most people abandon. This route serves a
 * bookmarklet that reads them on ESPN's own page and posts them straight back here, plus
 * a paste box that accepts whatever the user managed to copy for the browsers where
 * bookmarklets are awkward (Safari, mobile, locked-down work profiles).
 *
 * The cookies never leave the machine: the bookmarklet runs in the user's browser and
 * posts to their own local install. Nothing is sent anywhere but ESPN's API.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { legacyAuthenticated } from '../platform/legacy-access.js';
import { resolveAuthenticatedUser } from '../platform/auth.js';

/*
 * Every route here except the bookmarklet's own POST /cookies (and its preflight)
 * needs a session. This router is mounted without an auth wrapper (server/index.js)
 * because the bookmarklet runs on espn.com and cannot carry the app's token, and the
 * app is reachable through the public tunnel: anyone holding the URL could list the
 * leagues, wipe the cookies (DELETE /cookies), rewrite which roster is Nick's
 * (POST /add upserts my_team_id, which every lineup, waiver and trade surface reads)
 * or call ESPN with his cookies (GET /discover). The client's api() already sends the
 * session token on all of these.
 *
 * POST /cookies itself is gated a different way (see cookieWriteAuthorized below):
 * it still can't require a session outright, because the whole reason it exists is
 * that the bookmarklet runs ON espn.com and never had a session to send. Originally
 * this route also validated with ESPN before writing and called that enough — true
 * for a Mac behind a private, ephemeral phone tunnel, but not for a stable public
 * hostname (a Fly.io deploy): anyone who finds the URL has their own real, valid ESPN
 * cookies for free, so "validates with ESPN" filters nothing, and an unauthenticated
 * write here overwrites the single global app_settings espn_s2/swid pair that
 * getCookies() below treats as the account of record — a costless way for a stranger
 * to boot Nick off his own connection. Now it also accepts a per-install token that
 * only a signed-in caller can ever obtain (baked into the bookmarklet at /bookmarklet,
 * itself session-gated), so a caller with neither a session nor that token is refused
 * before ESPN is ever asked.
 */
const signedIn = legacyAuthenticated;

/**
 * A random per-install secret, generated on first use and persisted like the cookies
 * themselves. Its only job is proving "this POST came from a bookmarklet this install's
 * owner actually generated while signed in" — not a credential ESPN accepts, so leaking
 * it only lets someone submit cookies (still validated) for our own record, not read
 * anything.
 */
function connectToken() {
  const existing = row(`SELECT value FROM app_settings WHERE key = 'espn_connect_token'`)?.value;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_connect_token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, token);
  return token;
}

/** A signed-in caller (the paste box, which sends the session bearer token), or the bookmarklet carrying the token it was minted with. */
function cookieWriteAuthorized(req) {
  if (resolveAuthenticatedUser(req)) return true;
  const presented = typeof req.query?.t === 'string' ? req.query.t : '';
  const expected = connectToken();
  // Fixed-width buffers so timingSafeEqual never throws on a length mismatch — an
  // over-long or empty presented value is simply padded/truncated to the same slot,
  // never a crash, and still constant-time against the actual secret bytes.
  const pad = s => Buffer.from(s.slice(0, 64).padEnd(64, '.'));
  return presented.length > 0 && crypto.timingSafeEqual(pad(presented), pad(expected));
}

const r = Router();

/**
 * Where this install actually answers, as seen by the browser.
 *
 * Hardcoding localhost:5177 broke every clone that runs on another port (PORT/API_PORT
 * are configurable) — the bookmarklet would post into the void with no visible reason.
 * Deriving it from the request the Settings page just made is always right.
 */
function originFor(req) {
  const host = req.headers.host || `localhost:${process.env.API_PORT || 5177}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`;
}

/**
 * Cookies, wherever they actually live.
 *
 * There are two ways cookies get into this app: through this bookmarklet (written to
 * `app_settings`), or through the original manual paste-the-cookie form on the Settings
 * page (written directly onto a `leagues` row). A user who connected the old way and
 * never touches the bookmarklet would otherwise see "not connected" forever here, even
 * though everything already works — which is exactly the confusing state this file was
 * found in. Checking both makes "connected" mean what it says.
 */
function getCookies() {
  const get = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
  let s2 = get('espn_s2'), swid = get('swid');
  if (s2 && swid) return { s2, swid, source: 'bookmarklet' };

  // Deliberately NOT backfilled into app_settings. Two different leagues can
  // legitimately carry two different accounts' cookies (the manual paste-per-league
  // path, leagues.js's own UPDATE), so writing this one league's credential into the
  // single shared app_settings slot would pin it as "the account of record" for
  // every future caller - permanently, with no connect action taken, just because
  // this happened to be the most recently fetched league at the time someone else's
  // /status or /discover call ran. Read-through only: re-derived on every call, and
  // never a standing global identity handed to a caller who never chose it.
  const lg = row(`SELECT espn_s2, swid FROM leagues
                  WHERE platform = 'espn' AND espn_s2 IS NOT NULL AND swid IS NOT NULL
                  ORDER BY fetched_at DESC LIMIT 1`);
  if (lg?.espn_s2 && lg?.swid) return { s2: lg.espn_s2, swid: lg.swid, source: 'manual form' };
  return { s2: null, swid: null, source: null };
}

/* ---------------------------------------------------------------- cross-origin */

/**
 * The bookmarklet runs on espn.com and posts here, which is cross-origin — so without
 * these headers the browser rejects the request before this server ever sees a body,
 * and the user just gets "could not reach Gridiron HQ" with nothing in any log. That
 * was the actual reason one-click connect never worked.
 *
 * Scoped to ESPN origins only: this endpoint writes credentials, so it should not be
 * callable by any page that happens to know the port.
 */
const ESPN_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*espn\.com$/i;

function captureCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ESPN_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    // Chrome's Private Network Access check: a public site (espn.com) reaching a
    // private address (this machine) is refused unless the target opts in.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

/* --------------------------------------------------------- the bookmarklet */

/**
 * Source of the bookmarklet. Kept readable here and minified on the way out, so the
 * thing the user drags to their bookmarks bar is small but this stays maintainable.
 *
 * espn_s2 is not HttpOnly, so document.cookie can see it. When ESPN changes that, the
 * script says so plainly instead of silently posting nothing.
 */
const BOOKMARKLET = (origin, token) => `
(function(){
  function get(n){
    var m = document.cookie.match('(^|;)\\\\s*' + n + '\\\\s*=\\\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }
  var s2 = get('espn_s2'), swid = get('SWID');
  if (!s2 || !swid) {
    alert('Could not read the ESPN cookies.\\n\\n' +
          'Make sure you are on espn.com and signed in to your fantasy account, then try again.\\n\\n' +
          'If it still fails, open Settings in Gridiron HQ and use the paste box instead.');
    return;
  }
  fetch('${origin}/api/espn-connect/cookies?t=${encodeURIComponent(token)}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: s2, swid: swid })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    // Send the tab back to our own app rather than popping a raw JS alert — a page the
    // user already recognises, showing a real confirmation, beats a dialog box that
    // looks like a browser warning.
    if (d.ok) location.href = '${origin}/settings?espn_connected=1&found=' + (d.leagues_found || 0);
    else alert('Gridiron HQ said: ' + (d.error || 'unknown error'));
  })
  .catch(function(){
    alert('Could not reach Gridiron HQ at ${origin}.\\n\\n' +
          'Make sure the app is running, then try again. If your browser blocks this, ' +
          'open Settings in Gridiron HQ and use the paste box instead.');
  });
})();`;

/**
 * Strip whole-line comments, then collapse whitespace.
 *
 * Deliberately only matches a `//` that starts its own line. The previous version
 * matched `//` anywhere, so it ate the one inside `http://localhost:5177/...` and
 * emitted `fetch('http:` — a syntax error. The bookmarklet could never have run.
 */
const minify = s => s.replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s+/g, ' ').trim();

/** The bookmarklet as a javascript: URL, plus a copy/paste snippet for the fallback. */
r.get('/bookmarklet', ...signedIn, (req, res) => {
  const origin = originFor(req);
  const token = connectToken();
  res.json({
    href: `javascript:${encodeURIComponent(minify(BOOKMARKLET(origin, token)))}`,
    console_snippet: minify(BOOKMARKLET(origin, token)),
    // What the paste box wants: dump the cookies to the clipboard, no posting involved.
    // Works in every browser's console, including ones that refuse bookmarklets.
    copy_snippet: 'copy(document.cookie)',
    origin
  });
});

/* ------------------------------------------------------------ the receiver */

/**
 * Pull espn_s2 / SWID out of whatever the user pasted.
 *
 * Accepts a raw `document.cookie` dump, a `Cookie:` header, a curl command, the two
 * values on separate lines, or JSON — because telling a non-technical user "paste
 * exactly the right substring" is how you lose them. Exported for tests.
 */
export function extractEspnCookies(text) {
  const s = String(text ?? '');
  const pick = name => {
    // key=value, tolerating quotes, whitespace and surrounding punctuation.
    const m = s.match(new RegExp(`${name}\\s*[=:]\\s*["']?([^;,"'\\s]+)`, 'i'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const s2 = pick('espn_s2');
  let swid = pick('SWID');
  // A bare SWID pasted on its own line has no key at all — accept a lone GUID.
  if (!swid) {
    const guid = s.match(/\{?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}?/i);
    if (guid) swid = guid[0];
  }
  return { espn_s2: s2, swid };
}

/** ESPN's API wants the SWID in braces; the cookie sometimes already has them. */
const braceSwid = v => (v.startsWith('{') ? v : `{${v}}`);

/**
 * Store cookies from the bookmarklet or the paste box.
 *
 * Gated by cookieWriteAuthorized (a session, or the per-install token only a signed-in
 * caller could ever have gotten from /bookmarklet) before anything else runs — see the
 * comment above signedIn for why "validates against ESPN" alone stopped being enough
 * once this could sit at a stable public URL. Still validates against ESPN *before*
 * writing on top of that: garbage never gets persisted and silently breaks every later
 * sync, and a failed attempt can no longer destroy credentials that were working.
 */
r.options('/cookies', captureCors);
r.post('/cookies', captureCors, async (req, res, next) => {
  try {
    if (!cookieWriteAuthorized(req)) {
      return res.status(401).json({ error: 'authentication required' });
    }
    let espn_s2 = (req.body?.espn_s2 ?? '').trim();
    let swidRaw = (req.body?.swid ?? '').trim();

    // The paste box sends one blob instead of two fields.
    if (req.body?.raw) {
      const parsed = extractEspnCookies(req.body.raw);
      espn_s2 = espn_s2 || (parsed.espn_s2 ?? '');
      swidRaw = swidRaw || (parsed.swid ?? '');
    }

    if (!espn_s2 || !swidRaw) {
      return res.status(400).json({
        error: "Couldn't find both cookies in that. Make sure what you paste contains espn_s2 and SWID."
      });
    }
    const swid = braceSwid(swidRaw);

    const check = await validateCookies(espn_s2, swid);
    if (!check.ok) {
      return res.status(400).json({
        error: check.reason,
        // Nothing was written — say so explicitly, so a user who was already connected
        // knows a failed retry did not just log them out.
        unchanged: true
      });
    }

    run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, espn_s2);
    run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, swid);
    // Refresh saved leagues that belong to THIS ESPN account (or were never bound to
    // one), not every ESPN league on the install — someone with leagues under two
    // accounts would otherwise have the second connection silently break the first.
    run(`UPDATE leagues SET espn_s2 = ?, swid = ?
         WHERE platform = 'espn' AND (swid IS NULL OR swid = ?)`, espn_s2, swid, swid);

    res.json({ ok: true, leagues_found: check.leagues.length, leagues: check.leagues });
  } catch (e) { next(e); }
});

/**
 * Whether cookies are held, and for which leagues. No part of either cookie is
 * returned: nothing in the client reads a preview, and a prefix of espn_s2 is still a
 * piece of a credential.
 */
r.get('/status', ...signedIn, (req, res) => {
  const { s2, swid, source } = getCookies();
  res.json({
    connected: !!(s2 && swid),
    source,
    leagues: rows(`SELECT id, league_id, season, name, team_count FROM leagues WHERE platform='espn'`)
  });
});

r.delete('/cookies', ...signedIn, (req, res) => {
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid')`);
  run(`UPDATE leagues SET espn_s2 = NULL, swid = NULL WHERE platform = 'espn'`);
  res.json({ ok: true });
});

/**
 * Every league on the account for the current season.
 *
 * ESPN's fan API returns the user's fantasy preferences, each carrying a league id —
 * which is how we turn "signed in" into "here are your leagues" without asking the user
 * to find an id in a URL. Also doubles as the credential check: it is the cheapest
 * endpoint that fails loudly when the cookies are wrong.
 */
async function fetchFanLeagues(espn_s2, swid) {
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const headers = { Cookie: `espn_s2=${espn_s2}; SWID=${swid}`, Accept: 'application/json' };

  const res = await fetch(
    `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}?featureFlags=challengeEntries&showAirings=buy,live,replay&source=ESPN.com+-+FAM&lang=en&section=espn`,
    { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`ESPN returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

  const out = [];
  for (const pref of data.preferences ?? []) {
    const entry = pref.metaData?.entry;
    const leagueId = entry?.groups?.[0]?.groupId ?? entry?.leagueId;
    if (!leagueId) continue;
    // The fan API mixes seasons and sports; keep this season's football entries.
    if (entry.gameId && entry.gameId !== 1) continue;
    if (entry.seasonId && Number(entry.seasonId) !== season) continue;
    out.push({
      league_id: String(leagueId),
      name: entry.groups?.[0]?.groupName ?? entry.entryMetadata?.teamName ?? `League ${leagueId}`,
      team_id: entry.entryId != null ? String(entry.entryId) : null,
      team_name: entry.entryMetadata?.teamName ?? entry.name ?? null,
      season
    });
  }
  // De-duplicate: one account can hold several teams in the same league over time.
  return [...new Map(out.map(l => [l.league_id, l])).values()];
}

/**
 * Do these cookies actually work? Returns leagues on success so the caller doesn't
 * need a second round-trip. Never throws — the caller turns `reason` into UI copy.
 */
async function validateCookies(espn_s2, swid) {
  try {
    return { ok: true, leagues: await fetchFanLeagues(espn_s2, swid) };
  } catch (e) {
    // 404 is what the fan API actually returns for a SWID it doesn't recognise — as
    // common a failure as 401/403 here, and "ESPN returned 404" tells a user nothing.
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      return {
        ok: false,
        reason: "ESPN didn't recognise those cookies. Make sure you were signed in to ESPN in that browser when you copied them, and that you copied both espn_s2 and SWID.",
        leagues: []
      };
    }
    if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
      return { ok: false, reason: "Couldn't reach ESPN just now (timed out). Your existing connection was left alone — try again in a moment.", leagues: [] };
    }
    return { ok: false, reason: `Couldn't verify those cookies with ESPN: ${e.message}`, leagues: [] };
  }
}

/** Re-run discovery on demand, using stored cookies from whichever source has them. */
r.get('/discover', ...signedIn, async (req, res, next) => {
  try {
    const { s2, swid } = getCookies();
    if (!s2 || !swid) return res.status(400).json({ error: 'no ESPN cookies stored yet — connect below first' });
    const checked = await validateCookies(s2, swid);
    if (!checked.ok) return res.status(400).json({ error: checked.reason });
    res.json({ leagues: checked.leagues });
  } catch (e) { next(e); }
});

/** Add a discovered league straight into the leagues table. */
r.post('/add', ...signedIn, async (req, res, next) => {
  try {
    const { league_id, season, my_team_id, name } = req.body ?? {};
    if (!league_id) return res.status(400).json({ error: 'league_id required' });
    const { s2, swid } = getCookies();
    const yr = Number(season) || Number(process.env.NFL_SEASON) || new Date().getFullYear();

    run(`INSERT INTO leagues (platform, league_id, season, name, my_team_id, espn_s2, swid)
         VALUES ('espn', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, league_id, season) DO UPDATE SET
           espn_s2 = excluded.espn_s2, swid = excluded.swid,
           my_team_id = COALESCE(excluded.my_team_id, leagues.my_team_id),
           name = COALESCE(excluded.name, leagues.name)`,
      String(league_id), yr, name ?? null, my_team_id != null ? String(my_team_id) : null, s2, swid);

    const lg = row(`SELECT id FROM leagues WHERE platform='espn' AND league_id=? AND season=?`,
      String(league_id), yr);
    // Every :id route on /api/leagues (sync included) now requires a real
    // league_memberships row — leagues.js's own POST / creates one, but this
    // route (the actual first-run path: the ESPN-connect modal calls this, not
    // that one) never did, so a freshly-connected league had no member and its
    // very first sync 403'd. The route now requires a session, so req.auth is the
    // caller, never anything in the body.
    const auth = req.auth;
    if (lg?.id && auth?.userId) {
      run(`INSERT INTO league_memberships (league_id,user_id,role) VALUES (?,?,'commissioner')
           ON CONFLICT(league_id,user_id) DO UPDATE SET role='commissioner'`, lg.id, auth.userId);
    }
    res.json({ ok: true, id: lg?.id, note: 'Now hit Sync on the My Leagues page to pull rosters.' });
  } catch (e) { next(e); }
});

export default r;
