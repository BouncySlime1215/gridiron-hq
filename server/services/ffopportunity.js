/**
 * ffopportunity expected-fantasy-points benchmark.
 *
 * Upstream publishes weekly CSVs as GitHub release assets. The values describe
 * the opportunity a player actually received in a completed week, so they are
 * never legal as a same-week pregame feature. We store them by season/week and
 * expose only strictly-prior rolling summaries to the shared player engine.
 *
 * Data license: CC BY 4.0 (ffverse/ffopportunity data). Package code is GPL-3;
 * no package code is copied or executed here.
 */
import { db, rows } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { recordSync } from './scheduler.js';

const RELEASE = 'https://github.com/ffverse/ffopportunity/releases/download/latest-data';
export const FFOPPORTUNITY_SOURCE = Object.freeze({
  repo: 'ffverse/ffopportunity',
  release: 'latest-data',
  pinned_code_commit: '74dcb35a112a71e5349b36abe940316067ec4fec',
  data_license: 'CC BY 4.0',
  code_copied: false
});

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_ffopportunity_weekly (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_gsis_id TEXT NOT NULL,
    player_name TEXT,
    team TEXT,
    position TEXT,
    expected_fantasy_points REAL,
    actual_fantasy_points REAL,
    expected_pass_points REAL,
    expected_receive_points REAL,
    expected_rush_points REAL,
    expected_total_yards REAL,
    expected_touchdowns REAL,
    source_release TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (season,week,player_gsis_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ffopp_player_cutoff
    ON nfl_ffopportunity_weekly(player_gsis_id,season,week);
`);

const number = value => {
  if (value == null || value === '' || value === 'NA') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function seasonCsv(season) {
  const url = `${RELEASE}/ep_weekly_${season}.csv`;
  const response = await fetch(url, {
    headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(180000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ffopportunity ${season} -> HTTP ${response.status}`);
  return parseCsv(await response.text());
}

export async function syncFfOpportunity(seasons = [2022, 2023, 2024, 2025]) {
  const wanted = [...new Set(seasons.map(Number).filter(Number.isInteger))].sort();
  const upsert = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season,week,player_gsis_id,player_name,team,position,
     expected_fantasy_points,actual_fantasy_points,expected_pass_points,
     expected_receive_points,expected_rush_points,expected_total_yards,
     expected_touchdowns,source_release,ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season,week,player_gsis_id) DO UPDATE SET
      player_name=excluded.player_name,team=excluded.team,position=excluded.position,
      expected_fantasy_points=excluded.expected_fantasy_points,
      actual_fantasy_points=excluded.actual_fantasy_points,
      expected_pass_points=excluded.expected_pass_points,
      expected_receive_points=excluded.expected_receive_points,
      expected_rush_points=excluded.expected_rush_points,
      expected_total_yards=excluded.expected_total_yards,
      expected_touchdowns=excluded.expected_touchdowns,
      source_release=excluded.source_release,ingested_at=excluded.ingested_at`);
  const details = [];
  for (const season of wanted) {
    const csv = await seasonCsv(season);
    if (!csv) { details.push({ season, status: 'not_published' }); continue; }
    const index = new Map(csv.header.map((name, i) => [name, i]));
    const at = (record, name) => record[index.get(name) ?? -1];
    const ingestedAt = new Date().toISOString();
    let inserted = 0;
    db.exec('BEGIN');
    try {
      for (const record of csv.records) {
        const playerId = at(record, 'player_id');
        const week = number(at(record, 'week'));
        if (!playerId || !Number.isInteger(week)) continue;
        upsert.run(season, week, playerId, at(record, 'full_name') || null,
          at(record, 'posteam') || null, at(record, 'position') || null,
          number(at(record, 'total_fantasy_points_exp')),
          number(at(record, 'total_fantasy_points')),
          number(at(record, 'pass_fantasy_points_exp')),
          number(at(record, 'rec_fantasy_points_exp')),
          number(at(record, 'rush_fantasy_points_exp')),
          number(at(record, 'total_yards_gained_exp')),
          number(at(record, 'total_touchdown_exp')),
          FFOPPORTUNITY_SOURCE.release, ingestedAt);
        inserted++;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    details.push({ season, status: 'ok', rows: inserted });
  }
  const result = { source: FFOPPORTUNITY_SOURCE, seasons: details,
    rows: details.reduce((sum, item) => sum + (item.rows ?? 0), 0) };
  recordSync('nfl_ffopportunity', 'ok', result);
  return result;
}

/** Strictly-prior opportunity summary. Never includes the requested week. */
export function priorFfOpportunity(playerGsisId, season, week, lookback = 6) {
  if (!playerGsisId || !Number.isInteger(season) || !Number.isInteger(week)) return null;
  const history = rows(`SELECT season,week,expected_fantasy_points,actual_fantasy_points,
      expected_pass_points,expected_receive_points,expected_rush_points
    FROM nfl_ffopportunity_weekly
    WHERE player_gsis_id = ?
      AND (season < ? OR (season = ? AND week < ?))
    ORDER BY season DESC,week DESC LIMIT ?`, playerGsisId, season, season, week, lookback);
  if (!history.length) return null;
  const average = key => {
    const values = history.map(row => row[key]).filter(Number.isFinite);
    return values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3) : null;
  };
  return {
    games: history.length,
    through: `${history[0].season}-W${history[0].week}`,
    expected_fantasy_points: average('expected_fantasy_points'),
    actual_fantasy_points: average('actual_fantasy_points'),
    expected_pass_points: average('expected_pass_points'),
    expected_receive_points: average('expected_receive_points'),
    expected_rush_points: average('expected_rush_points'),
    authority: 0,
    status: 'external_shadow_benchmark',
    note: 'Strictly-prior expected opportunity from ffopportunity; displayed and audited, not blended into the forecast.'
  };
}

export function ffOpportunityStatus() {
  const summary = rows(`SELECT COUNT(*) rows,COUNT(DISTINCT season) seasons,
      MIN(season) min_season,MAX(season) max_season,MAX(ingested_at) last_ingested_at
    FROM nfl_ffopportunity_weekly`)[0];
  return { ...summary, source: FFOPPORTUNITY_SOURCE,
    status: (summary?.rows ?? 0) > 0 ? 'connected_shadow_benchmark' : 'not_ingested' };
}
