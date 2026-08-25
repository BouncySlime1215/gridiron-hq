import { Router } from 'express';
import { row, run } from '../db/index.js';
import { requireAuthenticated, assertLeagueMember } from '../platform/auth.js';
import { EspnError, espnAccountFingerprint, fetchEspnLeague, normalizeEspnS2, normalizeSwid } from '../services/espn-client.js';

const r = Router();
r.use(requireAuthenticated);

export const ESPN_TEST_RESULTS = Object.freeze({
  PUBLIC_ACCESS: Object.freeze({
    code: 'ESPN_PUBLIC_ACCESS', connection_state: 'public',
    message: 'This ESPN league is publicly accessible.', next_action: 'continue'
  }),
  CREDENTIALS_REQUIRED: Object.freeze({
    code: 'ESPN_CREDENTIALS_REQUIRED', connection_state: 'credentials_required',
    message: 'This ESPN league requires credentials.', next_action: 'provide_credentials'
  }),
  CREDENTIALS_VALID: Object.freeze({
    code: 'ESPN_CREDENTIALS_VALID', connection_state: 'credentialed',
    message: 'ESPN credentials provide access to this league.', next_action: 'continue'
  }),
  CREDENTIALS_INVALID: Object.freeze({
    code: 'ESPN_CREDENTIALS_INVALID', connection_state: 'credentials_required',
    message: 'ESPN could not authenticate these credentials.', next_action: 'replace_credentials'
  }),
  RETRY: Object.freeze({
    code: 'ESPN_ACCESS_CHECK_FAILED', connection_state: 'unknown',
    message: 'ESPN access could not be checked right now.', next_action: 'retry'
  }),
  LEAGUE_MISMATCH: Object.freeze({
    code: 'ESPN_LEAGUE_MISMATCH', connection_state: 'mismatch',
    message: 'ESPN returned a different league or season.', next_action: 'correct_request'
  }),
  LEAGUE_NOT_FOUND: Object.freeze({
    code: 'ESPN_LEAGUE_NOT_FOUND', connection_state: 'not_found',
    message: 'No ESPN league was found for that league ID and season.', next_action: 'correct_request'
  })
});

const minify = s => s.replace(/(?<!:)\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/**
 * Source of the one-click bookmarklet. Private ESPN leagues need two cookies,
 * `espn_s2` and `SWID`, and the usual way to get them is a DevTools walkthrough most
 * people abandon. This script reads them on ESPN's own page and posts them straight
 * back to this router's `/cookies` endpoint.
 *
 * `/cookies` is per-league and requires a Bearer session, but the bookmarklet runs on
 * espn.com — a different origin with no access to this app's localStorage token. It is
 * generated fresh each time the signed-in user requests it (`GET /bookmarklet`), with
 * that request's own Authorization header baked in, so the saved link is only ever as
 * valid as the session that created it: it fails the moment that session expires or is
 * revoked, the same as any other authenticated call this app makes.
 */
const BOOKMARKLET = (origin, authorization) => `
(function(){
  function get(n){
    var m = document.cookie.match('(^|;)\\\\s*' + n + '\\\\s*=\\\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }
  var s2 = get('espn_s2'), swid = get('SWID');
  if (!s2 || !swid) {
    alert('Could not read the ESPN cookies.\\n\\nMake sure you are on espn.com and signed in to your fantasy account, then try again.');
    return;
  }
  var leagueId = (location.href.match(/leagueId[=/](\\d+)/i) || [])[1];
  var season = (location.href.match(/seasonId[=/](\\d+)/i) || [])[1] || new Date().getFullYear();
  if (!leagueId) {
    alert('Open your league on ESPN (its URL should contain leagueId=...) and try again.');
    return;
  }
  fetch('${origin}/api/espn-connect/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': '${authorization}' },
    body: JSON.stringify({ league_id: leagueId, season: Number(season), espn_s2: s2, swid: swid })
  })
  .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
  .then(function(result){
    if (result.ok) location.href = '${origin}/leagues?espn_connected=1';
    else alert('Gridiron HQ said: ' + (result.d.error || 'unknown error'));
  })
  .catch(function(){
    alert('Could not reach Gridiron HQ at ${origin}.\\n\\nMake sure the app is running, then try again.');
  });
})();`;

function requestedLeague(body = {}) {
  const leagueId = String(body.league_id ?? '').trim();
  const season = Number(body.season);
  if (!/^\d+$/.test(leagueId) || !Number.isInteger(season) || season < 2000 || season > 2200) {
    throw Object.assign(new Error('valid league_id and season are required'), { status: 400 });
  }
  return { leagueId, season };
}

function ownedLeague(req, leagueId, season) {
  const league = row(`SELECT * FROM leagues WHERE platform='espn' AND league_id=? AND season=?`, leagueId, season);
  if (league) assertLeagueMember(req.auth.userId, league.id);
  return league;
}

async function validateCredentials(body) {
  const { leagueId, season } = requestedLeague(body);
  const espn_s2 = normalizeEspnS2(body.espn_s2);
  const swid = normalizeSwid(body.swid);
  const data = await fetchEspnLeague({ leagueId, season, espn_s2, swid });
  return { leagueId, season, espn_s2, swid, data, fingerprint: espnAccountFingerprint(data) };
}

function sendError(error, res, next) {
  if (error instanceof EspnError || error.status) {
    return res.status(error.status ?? 502).json({ error: error.message, code: error.code });
  }
  return next(error);
}

function testResult(result, leagueId, season) {
  return { ...result, league_id: leagueId, season };
}

function testFailure(error, leagueId, season) {
  const result = error instanceof EspnError && error.code === 'ESPN_LEAGUE_MISMATCH'
    ? ESPN_TEST_RESULTS.LEAGUE_MISMATCH
    : error instanceof EspnError && error.code === 'ESPN_LEAGUE_NOT_FOUND'
      ? ESPN_TEST_RESULTS.LEAGUE_NOT_FOUND : ESPN_TEST_RESULTS.RETRY;
  return { status: error instanceof EspnError ? error.status : 502,
    body: testResult(result, leagueId, season) };
}

// Test access only. This endpoint never reads or writes a league row: public
// access is always attempted first and supplied credentials are used only when
// ESPN explicitly rejects the anonymous request as unauthenticated.
r.post('/test', async (req, res) => {
  let requested;
  try {
    requested = requestedLeague(req.body);
  } catch {
    return res.status(400).json({
      code: 'ESPN_INVALID_REQUEST', connection_state: 'unknown',
      message: 'A valid ESPN league ID and season are required.', next_action: 'correct_request'
    });
  }

  const { leagueId, season } = requested;
  try {
    await fetchEspnLeague({ leagueId, season });
    return res.json(testResult(ESPN_TEST_RESULTS.PUBLIC_ACCESS, leagueId, season));
  } catch (error) {
    if (!(error instanceof EspnError) || error.code !== 'ESPN_AUTHENTICATION_FAILED') {
      const failure = testFailure(error, leagueId, season);
      return res.status(failure.status).json(failure.body);
    }
  }

  const hasEspnS2 = String(req.body?.espn_s2 ?? '').trim().length > 0;
  const hasSwid = String(req.body?.swid ?? '').trim().length > 0;
  if (!hasEspnS2 && !hasSwid) {
    return res.json(testResult(ESPN_TEST_RESULTS.CREDENTIALS_REQUIRED, leagueId, season));
  }
  if (!hasEspnS2 || !hasSwid) {
    return res.status(400).json(testResult(ESPN_TEST_RESULTS.CREDENTIALS_INVALID, leagueId, season));
  }

  let espn_s2;
  let swid;
  try {
    espn_s2 = normalizeEspnS2(req.body.espn_s2);
    swid = normalizeSwid(req.body.swid);
  } catch {
    return res.status(400).json(testResult(ESPN_TEST_RESULTS.CREDENTIALS_INVALID, leagueId, season));
  }

  try {
    await fetchEspnLeague({ leagueId, season, espn_s2, swid });
    return res.json(testResult(ESPN_TEST_RESULTS.CREDENTIALS_VALID, leagueId, season));
  } catch (error) {
    if (error instanceof EspnError && error.code === 'ESPN_AUTHENTICATION_FAILED') {
      return res.status(401).json(testResult(ESPN_TEST_RESULTS.CREDENTIALS_INVALID, leagueId, season));
    }
    const failure = testFailure(error, leagueId, season);
    return res.status(failure.status).json(failure.body);
  }
});

// Manual credentials are persisted only after ESPN proves the exact league/season tuple.
r.post('/cookies', async (req, res, next) => {
  try {
    const validated = await validateCredentials(req.body);
    const existing = ownedLeague(req, validated.leagueId, validated.season);
    if (existing) {
      run(`UPDATE leagues SET espn_s2=?, swid=?, espn_connection_state='connected',
        espn_validated_at=datetime('now'), espn_account_fingerprint=? WHERE id=?`,
      validated.espn_s2, validated.swid, validated.fingerprint, existing.id);
    } else {
      const result = run(`INSERT INTO leagues
        (platform, league_id, season, name, team_count, espn_s2, swid,
         espn_connection_state, espn_validated_at, espn_account_fingerprint)
        VALUES ('espn',?,?,?,?,?,?,'connected',datetime('now'),?)`,
      validated.leagueId, validated.season, validated.data.settings?.name ?? null,
      validated.data.teams?.length ?? null, validated.espn_s2, validated.swid, validated.fingerprint);
      run(`INSERT INTO league_memberships (league_id,user_id,role) VALUES (?,?,'commissioner')`,
        Number(result.lastInsertRowid), req.auth.userId);
    }
    const saved = row(`SELECT id, league_id, season, name, team_count, espn_connection_state,
      espn_validated_at, espn_last_sync_at, espn_account_fingerprint
      FROM leagues WHERE platform='espn' AND league_id=? AND season=?`, validated.leagueId, validated.season);
    res.json({ ok: true, league: saved });
  } catch (error) { sendError(error, res, next); }
});

r.get('/status', (req, res, next) => {
  try {
    const { leagueId, season } = requestedLeague(req.query);
    const league = ownedLeague(req, leagueId, season);
    if (!league) return res.status(404).json({ error: 'league not found' });
    res.json({ league_id: league.league_id, season: league.season,
      connected: league.espn_connection_state === 'connected' && !!league.espn_s2 && !!league.swid,
      connection_state: league.espn_connection_state, validated_at: league.espn_validated_at,
      last_successful_sync_at: league.espn_last_sync_at,
      account_fingerprint: league.espn_account_fingerprint });
  } catch (error) { sendError(error, res, next); }
});

r.delete('/cookies', (req, res, next) => {
  try {
    const { leagueId, season } = requestedLeague(req.body);
    const league = ownedLeague(req, leagueId, season);
    if (!league) return res.status(404).json({ error: 'league not found' });
    run(`UPDATE leagues SET espn_s2=NULL, swid=NULL, espn_connection_state='disconnected',
      espn_validated_at=NULL, espn_account_fingerprint=NULL WHERE id=?`, league.id);
    res.json({ ok: true });
  } catch (error) { sendError(error, res, next); }
});

/** The bookmarklet as a javascript: URL, scoped to the requesting user's own session. */
r.get('/bookmarklet', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const authorization = req.get('authorization');
  const script = BOOKMARKLET(origin, authorization);
  res.json({ href: `javascript:${encodeURIComponent(minify(script))}`, origin });
});

r.post('/discover', async (req, res, next) => {
  try {
    const validated = await validateCredentials(req.body);
    res.json({ leagues: [{ league_id: validated.leagueId, season: validated.season,
      name: validated.data.settings?.name ?? `League ${validated.leagueId}`,
      team_count: validated.data.teams?.length ?? null }] });
  } catch (error) { sendError(error, res, next); }
});

export default r;
