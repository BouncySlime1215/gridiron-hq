/**
 * Every other free nflverse feed, folded into the player picture.
 *
 * Play-by-play describes what happened on each snap, but it cannot see how open
 * a receiver was, how fast the ball came out, whether a run was blocked well, or
 * how often a lineman let pressure through. Those live in separate public feeds:
 *
 *   Next Gen Stats  — tracking-chip data: time to throw, separation, cushion,
 *                     YAC over expected, rush yards over expected.
 *   PFR advanced    — charted data: pressures, blitzes, hurries, broken tackles,
 *                     drops, missed tackles, coverage results.
 *   Snap counts     — the denominator everything else needs to become a rate.
 *   Depth charts    — positional rank, which is what actually makes a player
 *                     "RB1" and what moves during a season.
 *   Injuries        — practice participation and game status.
 *
 * All are free, keyless and small (largest is ~10MB gzipped), so each is fetched
 * whole and parsed incrementally rather than streamed with an accumulator.
 */
import { canonicalTeamCode, LEGACY_CODE_PAIRS } from './team-codes.js';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { db, rows, run } from '../db/index.js';
import { recordSync } from './scheduler.js';

const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
export const depthChartReleaseUrl = season => `${REL}/depth_charts/depth_charts_${season}.csv`;

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_ngs (
    season INTEGER, week INTEGER, player_id TEXT, kind TEXT,
    player_name TEXT, team TEXT, position TEXT, stats TEXT,
    PRIMARY KEY (season, week, player_id, kind)
  );
  CREATE TABLE IF NOT EXISTS nfl_pfr_adv (
    season INTEGER, week INTEGER, player_name TEXT, kind TEXT,
    team TEXT, opponent TEXT, stats TEXT,
    PRIMARY KEY (season, week, player_name, kind)
  );
  CREATE TABLE IF NOT EXISTS nfl_snaps (
    season INTEGER, week INTEGER, player TEXT, team TEXT, position TEXT,
    offense_snaps INTEGER, offense_pct REAL,
    defense_snaps INTEGER, defense_pct REAL, st_pct REAL,
    PRIMARY KEY (season, week, player, team)
  );
  CREATE INDEX IF NOT EXISTS idx_snaps_team ON nfl_snaps(season, week, team);
  CREATE TABLE IF NOT EXISTS nfl_depth (
    season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, player_name TEXT,
    pos_abb TEXT, pos_rank INTEGER, pos_slot TEXT, captured TEXT,
    PRIMARY KEY (season, week, team, gsis_id, pos_abb)
  );
  CREATE INDEX IF NOT EXISTS idx_depth_player ON nfl_depth(gsis_id, season, week);
  CREATE TABLE IF NOT EXISTS nfl_injuries (
    season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
    position TEXT, report_status TEXT, practice_status TEXT, injury TEXT,
    modified_at TEXT,
    PRIMARY KEY (season, week, gsis_id)
  );
`);

// Older databases captured only offensive participation. nflverse publishes
// both sides of the ball; without these columns a CB1 and a reserve corner both
// fell back to the same guessed 15% role in the injury model.
const snapColumns = new Set(db.prepare('PRAGMA table_info(nfl_snaps)').all().map(x => x.name));
if (!snapColumns.has('defense_snaps')) db.exec('ALTER TABLE nfl_snaps ADD COLUMN defense_snaps INTEGER');
if (!snapColumns.has('defense_pct')) db.exec('ALTER TABLE nfl_snaps ADD COLUMN defense_pct REAL');
const injuryColumns = new Set(db.prepare('PRAGMA table_info(nfl_injuries)').all().map(x => x.name));
if (!injuryColumns.has('modified_at')) db.exec('ALTER TABLE nfl_injuries ADD COLUMN modified_at TEXT');

/* ------------------------------------------------------------ csv plumbing */

/** Same incremental parser used for play-by-play — quoted fields, chunk-safe. */
function streamer(onRecord) {
  let field = '', record = [], inQuotes = false, prevQuote = false;
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inQuotes) {
          if (prevQuote) {
            prevQuote = false;
            if (c === '"') { field += '"'; continue; }
            inQuotes = false;
          } else if (c === '"') { prevQuote = true; continue; }
          else { field += c; continue; }
        }
        if (c === '"') { inQuotes = true; continue; }
        if (c === ',') { record.push(field); field = ''; continue; }
        if (c === '\n') { record.push(field); field = ''; onRecord(record); record = []; continue; }
        if (c === '\r') continue;
        field += c;
      }
    },
    end() { if (field.length || record.length) { record.push(field); onRecord(record); } }
  };
}

/** Fetches an nflverse CSV (plain or gzipped) and calls `onRow` with a row object. */
async function eachRow(url, onRow) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  let header = null;
  const s = streamer(rec => {
    if (!header) { header = rec; return; }
    if (rec.length < 2) return;
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = rec[i] ?? '';
    onRow(o);
  });
  const body = Readable.fromWeb(res.body);
  const src = url.endsWith('.gz') ? body.pipe(createGunzip()) : body;
  src.setEncoding('utf8');
  for await (const chunk of src) s.push(chunk);
  s.end();
}

const n = v => { if (v === '' || v == null || v === 'NA') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, n(o[k])]).filter(([, v]) => v != null));
/** The shared team-code map (team-codes.js); kept under its old name for existing callers. */
export const normalizeDepthTeam = value => (value == null || value === '' ? value : canonicalTeamCode(value));

/* ------------------------------------------------------------ Next Gen Stats */

const NGS_FIELDS = {
  passing: ['avg_time_to_throw', 'avg_completed_air_yards', 'avg_intended_air_yards',
    'avg_air_yards_differential', 'aggressiveness', 'avg_air_yards_to_sticks',
    'expected_completion_percentage', 'completion_percentage_above_expectation', 'avg_air_distance'],
  receiving: ['avg_cushion', 'avg_separation', 'avg_intended_air_yards',
    'percent_share_of_intended_air_yards', 'catch_percentage', 'avg_yac',
    'avg_expected_yac', 'avg_yac_above_expectation'],
  rushing: ['efficiency', 'percent_attempts_gte_eight_defenders', 'avg_time_to_los',
    'expected_rush_yards', 'rush_yards_over_expected', 'rush_yards_over_expected_per_att',
    'rush_pct_over_expected']
};

export async function syncNgs(seasons) {
  const want = new Set(seasons);
  const stmt = db.prepare(`INSERT INTO nfl_ngs (season, week, player_id, kind, player_name, team, position, stats)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, player_id, kind) DO UPDATE SET stats=excluded.stats,
      team=excluded.team, position=excluded.position`);
  let total = 0;
  for (const kind of ['passing', 'receiving', 'rushing']) {
    const batch = [];
    await eachRow(`${REL}/nextgen_stats/ngs_${kind}.csv.gz`, r => {
      const season = n(r.season), week = n(r.week);
      // Week 0 rows are season aggregates; the weekly model wants real weeks.
      if (!want.has(season) || !week || r.season_type !== 'REG') return;
      if (!r.player_gsis_id) return;
      batch.push([season, week, r.player_gsis_id, kind, r.player_display_name,
        normalizeDepthTeam(r.team_abbr), r.player_position, JSON.stringify(pick(r, NGS_FIELDS[kind]))]);
    });
    db.exec('BEGIN');
    try { for (const b of batch) stmt.run(...b); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    total += batch.length;
  }
  return { rows: total };
}

/* --------------------------------------------------------------- PFR charted */

const PFR_FIELDS = {
  pass: ['passing_drops', 'passing_drop_pct', 'passing_bad_throws', 'passing_bad_throw_pct',
    'times_sacked', 'times_blitzed', 'times_hurried', 'times_hit', 'times_pressured', 'times_pressured_pct'],
  rec: ['rushing_broken_tackles', 'receiving_broken_tackles', 'receiving_drop',
    'receiving_drop_pct', 'receiving_int', 'receiving_rat'],
  def: ['def_ints', 'def_targets', 'def_completions_allowed', 'def_completion_pct',
    'def_yards_allowed', 'def_yards_allowed_per_tgt', 'def_receiving_td_allowed',
    'def_passer_rating_allowed', 'def_adot', 'def_times_blitzed', 'def_times_hurried',
    'def_sacks', 'def_pressures', 'def_tackles_combined', 'def_missed_tackles']
};

export async function syncPfrAdv(seasons) {
  const stmt = db.prepare(`INSERT INTO nfl_pfr_adv (season, week, player_name, kind, team, opponent, stats)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(season, week, player_name, kind) DO UPDATE SET stats=excluded.stats, team=excluded.team`);
  let total = 0;
  const failures = [];
  for (const season of seasons) {
    for (const kind of ['pass', 'rec', 'def']) {
      const batch = [];
      try {
        await eachRow(`${REL}/pfr_advstats/advstats_week_${kind}_${season}.csv.gz`, r => {
          if (r.game_type && r.game_type !== 'REG') return;
          const week = n(r.week);
          if (!week || !r.pfr_player_name) return;
          batch.push([season, week, r.pfr_player_name, kind, normalizeDepthTeam(r.team),
            normalizeDepthTeam(r.opponent),
            JSON.stringify(pick(r, PFR_FIELDS[kind]))]);
        });
      } catch (error) {
        failures.push({ season, kind,
          source: `${REL}/pfr_advstats/advstats_week_${kind}_${season}.csv.gz`,
          error: error.message });
        continue;
      }
      db.exec('BEGIN');
      try { for (const b of batch) stmt.run(...b); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      total += batch.length;
    }
  }
  return { rows: total, failures, complete: failures.length === 0,
    known_coverage: 'The nflverse weekly PFR advanced release begins in 2024; earlier 404s are source absence, not empty football data.' };
}

/* ------------------------------------------------------------- snap counts */

export async function syncSnaps(seasons) {
  const stmt = db.prepare(`INSERT INTO nfl_snaps
      (season, week, player, team, position, offense_snaps, offense_pct,defense_snaps,defense_pct,st_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, player, team) DO UPDATE SET
      offense_snaps=excluded.offense_snaps, offense_pct=excluded.offense_pct,
      defense_snaps=excluded.defense_snaps, defense_pct=excluded.defense_pct,
      st_pct=excluded.st_pct`);
  let total = 0;
  const failures = [];
  for (const season of seasons) {
    const batch = [];
    try {
      await eachRow(`${REL}/snap_counts/snap_counts_${season}.csv.gz`, r => {
        if (r.game_type && r.game_type !== 'REG') return;
        const week = n(r.week);
        if (!week || !r.player) return;
        batch.push([season, week, r.player, normalizeDepthTeam(r.team), r.position,
          n(r.offense_snaps), n(r.offense_pct), n(r.defense_snaps), n(r.defense_pct), n(r.st_pct)]);
      });
    } catch (error) {
      failures.push({ season, source: `${REL}/snap_counts/snap_counts_${season}.csv.gz`,
        error: error.message });
      continue;
    }
    db.exec('BEGIN');
    try { for (const b of batch) stmt.run(...b); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    total += batch.length;
  }
  return { rows: total, failures, complete: failures.length === 0,
    policy: 'A source failure remains visible and is never converted into zero participation.' };
}

/* ------------------------------------------------------------ depth charts */

/**
 * Depth charts publish as dated snapshots, several per week. Only the latest
 * snapshot before each game matters, so rows are collapsed to one per
 * team/player/position/week, keeping the most recent capture.
 */
export async function syncDepthCharts(seasons) {
  const stmt = db.prepare(`INSERT INTO nfl_depth
      (season, week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot, captured)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, team, gsis_id, pos_abb) DO UPDATE SET
      pos_rank=excluded.pos_rank, pos_slot=excluded.pos_slot,
      player_name=excluded.player_name, captured=excluded.captured
    WHERE excluded.captured >= nfl_depth.captured`);
  let total = 0;
  const failures = [];
  for (const season of seasons) {
    const latest = new Map();
    try {
      // Depth charts through 2024 are true week-level archives. From 2025 the
      // publisher switched to timestamped live snapshots, so support both
      // schemas explicitly instead of silently dropping the historical rows.
      await eachRow(depthChartReleaseUrl(season), r => {
        const team = normalizeDepthTeam(r.team || r.club_code);
        const week = n(r.week) || (r.dt ? weekFromDate(season, r.dt) : null);
        if (!r.gsis_id || !team || !week) return;
        const captured = r.dt || historicalWeekAvailability(season, week, team);
        if (!captured) return;
        const position = r.pos_abb || r.position || r.depth_position;
        const rank = n(r.pos_rank) ?? n(r.depth_team);
        const slot = r.pos_slot || r.depth_position || position;
        const name = r.player_name || r.full_name
          || [r.first_name, r.last_name].filter(Boolean).join(' ');
        if (!position || !name) return;
        const key = [week, team, r.gsis_id, position].join('|');
        const prev = latest.get(key);
        if (!prev || captured > prev.dt) {
          latest.set(key, { dt: captured, week, team, gsis_id: r.gsis_id,
            name, pos: position, rank, slot });
        }
      });
    } catch (error) {
      failures.push({ season, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    db.exec('BEGIN');
    try {
      for (const v of latest.values()) {
        stmt.run(season, v.week, v.team, v.gsis_id, v.name, v.pos, v.rank, v.slot, v.dt);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    total += latest.size;
  }
  if (failures.length === seasons.length) {
    throw new Error(`Every depth-chart season failed: ${failures.map(x => `${x.season}: ${x.error}`).join('; ')}`);
  }
  return { rows: total, seasons_requested: seasons.length,
    seasons_loaded: seasons.length - failures.length, failures };
}

const _historicalAvailability = new Map();
function historicalWeekAvailability(season, week, team) {
  const key = `${season}|${week}|${team}`;
  if (_historicalAvailability.has(key)) return _historicalAvailability.get(key);
  const game = rows(`SELECT gameday FROM game_lines
    WHERE season=? AND week=? AND team=? AND gameday IS NOT NULL LIMIT 1`, season, week, team)[0];
  // The old release provides a week, not a publication timestamp. Midnight on
  // the team's game day is a conservative availability boundary: it admits the
  // stated pregame chart but never a later week's chart into an earlier game.
  const value = game?.gameday ? `${game.gameday}T00:00:00Z` : null;
  _historicalAvailability.set(key, value);
  return value;
}

/**
 * Maps a snapshot date onto an NFL week using the real schedule already stored,
 * rather than assuming a fixed season start. A snapshot belongs to the week of
 * the next game that has not yet kicked off.
 */
const _weekCache = new Map();
function weekFromDate(season, dt) {
  if (!_weekCache.has(season)) {
    const days = rows(`SELECT DISTINCT week, MIN(gameday) AS d FROM game_lines
                       WHERE season = ? AND gameday IS NOT NULL GROUP BY week ORDER BY week`, season);
    _weekCache.set(season, days);
  }
  const days = _weekCache.get(season);
  if (!days?.length) return null;
  const date = String(dt).slice(0, 10);
  let best = null;
  for (const d of days) if (d.d && date <= d.d) { best = d.week; break; }
  return best ?? days[days.length - 1].week;
}

/* ---------------------------------------------------------------- injuries */

export async function syncInjuries(seasons) {
  const stmt = db.prepare(`INSERT INTO nfl_injuries
      (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury,modified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, gsis_id) DO UPDATE SET
      report_status=excluded.report_status, practice_status=excluded.practice_status,
      injury=excluded.injury,modified_at=excluded.modified_at`);
  let total = 0;
  const failures = [];
  for (const season of seasons) {
    const batch = [];
    try {
      await eachRow(`${REL}/injuries/injuries_${season}.csv`, r => {
        const week = n(r.week);
        if (!week || !r.gsis_id) return;
        const seasonType = r.game_type || r.season_type;
        if (seasonType && seasonType !== 'REG') return;
        batch.push([season, week, r.gsis_id, normalizeDepthTeam(r.team), r.full_name, r.position,
          r.report_status || null, r.practice_status || null,
          r.report_primary_injury || r.practice_primary_injury || null,
          r.date_modified || null]);
      });
    } catch (error) {
      failures.push({ season, source: `${REL}/injuries/injuries_${season}.csv`, error: error.message });
      continue;
    }
    db.exec('BEGIN');
    try { for (const b of batch) stmt.run(...b); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    total += batch.length;
  }
  return { rows: total, requested_seasons: seasons, failures,
    complete: failures.length === 0,
    policy: 'A failed source is reported explicitly and is never interpreted as an empty injury week.' };
}

/** Repair legacy source abbreviations before any immutable weekly state is frozen. */
export function reconcileHistoricalTeamCodes() {
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(item => item.name));
  const targets = [
    ['nfl_team_week_features', ['team', 'opponent']],
    ['nfl_player_week_features', ['team', 'opponent']],
    ['player_week_usage', ['team', 'opponent']],
    ['nfl_ngs', ['team']], ['nfl_pfr_adv', ['team', 'opponent']],
    ['nfl_snaps', ['team']], ['nfl_injuries', ['team']],
    ['nfl_play_formations', ['possession']],
    // Relocated franchises keep their identity in the ratings walk: OAK games
    // are Raiders games. game_lines carried OAK/SD/STL while every feature
    // table had already been reconciled, so the two split at the join.
    ['game_lines', ['team', 'opponent']]
  ];
  const aliases = LEGACY_CODE_PAIRS;
  const changes = [];
  db.exec('BEGIN');
  try {
    for (const [table, columns] of targets) {
      if (!tables.has(table)) continue;
      const available = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name));
      for (const column of columns.filter(item => available.has(item))) for (const [from, to] of aliases) {
        const result = run(`UPDATE OR IGNORE ${table} SET ${column}=? WHERE ${column}=?`, to, from);
        if (Number(result.changes ?? 0)) changes.push({ table, column, from, to, rows: Number(result.changes) });
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { changes, rows_changed: changes.reduce((sum, item) => sum + item.rows, 0),
    canonical: { LA: 'LAR', JAC: 'JAX', OAK: 'LV', SD: 'LAC', STL: 'LAR' } };
}

/* ------------------------------------------------------------------- roles */

const ROLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * A player's role for a given week — "RB1", "WR2" and so on.
 *
 * The published depth chart is the stated role, but snap share is the revealed
 * one, and they disagree often enough to matter. Both are returned: `role` uses
 * the depth chart, `snap_role` ranks the same position group by snaps actually
 * played, and `role_matches_usage` flags when a listed starter is not being
 * used like one.
 */
export function rolesFor(season, week, team) {
  const depth = rows(`SELECT * FROM nfl_depth
                      WHERE season=? AND week=? AND team=? AND pos_abb IN ('QB','RB','WR','TE')
                      ORDER BY pos_abb, pos_rank`, season, week, team);
  const snaps = rows(`SELECT * FROM nfl_snaps
                      WHERE season=? AND week=? AND team=? AND offense_pct IS NOT NULL
                      ORDER BY offense_pct DESC`, season, week, team);

  const snapRank = new Map();
  const byPos = {};
  for (const s of snaps) {
    if (!ROLE_POSITIONS.has(s.position)) continue;
    byPos[s.position] = byPos[s.position] ?? [];
    byPos[s.position].push(s);
  }
  for (const [pos, list] of Object.entries(byPos)) {
    list.forEach((s, i) => snapRank.set(normalize(s.player), { rank: i + 1, pct: s.offense_pct, pos }));
  }

  return depth.map(d => {
    const sr = snapRank.get(normalize(d.player_name));
    return {
      player: d.player_name, gsis_id: d.gsis_id, position: d.pos_abb,
      depth_rank: d.pos_rank,
      role: d.pos_rank ? `${d.pos_abb}${d.pos_rank}` : d.pos_abb,
      snap_rank: sr?.rank ?? null,
      snap_role: sr ? `${sr.pos}${sr.rank}` : null,
      snap_pct: sr?.pct ?? null,
      role_matches_usage: sr && d.pos_rank ? sr.rank === d.pos_rank : null
    };
  });
}

/** How a single player's role has moved across the season — the weekly view. */
export function roleTimeline(season, gsisId) {
  const d = rows(`SELECT week, team, pos_abb, pos_rank FROM nfl_depth
                  WHERE season=? AND gsis_id=? ORDER BY week`, season, gsisId);
  return d.map(r => ({
    week: r.week, team: r.team, position: r.pos_abb,
    depth_rank: r.pos_rank, role: r.pos_rank ? `${r.pos_abb}${r.pos_rank}` : r.pos_abb
  }));
}

const normalize = s => String(s ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------ accessors */

export function ngsFor(season, week, playerId) {
  const r = rows(`SELECT kind, stats FROM nfl_ngs WHERE season=? AND week=? AND player_id=?`,
    season, week, playerId);
  return Object.fromEntries(r.map(x => [x.kind, JSON.parse(x.stats)]));
}

export function injuryFor(season, week, gsisId) {
  return rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=? AND gsis_id=?`, season, week, gsisId)[0] ?? null;
}

export function snapShare(season, week, player, team) {
  return rows(`SELECT offense_pct FROM nfl_snaps WHERE season=? AND week=? AND player=? AND team=?`,
    season, week, player, team)[0]?.offense_pct ?? null;
}

export async function syncAllAdvanced(seasons) {
  const out = {};
  const step = async (name, fn) => {
    try { const r = await fn(); recordSync(name, 'ok', r); return r; }
    catch (e) {
      recordSync(name, 'error', e.message);
      // These feeds are independent publications. A late NGS file must not
      // prevent snap counts, depth charts, or injury reports from landing.
      return { error: e.message };
    }
  };
  out.ngs = await step('nfl_ngs', () => syncNgs(seasons));
  out.pfr = await step('nfl_pfr_adv', () => syncPfrAdv(seasons));
  out.snaps = await step('nfl_advanced_snaps', () => syncSnaps(seasons));
  out.depth = await step('nfl_depth_charts', () => syncDepthCharts(seasons));
  out.injuries = await step('nfl_injuries', () => syncInjuries(seasons));
  return { ...out, failed: Object.entries(out).filter(([, result]) => result?.error).map(([source]) => source) };
}

export function advancedCoverage() {
  return {
    ngs: rows('SELECT season, kind, COUNT(*) AS rows FROM nfl_ngs GROUP BY season, kind ORDER BY season, kind'),
    pfr: rows('SELECT season, kind, COUNT(*) AS rows FROM nfl_pfr_adv GROUP BY season, kind ORDER BY season, kind'),
    snaps: rows('SELECT season, COUNT(*) AS rows FROM nfl_snaps GROUP BY season ORDER BY season'),
    depth: rows('SELECT season, COUNT(*) AS rows, MAX(week) AS through FROM nfl_depth GROUP BY season ORDER BY season'),
    injuries: rows('SELECT season, COUNT(*) AS rows FROM nfl_injuries GROUP BY season ORDER BY season')
  };
}
