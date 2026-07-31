/**
 * One-click ESPN connection.
 *
 * Private ESPN leagues need two cookies, `espn_s2` and `SWID`, and the usual way to get
 * them is a nine-step DevTools walkthrough that most people abandon. This route serves a
 * bookmarklet that reads them on ESPN's own page and posts them straight back here.
 *
 * The cookies never leave the machine: the bookmarklet runs in the user's browser and
 * posts to localhost. Nothing is sent anywhere but ESPN's API, exactly as before.
 */
import { Router } from 'express';
import { rows, row, run } from '../db/index.js';

const r = Router();
const PORT = process.env.API_PORT || 5177;

/* --------------------------------------------------------- the bookmarklet */

/**
 * Source of the bookmarklet. Kept readable here and minified on the way out, so the
 * thing the user drags to their bookmarks bar is small but this stays maintainable.
 *
 * espn_s2 is not HttpOnly, so document.cookie can see it. When ESPN changes that, the
 * script says so plainly instead of silently posting nothing.
 */
const BOOKMARKLET = origin => `
(function(){
  function get(n){
    var m = document.cookie.match('(^|;)\\\\s*' + n + '\\\\s*=\\\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }
  var s2 = get('espn_s2'), swid = get('SWID');
  if (!s2 || !swid) {
    alert('Could not read the ESPN cookies.\\n\\n' +
          'Make sure you are on espn.com and signed in to your fantasy account, then try again.\\n\\n' +
          'If it still fails, ESPN may have changed their cookie settings — ' +
          'you can copy them manually from DevTools > Application > Cookies.');
    return;
  }
  var leagues = [];
  try {
    var m = location.href.match(/leagueId[=/](\\d+)/i);
    if (m) leagues.push(m[1]);
  } catch (e) {}
  fetch('${origin}/api/espn-connect/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: s2, swid: swid, league_ids: leagues })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    alert(d.ok
      ? 'Connected to Gridiron HQ.' + (d.leagues_found ? '\\n\\nFound ' + d.leagues_found + ' league(s) on your account.' : '') + '\\n\\nGo back to the app and open My Leagues.'
      : 'Gridiron HQ said: ' + (d.error || 'unknown error'));
  })
  .catch(function(){
    alert('Could not reach Gridiron HQ at ${origin}.\\n\\nMake sure the app is running, then try again.');
  });
})();`;

const minify = s => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** The bookmarklet as a javascript: URL, plus instructions for the Settings page. */
r.get('/bookmarklet', (req, res) => {
  const origin = `http://localhost:${PORT}`;
  res.json({
    href: `javascript:${encodeURIComponent(minify(BOOKMARKLET(origin)))}`,
    console_snippet: minify(BOOKMARKLET(origin)),
    origin
  });
});

/* ------------------------------------------------------------ the receiver */

/**
 * Store cookies posted by the bookmarklet, then look up which leagues the account
 * actually has — so the user picks from a list instead of hunting for a league id.
 */
r.post('/cookies', async (req, res, next) => {
  try {
    const espn_s2 = (req.body?.espn_s2 ?? '').trim();
    const swidRaw = (req.body?.swid ?? '').trim();
    if (!espn_s2 || !swidRaw) return res.status(400).json({ error: 'both espn_s2 and SWID are required' });
    // ESPN's API wants the SWID wrapped in braces; the cookie sometimes already is.
    const swid = swidRaw.startsWith('{') ? swidRaw : `{${swidRaw}}`;

    run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, espn_s2);
    run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, swid);
    // Keep any already-connected leagues working with the refreshed cookies.
    run(`UPDATE leagues SET espn_s2 = ?, swid = ? WHERE platform = 'espn'`, espn_s2, swid);

    const found = await discoverLeagues(espn_s2, swid).catch(() => []);
    res.json({ ok: true, leagues_found: found.length, leagues: found });
  } catch (e) { next(e); }
});

/** Cookies currently held, masked — enough to confirm they are set, not to leak them. */
r.get('/status', (req, res) => {
  const get = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
  const s2 = get('espn_s2'), swid = get('swid');
  res.json({
    connected: !!(s2 && swid),
    espn_s2_preview: s2 ? `${s2.slice(0, 6)}…${s2.slice(-4)} (${s2.length} chars)` : null,
    swid_preview: swid ? `${swid.slice(0, 10)}…` : null,
    leagues: rows(`SELECT id, league_id, season, name, team_count FROM leagues WHERE platform='espn'`)
  });
});

r.delete('/cookies', (req, res) => {
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid')`);
  res.json({ ok: true });
});

/**
 * Every league on the account for the current season.
 *
 * ESPN's fan API returns the user's fantasy preferences, each carrying a league id —
 * which is how we turn "signed in" into "here are your leagues" without asking the user
 * to find an id in a URL.
 */
async function discoverLeagues(espn_s2, swid) {
  const season = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const headers = { Cookie: `espn_s2=${espn_s2}; SWID=${swid}`, Accept: 'application/json' };

  const res = await fetch(
    `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}?featureFlags=challengeEntries&showAirings=buy,live,replay&source=ESPN.com+-+FAM&lang=en&section=espn`,
    { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
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

/** Re-run discovery on demand, using stored cookies. */
r.get('/discover', async (req, res, next) => {
  try {
    const get = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
    const s2 = get('espn_s2'), swid = get('swid');
    if (!s2 || !swid) return res.status(400).json({ error: 'no ESPN cookies stored yet — run the connector first' });
    res.json({ leagues: await discoverLeagues(s2, swid) });
  } catch (e) { next(e); }
});

/** Add a discovered league straight into the leagues table. */
r.post('/add', async (req, res, next) => {
  try {
    const { league_id, season, my_team_id, name } = req.body ?? {};
    if (!league_id) return res.status(400).json({ error: 'league_id required' });
    const get = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
    const s2 = get('espn_s2'), swid = get('swid');
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
    res.json({ ok: true, id: lg?.id, note: 'Now hit Sync on the My Leagues page to pull rosters.' });
  } catch (e) { next(e); }
});

export default r;
