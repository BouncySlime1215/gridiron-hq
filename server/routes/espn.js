import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { espnCookies } from '../services/espn-draft.js';
import { findPlayerMatch } from '../services/player-identity.js';
import { recordSync } from '../services/scheduler.js';

const r = Router();
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
    const candidates = {}; // teamId -> position -> [{id, pct}] for depth-chart rebuild
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
        run('UPDATE players SET team_id = ?, fantasy_relevant = 1, espn_id = ? WHERE id = ?', teamId, pl.id ?? null, playerId);
        // Keep the in-memory view current so a later row in this same batch can't
        // re-match the row we just bound.
        match.espn_id = pl.id ?? null;
        match.team_id = teamId;
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
    const result = { ok: true, fetched: players.length, updated, added, ambiguous_count: ambiguous.length, ambiguous };
    recordSync('espn_players', 'ok', result);
    return result;
  } catch (e) { recordSync('espn_players', 'error', e.message); throw e; }
}

r.post('/sync-players', async (req, res, next) => {
  try { res.json(await syncPlayersFromESPN()); } catch (e) { next(e); }
});

function insertArticles(articles, teams, forcedTeamId = null) {
  let added = 0;
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
    run(`INSERT INTO news_items (date, team_id, headline, body, importance, source)
         VALUES (?,?,?,?,2,'ESPN')`, date, team?.id ?? null, a.headline, a.description ?? null);
    added++;
  }
  return added;
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
