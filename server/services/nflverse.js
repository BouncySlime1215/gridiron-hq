/**
 * nflverse ingestion.
 *
 * nflverse publishes cleaned NFL data as plain files on GitHub releases — no API key,
 * no client library, no rate limit. `stats_player_week` is the important one: it carries
 * per-week volume (targets, carries, attempts), the share metrics that actually predict
 * fantasy scoring (target_share, air_yards_share, wopr), and efficiency (EPA, CPOE,
 * racr, pacr). That single feed is the substrate the whole usage model runs on.
 *
 * Players are joined on espn_id via nflverse's own crosswalk rather than by name —
 * the app already keys on espn_id, and name matching is what produced the duplicate
 * rows this codebase is still cleaning up.
 */
import { db, rows, row, run } from '../db/index.js';
import { findPlayerMatch, normalizePlayerName } from './player-identity.js';
import { recordSync } from './scheduler.js';

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';

db.exec(`
  CREATE TABLE IF NOT EXISTS player_week_usage (
    player_id INTEGER NOT NULL REFERENCES players(id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT,
    opponent TEXT,
    position TEXT,
    -- opportunity
    attempts REAL, carries REAL, targets REAL, receptions REAL,
    target_share REAL, air_yards_share REAL, wopr REAL,
    receiving_air_yards REAL, passing_air_yards REAL,
    -- production
    passing_yards REAL, rushing_yards REAL, receiving_yards REAL,
    passing_tds REAL, rushing_tds REAL, receiving_tds REAL,
    interceptions REAL, fumbles_lost REAL,
    -- efficiency
    passing_epa REAL, rushing_epa REAL, receiving_epa REAL,
    cpoe REAL, racr REAL, pacr REAL,
    first_downs REAL,
    PRIMARY KEY (player_id, season, week)
  );
  CREATE INDEX IF NOT EXISTS idx_pwu_season_week ON player_week_usage(season, week);
  CREATE INDEX IF NOT EXISTS idx_pwu_player ON player_week_usage(player_id, season);

  CREATE TABLE IF NOT EXISTS player_week_snaps (
    player_id INTEGER NOT NULL REFERENCES players(id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    offense_snaps REAL, offense_pct REAL,
    PRIMARY KEY (player_id, season, week)
  );

  -- gsis_id -> position, sourced straight from nflverse's players.csv. This is
  -- comprehensive (every player who has ever appeared in a play), unlike our
  -- own players table which only carries the current ~800-player roster
  -- universe. nfl_player_week_features keys on gsis_id, so this is what makes
  -- backfilling its position column (and future ingests) possible.
  CREATE TABLE IF NOT EXISTS nflverse_player_positions (
    gsis_id TEXT PRIMARY KEY,
    position TEXT,
    position_group TEXT,
    ngs_position TEXT
  );
`);

const playerCols = db.prepare(`PRAGMA table_info(players)`).all().map(c => c.name);
if (!playerCols.includes('gsis_id')) db.exec(`ALTER TABLE players ADD COLUMN gsis_id TEXT`);

/* --------------------------------------------------------------- CSV parsing */

/**
 * Minimal RFC-4180 parser. nflverse quotes fields containing commas (headshot URLs
 * have them), so splitting on ',' silently shifts every column after the first URL.
 */
export function parseCsv(text) {
  const out = [];
  let field = '', record = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); out.push(record); record = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || record.length) { record.push(field); out.push(record); }
  if (!out.length) return { header: [], records: [] };
  const header = out[0];
  return { header, records: out.slice(1).filter(r => r.length === header.length) };
}

/** Column-name -> index lookup, so a schema change reorders nothing silently. */
const indexer = header => {
  const map = new Map(header.map((h, i) => [h, i]));
  return name => map.get(name) ?? -1;
};
const numAt = (rec, i) => {
  if (i < 0) return null;
  const v = rec[i];
  if (v === '' || v == null || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`${url.split('/').pop()} -> HTTP ${res.status}`);
  return parseCsv(await res.text());
}

/* ------------------------------------------------------------- id crosswalk */

/**
 * Stamp nflverse's gsis_id onto our players via espn_id. Everything downstream
 * joins on gsis_id, so this has to run before any weekly sync.
 */
export async function syncCrosswalk() {
  const { header, records } = await fetchCsv(`${RELEASE}/players/players.csv`);
  const at = indexer(header);
  const iGsis = at('gsis_id'), iEspn = at('espn_id'), iName = at('display_name'), iPos = at('position');
  const iPosGroup = at('position_group'), iNgs = at('ngs_position');
  if (iGsis < 0 || iEspn < 0) throw new Error('players.csv is missing gsis_id/espn_id');

  const byEspn = new Map(rows('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL')
    .map(p => [String(p.espn_id), p.id]));
  // Name fallback for the handful of players with no espn_id on our side — shares
  // player-identity.js's matcher so a name collision refuses to guess instead of
  // silently rebinding the wrong human (the same bug that split Ja'Marr Chase's
  // picks across two rows in the ESPN sync, before that file existed).
  const noEspnCandidates = rows('SELECT id, name, position, team_id, espn_id FROM players WHERE espn_id IS NULL');
  const byNormName = new Map();
  for (const c of noEspnCandidates) {
    const key = normalizePlayerName(c.name);
    if (!byNormName.has(key)) byNormName.set(key, []);
    byNormName.get(key).push(c);
  }

  // nflverse's defensive position codes are finer than ours (DE/DT vs our DL,
  // FS/SS vs our S) and its position_group doesn't line up either — Myles
  // Garrett is our EDGE but nflverse's position_group lumps him under DL — so
  // an exact-position match misses IDP-relevant defenders entirely. This is a
  // second-chance pass: same name, any of our coarser code's plausible
  // nflverse equivalents.
  const DEFENSIVE_POSITION_COMPAT = {
    DL: new Set(['DL', 'DE', 'DT', 'NT']),
    // nflverse doesn't distinguish edge rushers from off-ball linebackers at
    // all — Micah Parsons, Brian Burns, Trey Hendrickson all come back as
    // plain LB/LB — so EDGE has to accept LB too.
    EDGE: new Set(['DL', 'DE', 'OLB', 'EDGE', 'LB']),
    LB: new Set(['LB', 'ILB', 'OLB', 'MLB']),
    S: new Set(['DB', 'FS', 'SS', 'S']),
    CB: new Set(['DB', 'CB'])
  };
  const isCompatiblePosition = (ourPos, nflPos, nflPosGroup) => {
    const allowed = DEFENSIVE_POSITION_COMPAT[ourPos];
    return !!allowed && (allowed.has(nflPos) || allowed.has(nflPosGroup));
  };

  const up = db.prepare('UPDATE players SET gsis_id = ? WHERE id = ?');
  const upPos = db.prepare(`INSERT INTO nflverse_player_positions (gsis_id, position, position_group, ngs_position)
    VALUES (?,?,?,?)
    ON CONFLICT(gsis_id) DO UPDATE SET position=excluded.position,
      position_group=excluded.position_group, ngs_position=excluded.ngs_position`);
  let matched = 0, ambiguous = 0;
  db.exec('BEGIN');
  try {
    for (const rec of records) {
      const gsis = rec[iGsis];
      if (!gsis) continue;
      // Every player who has ever appeared in nflverse gets a position row —
      // this is the comprehensive lookup nfl_player_week_features backfills from.
      upPos.run(gsis, rec[iPos] || null, iPosGroup < 0 ? null : (rec[iPosGroup] || null),
        iNgs < 0 ? null : (rec[iNgs] || null));
      let id = byEspn.get(String(rec[iEspn]));
      if (!id) {
        const found = findPlayerMatch(noEspnCandidates,
          { espn_id: null, name: rec[iName], position: rec[iPos], team_id: null });
        if (found.ambiguous) { ambiguous++; continue; }
        id = found.match?.id;
      }
      if (!id) {
        const nameMatches = byNormName.get(normalizePlayerName(rec[iName])) ?? [];
        const compatible = nameMatches.filter(c => isCompatiblePosition(c.position, rec[iPos], rec[iPosGroup]));
        if (compatible.length === 1) id = compatible[0].id;
        else if (compatible.length > 1) { ambiguous++; continue; }
      }
      if (!id) continue;
      up.run(gsis, id);
      matched++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const positions = backfillPlayerWeekPositions();
  return { nflverse_players: records.length, matched, ambiguous, positions };
}

/**
 * Fills in nfl_player_week_features.position for rows nfl-pbp.js left NULL —
 * it only ever set 'QB' (via passer_player_id) and never looked up rushers or
 * receivers. Safe to rerun: only touches rows that are still missing a position.
 */
export function backfillPlayerWeekPositions() {
  const before = row(`SELECT COUNT(*) AS n FROM nfl_player_week_features WHERE position IS NULL OR position = ''`)?.n ?? 0;
  db.prepare(`UPDATE nfl_player_week_features
    SET position = (SELECT position FROM nflverse_player_positions WHERE gsis_id = nfl_player_week_features.player_id)
    WHERE (position IS NULL OR position = '')
      AND EXISTS (SELECT 1 FROM nflverse_player_positions np
                  WHERE np.gsis_id = nfl_player_week_features.player_id AND np.position IS NOT NULL AND np.position != '')`).run();
  const after = row(`SELECT COUNT(*) AS n FROM nfl_player_week_features WHERE position IS NULL OR position = ''`)?.n ?? 0;
  return { before_null: before, after_null: after, filled: before - after };
}

/* ---------------------------------------------------------- weekly usage */

const USAGE_COLS = [
  ['attempts', 'attempts'], ['carries', 'carries'], ['targets', 'targets'], ['receptions', 'receptions'],
  ['target_share', 'target_share'], ['air_yards_share', 'air_yards_share'], ['wopr', 'wopr'],
  ['receiving_air_yards', 'receiving_air_yards'], ['passing_air_yards', 'passing_air_yards'],
  ['passing_yards', 'passing_yards'], ['rushing_yards', 'rushing_yards'], ['receiving_yards', 'receiving_yards'],
  ['passing_tds', 'passing_tds'], ['rushing_tds', 'rushing_tds'], ['receiving_tds', 'receiving_tds'],
  ['interceptions', 'passing_interceptions'],
  ['passing_epa', 'passing_epa'], ['rushing_epa', 'rushing_epa'], ['receiving_epa', 'receiving_epa'],
  ['cpoe', 'passing_cpoe'], ['racr', 'racr'], ['pacr', 'pacr']
];

/** One season of weekly player lines. Regular season only — playoff usage is a different game. */
export async function syncWeeklyUsage(season) {
  const { header, records } = await fetchCsv(`${RELEASE}/stats_player/stats_player_week_${season}.csv`);
  const at = indexer(header);
  const iGsis = at('player_id'), iSeason = at('season'), iWeek = at('week'), iType = at('season_type');
  const iTeam = at('team'), iOpp = at('opponent_team'), iPos = at('position');
  const iFumbles = at('rushing_fumbles_lost'), iRecFum = at('receiving_fumbles_lost'), iSackFum = at('sack_fumbles_lost');
  const iPassFd = at('passing_first_downs'), iRushFd = at('rushing_first_downs'), iRecFd = at('receiving_first_downs');

  const byGsis = new Map(rows('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL')
    .map(p => [p.gsis_id, p.id]));
  if (!byGsis.size) throw new Error('no gsis_id set on any player — run the crosswalk sync first');

  const cols = USAGE_COLS.map(([dbCol]) => dbCol);
  const idx = USAGE_COLS.map(([, csvCol]) => at(csvCol));
  const stmt = db.prepare(
    `INSERT INTO player_week_usage
       (player_id, season, week, team, opponent, position, fumbles_lost, first_downs, ${cols.join(', ')})
     VALUES (${new Array(8 + cols.length).fill('?').join(',')})
     ON CONFLICT(player_id, season, week) DO UPDATE SET
       team=excluded.team, opponent=excluded.opponent, position=excluded.position,
       fumbles_lost=excluded.fumbles_lost, first_downs=excluded.first_downs,
       ${cols.map(c => `${c}=excluded.${c}`).join(', ')}`);

  let inserted = 0, unmatched = 0;
  db.exec('BEGIN');
  try {
    for (const rec of records) {
      if (rec[iType] !== 'REG') continue;
      const pid = byGsis.get(rec[iGsis]);
      if (!pid) { unmatched++; continue; }
      const fumbles = (numAt(rec, iFumbles) ?? 0) + (numAt(rec, iRecFum) ?? 0) + (numAt(rec, iSackFum) ?? 0);
      const firstDowns = (numAt(rec, iPassFd) ?? 0) + (numAt(rec, iRushFd) ?? 0) + (numAt(rec, iRecFd) ?? 0);
      stmt.run(pid, numAt(rec, iSeason), numAt(rec, iWeek), rec[iTeam] || null, rec[iOpp] || null,
        rec[iPos] || null, fumbles, firstDowns, ...idx.map(i => numAt(rec, i)));
      inserted++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { season, rows: records.length, inserted, unmatched };
}

/** Snap share — the earliest signal that a committee is breaking one way. */
export async function syncSnapCounts(season) {
  const { header, records } = await fetchCsv(`${RELEASE}/snap_counts/snap_counts_${season}.csv`);
  const at = indexer(header);
  const iPfr = at('pfr_player_id'), iName = at('player'), iPos = at('position');
  const iWeek = at('week'), iSeason = at('season'), iType = at('game_type');
  const iSnaps = at('offense_snaps'), iPct = at('offense_pct');

  // snap_counts keys on pfr_player_id, which we do not carry; fall back to name+position.
  const norm = s => (s ?? '').toLowerCase().replace(/[.'’-]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const byName = new Map(rows('SELECT id, name, position FROM players')
    .map(p => [`${norm(p.name)}|${p.position}`, p.id]));

  const stmt = db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
    VALUES (?,?,?,?,?) ON CONFLICT(player_id, season, week) DO UPDATE SET
      offense_snaps=excluded.offense_snaps, offense_pct=excluded.offense_pct`);

  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const rec of records) {
      if (iType >= 0 && rec[iType] !== 'REG') continue;
      const pid = byName.get(`${norm(rec[iName])}|${rec[iPos]}`);
      if (!pid) continue;
      stmt.run(pid, numAt(rec, iSeason), numAt(rec, iWeek), numAt(rec, iSnaps), numAt(rec, iPct));
      inserted++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { season, inserted };
}

/** Everything, in dependency order. */
export async function syncAll(seasons) {
  const result = { crosswalk: null, usage: [], snaps: [] };
  try {
    result.crosswalk = await syncCrosswalk();
    recordSync('nflverse_crosswalk', 'ok', result.crosswalk);
  } catch (e) { recordSync('nflverse_crosswalk', 'error', e.message); throw e; }
  for (const s of seasons) {
    const usage = await syncWeeklyUsage(s).catch(e => ({ season: s, error: e.message }));
    result.usage.push(usage);
    recordSync('nflverse_weekly_usage', usage.error ? 'error' : 'ok', usage);
    const snaps = await syncSnapCounts(s).catch(e => ({ season: s, error: e.message }));
    result.snaps.push(snaps);
    recordSync('nflverse_snap_counts', snaps.error ? 'error' : 'ok', snaps);
  }
  return result;
}

/* ------------------------------------------------------------------ reads */

/** Weekly usage for one player, newest first. */
export function usageFor(playerId, seasons = null) {
  const clause = seasons?.length ? `AND season IN (${seasons.map(() => '?').join(',')})` : '';
  return rows(`SELECT * FROM player_week_usage WHERE player_id = ? ${clause}
               ORDER BY season DESC, week DESC`, playerId, ...(seasons ?? []));
}

/** Seasons we actually hold usage for. */
export function usageSeasons() {
  return rows('SELECT season, COUNT(*) AS rows, COUNT(DISTINCT player_id) AS players FROM player_week_usage GROUP BY season ORDER BY season');
}
