import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { syncPlayersFromESPN, syncGeneralNews, syncTeamNewsFeed } from './espn.js';

const r = Router();

db.exec(`CREATE TABLE IF NOT EXISTS player_metrics (
  player_id INTEGER NOT NULL REFERENCES players(id),
  source TEXT NOT NULL,
  value REAL NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, source)
)`);

// normalize names across platforms: lowercase, strip punctuation and suffixes
function normName(name) {
  return name.toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function playerLookup() {
  const map = new Map();
  for (const p of rows('SELECT id, name, position FROM players')) {
    map.set(`${normName(p.name)}|${p.position}`, p.id);
  }
  return map;
}

// FantasyFootballCalculator ADP — free public API
async function syncFFC(season) {
  const resp = await fetch(`https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}`,
    { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`FFC ADP API ${resp.status}`);
  const data = await resp.json();
  const lookup = playerLookup();
  let matched = 0;
  for (const p of data.players ?? []) {
    const pos = p.position === 'PK' ? 'K' : p.position;
    const id = lookup.get(`${normName(p.name)}|${pos}`);
    if (!id) continue;
    run(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?,'ffc_adp',?,datetime('now'))
         ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
      id, p.adp);
    matched++;
  }
  return { fetched: (data.players ?? []).length, matched };
}

// Sleeper — free public API; search_rank approximates their overall player ranking
async function syncSleeper() {
  const resp = await fetch('https://api.sleeper.app/v1/players/nfl', { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Sleeper API ${resp.status}`);
  const data = await resp.json();
  const lookup = playerLookup();
  let matched = 0;
  for (const p of Object.values(data)) {
    if (!p.full_name || !p.position || !p.search_rank || p.search_rank > 9000000) continue;
    if (!['QB', 'RB', 'WR', 'TE', 'K'].includes(p.position)) continue;
    const id = lookup.get(`${normName(p.full_name)}|${p.position}`);
    if (!id) continue;
    run(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?,'sleeper_rank',?,datetime('now'))
         ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
      id, p.search_rank);
    matched++;
    if (p.injury_status) {
      run(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?,'injury_flag',1,datetime('now'))
           ON CONFLICT(player_id, source) DO UPDATE SET value = 1, fetched_at = excluded.fetched_at`, id);
    }
  }
  return { matched };
}

r.post('/sync', async (req, res, next) => {
  try {
    const season = row('SELECT season FROM espn_settings WHERE id = 1')?.season ?? new Date().getFullYear();
    const [ffc, sleeper] = await Promise.allSettled([syncFFC(season), syncSleeper()]);
    res.json({
      ok: true,
      ffc: ffc.status === 'fulfilled' ? ffc.value : { error: ffc.reason.message },
      sleeper: sleeper.status === 'fulfilled' ? sleeper.value : { error: sleeper.reason.message }
    });
  } catch (e) { next(e); }
});

// Aggregate view: each source rank + blended consensus
export function computeConsensus() {
  const players = rows(`
    SELECT p.id, p.name, p.position, t.abbr AS team_abbr, t.primary_color,
           ffc.value AS ffc_adp, sl.value AS sleeper_rank, inj.value AS injury_flag
    FROM players p
    LEFT JOIN nfl_teams t ON t.id = p.team_id
    LEFT JOIN player_metrics ffc ON ffc.player_id = p.id AND ffc.source = 'ffc_adp'
    LEFT JOIN player_metrics sl ON sl.player_id = p.id AND sl.source = 'sleeper_rank'
    LEFT JOIN player_metrics inj ON inj.player_id = p.id AND inj.source = 'injury_flag'
    WHERE ffc.value IS NOT NULL OR sl.value IS NOT NULL`);

  // convert each source's raw value to an ordinal rank, then average available ranks
  const bySource = { ffc_adp: [...players].filter(p => p.ffc_adp != null).sort((a, b) => a.ffc_adp - b.ffc_adp),
                     sleeper: [...players].filter(p => p.sleeper_rank != null).sort((a, b) => a.sleeper_rank - b.sleeper_rank) };
  const ffcRank = new Map(bySource.ffc_adp.map((p, i) => [p.id, i + 1]));
  const slRank = new Map(bySource.sleeper.map((p, i) => [p.id, i + 1]));

  return players.map(p => {
    const ranks = [ffcRank.get(p.id), slRank.get(p.id)].filter(x => x != null);
    return { ...p, ffc_rank: ffcRank.get(p.id) ?? null, sleeper_ordinal: slRank.get(p.id) ?? null,
             consensus: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null };
  }).filter(p => p.consensus != null).sort((a, b) => a.consensus - b.consensus);
}

r.get('/', (req, res) => res.json(computeConsensus()));

// Create a ranking set from the consensus order
r.post('/create-board', (req, res) => {
  const name = req.body?.name || `Consensus ${new Date().toISOString().slice(0, 10)}`;
  const limit = req.body?.limit ?? 200;
  run('INSERT INTO ranking_sets (name, scoring) VALUES (?, ?)', name, 'PPR');
  const setId = row('SELECT last_insert_rowid() AS id').id;
  const payload = computeConsensus();
  payload.slice(0, limit).forEach((p, i) => {
    const tier = i < 6 ? 1 : i < 15 ? 2 : i < 30 ? 3 : i < 50 ? 4 : i < 75 ? 5 : 6;
    run('INSERT INTO ranking_entries (set_id, player_id, rank, tier) VALUES (?,?,?,?)', setId, p.id, i + 1, tier);
  });
  res.json({ ok: true, set_id: setId, count: Math.min(payload.length, limit) });
});

// Whole-dashboard refresh: ESPN players + league-wide news + every team feed + AI analysis pass
r.post('/refresh-all', async (req, res, next) => {
  try {
    const result = { players: null, news: { general: 0, teams: 0 }, aggregates: null };
    result.players = await syncPlayersFromESPN().catch(e => ({ error: e.message }));
    result.news.general = await syncGeneralNews().catch(() => 0);
    const abbrs = rows('SELECT abbr FROM nfl_teams').map(t => t.abbr);
    for (let i = 0; i < abbrs.length; i += 8) {
      const batch = abbrs.slice(i, i + 8);
      const counts = await Promise.allSettled(batch.map(a => syncTeamNewsFeed(a)));
      result.news.teams += counts.reduce((s, c) => s + (c.status === 'fulfilled' ? c.value : 0), 0);
    }
    const season = row('SELECT season FROM espn_settings WHERE id = 1')?.season ?? new Date().getFullYear();
    const [ffc, sleeper] = await Promise.allSettled([syncFFC(season), syncSleeper()]);
    result.aggregates = {
      ffc: ffc.status === 'fulfilled' ? ffc.value : { error: ffc.reason.message },
      sleeper: sleeper.status === 'fulfilled' ? sleeper.value : { error: sleeper.reason.message }
    };
    res.json({ ok: true, ...result,
      note: 'Now run the AI analysis pass (POST /api/analysis/refresh) — it updates outlooks for teams with new news.' });
  } catch (e) { next(e); }
});

export default r;
