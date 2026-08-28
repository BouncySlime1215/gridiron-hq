import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { espnCookies } from '../services/espn-draft.js';
import { findPlayerMatch } from '../services/player-identity.js';
import { recordSync } from '../services/scheduler.js';
import { extractEntities } from '../news/normalize.js';

const r = Router();

// A real, queryable audit trail of every team change this sync has ever
// detected — the actual answer to "spot them all, not just guessing". Before
// this, a team_id UPDATE was silent: correct in the moment, but nothing
// recorded that a player named A.J. Brown genuinely moved teams versus his
// row having always said that. Now every detected move is a row here.
import { db } from '../db/index.js';
db.exec(`CREATE TABLE IF NOT EXISTS player_team_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL, from_team TEXT, to_team TEXT, detected_at TEXT NOT NULL
)`);
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const SEASON = () => Number(process.env.NFL_SEASON) || new Date().getFullYear();

// A single global "ESPN league settings" row used to be the only way this app knew
// about a league — /settings, /sync and /league (plus the espn_settings/espn_cache
// tables) all served that. It's gone now: leagues are per-row in the `leagues` table
// (see routes/leagues.js and EspnConnect.tsx's bookmarklet-based multi-league
// connect), and My Team/Trade Lab/the draft tools only ever read from there. Editing
// this page's old form had silently stopped doing anything anywhere else in the app.
// What's still real and kept below: pulling ESPN's global player pool/depth charts
// and pulling ESPN's public news feed — neither is tied to any one league's settings.

// ESPN proTeamId -> our abbr
const PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
};
const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

// Pull ESPN's fantasy player universe (rookies included) and upsert as source of truth.
export async function syncPlayersFromESPN() {
  try {
    const season = SEASON();
    const url = `${BASE}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const filter = { players: { limit: 800, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };
    const headers = { Accept: 'application/json', 'X-Fantasy-Filter': JSON.stringify(filter) };
    // This is a public default-league endpoint, not tied to any one private league,
    // but sending cookies from whichever ESPN league is connected (if any) can only
    // help it see a fuller/more current player pool — same helper the live-draft
    // sync uses to find cookies, so there's one real source for them, not two.
    const { s2, swid } = espnCookies();
    if (s2 && swid) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`ESPN players API ${resp.status}`);
    const data = await resp.json();
    const players = data.players ?? [];

    const teamIdByAbbr = {};
    for (const t of rows('SELECT id, abbr FROM nfl_teams')) teamIdByAbbr[t.abbr] = t.id;

    let updated = 0, added = 0;
    const ambiguous = [];
    // Read the player table once and match in memory. The old query matched on
    // `lower(name) = lower(?)`, which missed "Ja'Marr Chase" vs "Ja’Marr Chase" and
    // inserted a duplicate every sync, then took whichever row came first when two
    // real players share a name. See services/player-identity.js.
    const known = rows('SELECT id, name, position, team_id, espn_id FROM players');
    const teamAbbrById = Object.fromEntries(rows('SELECT id, abbr FROM nfl_teams').map(t => [t.id, t.abbr]));
    const candidates = {}; // teamId -> position -> [{id, pct}] for depth-chart rebuild
    const teamChanges = [];
    players.forEach((entry, idx) => {
      const pl = entry.player ?? entry;
      const pos = ESPN_POS[pl.defaultPositionId];
      if (!pos || !pl.fullName) return;
      const abbr = PRO_TEAM[pl.proTeamId] ?? null;
      const teamId = abbr ? teamIdByAbbr[abbr] : null;
      const incoming = { espn_id: pl.id ?? null, name: pl.fullName, position: pos, team_id: teamId };
      const { match, ambiguous: isAmbiguous } = findPlayerMatch(known, incoming);

      if (isAmbiguous) {
        // Several existing rows are equally plausible and each already belongs to a
        // different ESPN player. Binding one would corrupt a real player's identity,
        // so report it rather than guess; the sync still completes for everyone else.
        ambiguous.push({ name: pl.fullName, position: pos, espn_id: pl.id ?? null });
        return;
      }

      let playerId;
      if (match) {
        playerId = match.id;
        // A genuine team change, not a routine re-affirmation of the same team —
        // the distinction that makes this an audit trail rather than log noise.
        // Only fires once known.team_id was already something (never for a
        // freshly-added or previously-team-less row).
        if (match.team_id != null && teamId != null && match.team_id !== teamId) {
          teamChanges.push({ player_id: playerId, player_name: pl.fullName,
            from_team: teamAbbrById[match.team_id] ?? null, to_team: teamAbbrById[teamId] ?? null });
        }
        // ESPN's own fullName is authoritative for whatever espn_id it just sent —
        // when a row is bound (or re-bound) by that id, its name has to move with it.
        // Leaving the old name in place is exactly how a rookie who takes over a
        // reused/rebound row ends up permanently displayed under a different real
        // player's name everywhere in the app (roster, lineup solver, projections).
        run('UPDATE players SET team_id = ?, fantasy_relevant = 1, espn_id = ?, name = ? WHERE id = ?',
          teamId, pl.id ?? null, pl.fullName, playerId);
        // Keep the in-memory view current so a later row in this same batch can't
        // re-match the row we just bound.
        match.espn_id = pl.id ?? null;
        match.team_id = teamId;
        match.name = pl.fullName;
        updated++;
      } else {
        const result = run('INSERT INTO players (name, position, team_id, depth_rank, phase, fantasy_relevant, espn_id) VALUES (?,?,?,?,?,1,?)',
          pl.fullName, pos, teamId, 1, pos === 'K' ? 'special_teams' : 'offense', pl.id ?? null);
        playerId = Number(result.lastInsertRowid);
        known.push({ id: playerId, ...incoming });
        added++;
      }
      // ESPN list is sorted by ownership; use percentOwned with list order as fallback
      const pct = pl.ownership?.percentOwned ?? (players.length - idx) / players.length;
      if (teamId) (((candidates[teamId] ??= {})[pos] ??= [])).push({ id: playerId, pct });
    });

    // Rebuild offensive depth charts from ESPN ownership — ESPN is the source of truth.
    // (Defensive slots keep their editorial assignments; ESPN's fantasy pull is offense+K.)
    const SLOT_ORDER = { QB: ['QB'], RB: ['RB1', 'RB2'], WR: ['WR1', 'WR2', 'WR3'], TE: ['TE1'], K: ['K'] };
    run(`UPDATE players SET slot_code = NULL WHERE phase IN ('offense','special_teams')`);
    for (const [teamId, byPos] of Object.entries(candidates)) {
      for (const [pos, codes] of Object.entries(SLOT_ORDER)) {
        const ranked = (byPos[pos] ?? []).sort((a, b) => b.pct - a.pct);
        codes.forEach((code, i) => {
          if (ranked[i]) run('UPDATE players SET slot_code = ?, depth_rank = ? WHERE id = ?', code, i + 1, ranked[i].id);
        });
      }
    }
    // `ambiguous` is surfaced rather than swallowed: each entry is a real ESPN player
    // this sync deliberately refused to bind, so it should be visible, not silent.
    if (teamChanges.length) {
      const now = new Date().toISOString();
      const insertChange = db.prepare(`INSERT INTO player_team_changes
        (player_id,player_name,from_team,to_team,detected_at) VALUES (?,?,?,?,?)`);
      for (const c of teamChanges) insertChange.run(c.player_id, c.player_name, c.from_team, c.to_team, now);
    }
    const result = { ok: true, fetched: players.length, updated, added, ambiguous_count: ambiguous.length,
      ambiguous, team_changes: teamChanges };
    recordSync('espn_players', 'ok', result);
    return result;
  } catch (e) { recordSync('espn_players', 'error', e.message); throw e; }
}

/** Every team change this sync has ever caught, newest first — the audit trail itself. */
r.get('/team-changes', (req, res) => {
  res.json(rows(`SELECT * FROM player_team_changes ORDER BY detected_at DESC LIMIT ?`, Number(req.query.limit) || 100));
});

r.post('/sync-players', async (req, res, next) => {
  try { res.json(await syncPlayersFromESPN()); } catch (e) { next(e); }
});

let _playerIdentityCache = null;
/** Cached per process-tick, not per call — this runs once per sync batch, not once per article. */
function playerIdentity() {
  if (!_playerIdentityCache) _playerIdentityCache = rows(`SELECT id, name FROM players WHERE fantasy_relevant = 1`);
  return _playerIdentityCache;
}

/**
 * This was the actual reason so many stories never produced a typed claim
 * regardless of how good the extraction rules were: ESPN's news pull is the
 * most-used ingestion path (the default "Pull ESPN news" button) and never
 * populated entities_json at all, unlike the RSS and Twitter pipelines which
 * both call extractEntities. A story with no resolved player entity is
 * invisible to nfl-news-signal.js no matter what it says — confirmed live:
 * the Tunsil-torn-triceps story matched the injury regex correctly and was
 * still skipped, because entities_json was null.
 */
function insertArticles(articles, teams, forcedTeamId = null) {
  let added = 0;
  const players = playerIdentity();
  for (const a of articles) {
    if (!a.headline) continue;
    const exists = row('SELECT id FROM news_items WHERE headline = ?', a.headline);
    if (exists) continue;
    const date = (a.published ?? new Date().toISOString()).slice(0, 10);
    const text = `${a.headline} ${a.description ?? ''}`;
    // word-boundary match on full team name or nickname ("Browns" must not match "Brown")
    const team = forcedTeamId != null
      ? { id: forcedTeamId }
      : teams.find(t => {
          const nickname = t.name.split(' ').pop();
          return new RegExp(`\\b${t.name}\\b`).test(text) || new RegExp(`\\b${nickname}\\b`).test(text);
        });
    const entities = extractEntities(text, { players, teams });
    // published_at was never set here, only `date` — and the typed-claims
    // extractor filters on `published_at IS NOT NULL`, so every ESPN-sourced
    // story was invisible to it regardless of entity resolution. Real
    // published timestamp when ESPN provides one; the ingest time otherwise,
    // which is still strictly after the story existed and keeps it visible.
    const publishedAt = a.published ? new Date(a.published).toISOString() : new Date().toISOString();
    run(`INSERT INTO news_items (date, team_id, headline, body, importance, source, entities_json, published_at)
         VALUES (?,?,?,?,2,'ESPN',?,?)`, date, team?.id ?? null, a.headline, a.description ?? null,
      JSON.stringify(entities), publishedAt);
    added++;
  }
  return added;
}

/**
 * One-time backfill for the existing backlog inserted before this fix — the
 * ~1,100 stories already sitting with entities_json = NULL. Safe to re-run;
 * only touches rows still missing entities.
 */
export function backfillNewsEntities() {
  const players = playerIdentity();
  const teams = rows('SELECT id, name, abbr FROM nfl_teams');
  const missing = rows(`SELECT id, date, headline, body FROM news_items WHERE entities_json IS NULL OR published_at IS NULL`);
  const update = db.prepare(`UPDATE news_items SET entities_json = ?, published_at = COALESCE(published_at, ?) WHERE id = ?`);
  let updated = 0, resolved = 0;
  for (const item of missing) {
    const entities = extractEntities(`${item.headline} ${item.body ?? ''}`, { players, teams });
    // Backdated to the story's own `date` where we have nothing better, not
    // "now" — a story from three weeks ago should not suddenly look like it
    // just published, which would distort "is this news recent" everywhere
    // that reads published_at.
    const fallbackPublishedAt = item.date ? new Date(`${item.date}T12:00:00Z`).toISOString() : new Date().toISOString();
    update.run(JSON.stringify(entities), fallbackPublishedAt, item.id);
    updated++;
    if (entities.players.length) resolved++;
  }
  return { checked: missing.length, updated, resolved_a_player: resolved };
}

export async function syncTeamNewsFeed(abbr) {
  try {
    const teams = rows('SELECT id, abbr, name FROM nfl_teams');
    const abbrToEspnId = Object.fromEntries(Object.entries(PRO_TEAM).map(([id, ab]) => [ab, id]));
    const team = teams.find(t => t.abbr === abbr);
    const espnId = abbrToEspnId[abbr];
    if (!team || !espnId) throw new Error(`unknown team ${abbr}`);
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?team=${espnId}&limit=20`,
      { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`ESPN team news API ${resp.status}`);
    const added = insertArticles((await resp.json()).articles ?? [], teams, team.id);
    recordSync('espn_news_team', 'ok', { abbr, added });
    return added;
  } catch (e) { recordSync('espn_news_team', 'error', `${abbr}: ${e.message}`); throw e; }
}

export async function syncGeneralNews() {
  try {
    const teams = rows('SELECT id, abbr, name FROM nfl_teams');
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50',
      { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`ESPN news API ${resp.status}`);
    const added = insertArticles((await resp.json()).articles ?? [], teams);
    recordSync('espn_news_general', 'ok', { added });
    return added;
  } catch (e) { recordSync('espn_news_general', 'error', e.message); throw e; }
}

// Pull latest headlines from ESPN's public news API. With ?team=ABBR pulls that
// team's own feed (press conferences, beat coverage); otherwise league-wide news.
r.post('/sync-news', async (req, res, next) => {
  try {
    const added = req.query.team
      ? await syncTeamNewsFeed(String(req.query.team).toUpperCase())
      : await syncGeneralNews();
    res.json({ ok: true, added });
  } catch (e) { next(e); }
});

export default r;
