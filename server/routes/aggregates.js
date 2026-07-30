import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { syncPlayersFromESPN, syncGeneralNews, syncTeamNewsFeed } from './espn.js';
import { deriveFormat } from '../services/format.js';

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
    run('UPDATE players SET sleeper_id = ? WHERE id = ?', p.player_id, id);
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

// FantasyCalc — market trade values from real trades (via akodsi/fantasy-advisor).
// We use redraft values + the 30-day trend as a buy/sell signal.
async function syncFantasyCalc() {
  const league = row(`SELECT team_count, ppr, superflex FROM leagues ORDER BY id LIMIT 1`);
  const params = new URLSearchParams({
    isDynasty: 'false',
    numQbs: String(league?.superflex ? 2 : 1),
    numTeams: String(league?.team_count ?? 12),
    ppr: String(league?.ppr ?? 1)
  });
  const resp = await fetch(`https://api.fantasycalc.com/values/current?${params}`, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`FantasyCalc API ${resp.status}`);
  const data = await resp.json();
  const bySleeper = new Map(rows('SELECT id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL').map(p => [p.sleeper_id, p.id]));
  const lookup = playerLookup();
  let matched = 0;
  const upsert = (id, source, value) =>
    run(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
      id, source, value);
  for (const entry of data) {
    const p = entry.player ?? {};
    if (p.position === 'PICK') continue;
    const id = (p.sleeperId && bySleeper.get(String(p.sleeperId)))
      ?? lookup.get(`${normName(p.name ?? '')}|${p.position}`);
    if (!id) continue;
    if (entry.redraftValue != null) upsert(id, 'fc_value', entry.redraftValue);
    if (entry.trend30Day != null) upsert(id, 'fc_trend30', entry.trend30Day);
    if (entry.maybeAdp != null) upsert(id, 'fc_adp', entry.maybeAdp);
    matched++;
  }
  return { fetched: data.length, matched };
}

/**
 * Format-aware value sync. FantasyCalc prices per league shape, so we pull one value
 * set per distinct format across the connected leagues rather than one global set.
 * Draft picks only exist in the dynasty value set (isDynasty=false returns zero picks),
 * which is why dynasty leagues need this to have any pick capital at all.
 */
export async function syncDynastyValues() {
  const leagues = rows('SELECT * FROM leagues');
  const seen = new Set();
  const results = [];

  for (const lg of leagues) {
    const { formatKey, params, isDynasty } = deriveFormat(lg);
    if (seen.has(formatKey)) continue;
    seen.add(formatKey);

    const resp = await fetch(`https://api.fantasycalc.com/values/current?${params}`,
      { headers: { Accept: 'application/json' } });
    if (!resp.ok) { results.push({ formatKey, error: `FantasyCalc ${resp.status}` }); continue; }
    const data = await resp.json();

    const bySleeper = new Map(rows('SELECT id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL')
      .map(p => [String(p.sleeper_id), p.id]));
    const lookup = playerLookup();

    const upPlayer = db.prepare(`INSERT INTO dynasty_values
        (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(format_key, player_id) DO UPDATE SET
        value=excluded.value, redraft_value=excluded.redraft_value, trend30=excluded.trend30,
        age=excluded.age, pos_rank=excluded.pos_rank, fetched_at=excluded.fetched_at`);
    const upPick = db.prepare(`INSERT INTO pick_values
        (format_key, pick_key, label, season, round, value, fetched_at)
      VALUES (?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(format_key, pick_key) DO UPDATE SET
        label=excluded.label, season=excluded.season, round=excluded.round,
        value=excluded.value, fetched_at=excluded.fetched_at`);

    let players = 0, picks = 0;
    for (const entry of data) {
      const p = entry.player ?? {};
      if (p.position === 'PICK') {
        // Generic round values ("2027 1st" -> FP_2027_1) are what pick inventory uses;
        // draft order is unknown ahead of time so slot-specific DP_ keys are skipped.
        const m = /^FP_(\d{4})_(\d+)$/.exec(p.sleeperId ?? '');
        if (!m) continue;
        upPick.run(formatKey, p.sleeperId, p.name ?? null, Number(m[1]), Number(m[2]), entry.value ?? 0);
        picks++;
        continue;
      }
      const id = (p.sleeperId && bySleeper.get(String(p.sleeperId)))
        ?? lookup.get(`${normName(p.name ?? '')}|${p.position}`);
      if (!id) continue;
      upPlayer.run(formatKey, id, entry.value ?? null, entry.redraftValue ?? null,
        entry.trend30Day ?? null, p.maybeAge ?? null, entry.positionRank ?? null);
      players++;
    }
    results.push({ formatKey, isDynasty, fetched: data.length, players, picks });
  }
  return { formats: results };
}

r.post('/sync', async (req, res, next) => {
  try {
    const season = row('SELECT season FROM espn_settings WHERE id = 1')?.season ?? new Date().getFullYear();
    const [ffc, sleeper, fc, dyn] = await Promise.allSettled([
      syncFFC(season), syncSleeper(), syncFantasyCalc(), syncDynastyValues()
    ]);
    res.json({
      ok: true,
      ffc: ffc.status === 'fulfilled' ? ffc.value : { error: ffc.reason.message },
      sleeper: sleeper.status === 'fulfilled' ? sleeper.value : { error: sleeper.reason.message },
      fantasycalc: fc.status === 'fulfilled' ? fc.value : { error: fc.reason.message },
      dynasty: dyn.status === 'fulfilled' ? dyn.value : { error: dyn.reason.message }
    });
  } catch (e) { next(e); }
});

/** FantasyCalc's trend30Day is a raw point delta — express it as % of the prior value. */
export function trendPct(value, trend) {
  if (value == null || trend == null) return null;
  const prior = value - trend;
  if (!prior) return null;
  return (trend / prior) * 100;
}

// Aggregate view: each source rank + blended consensus
export function computeConsensus() {
  const players = rows(`
    SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr, t.primary_color,
           ffc.value AS ffc_adp, sl.value AS sleeper_rank, inj.value AS injury_flag,
           fcv.value AS fc_value, fct.value AS fc_trend30
    FROM players p
    LEFT JOIN nfl_teams t ON t.id = p.team_id
    LEFT JOIN player_metrics ffc ON ffc.player_id = p.id AND ffc.source = 'ffc_adp'
    LEFT JOIN player_metrics sl ON sl.player_id = p.id AND sl.source = 'sleeper_rank'
    LEFT JOIN player_metrics inj ON inj.player_id = p.id AND inj.source = 'injury_flag'
    LEFT JOIN player_metrics fcv ON fcv.player_id = p.id AND fcv.source = 'fc_value'
    LEFT JOIN player_metrics fct ON fct.player_id = p.id AND fct.source = 'fc_trend30'
    WHERE ffc.value IS NOT NULL OR sl.value IS NOT NULL`);

  // convert each source's raw value to an ordinal rank, then average available ranks
  const bySource = { ffc_adp: [...players].filter(p => p.ffc_adp != null).sort((a, b) => a.ffc_adp - b.ffc_adp),
                     sleeper: [...players].filter(p => p.sleeper_rank != null).sort((a, b) => a.sleeper_rank - b.sleeper_rank) };
  const ffcRank = new Map(bySource.ffc_adp.map((p, i) => [p.id, i + 1]));
  const slRank = new Map(bySource.sleeper.map((p, i) => [p.id, i + 1]));

  return players.map(p => {
    const ranks = [ffcRank.get(p.id), slRank.get(p.id)].filter(x => x != null);
    return { ...p, ffc_rank: ffcRank.get(p.id) ?? null, sleeper_ordinal: slRank.get(p.id) ?? null,
             // fc_trend30 is a raw point change; convert to % of the value 30 days ago
             fc_trend_pct: trendPct(p.fc_value, p.fc_trend30),
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
    const fc = await syncFantasyCalc().catch(e => ({ error: e.message })); // after Sleeper so sleeper_ids exist
    const dyn = await syncDynastyValues().catch(e => ({ error: e.message }));
    result.aggregates = {
      ffc: ffc.status === 'fulfilled' ? ffc.value : { error: ffc.reason.message },
      sleeper: sleeper.status === 'fulfilled' ? sleeper.value : { error: sleeper.reason.message },
      fantasycalc: fc,
      dynasty: dyn
    };
    res.json({ ok: true, ...result,
      note: 'Now run the AI analysis pass (POST /api/analysis/refresh) — it updates outlooks for teams with new news.' });
  } catch (e) { next(e); }
});

export default r;
