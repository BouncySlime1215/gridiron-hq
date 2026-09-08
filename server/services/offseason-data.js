/**
 * Offseason feature ingestion and assembly.
 *
 * The offseason-changes model (`nfl-offseason-change.js`) derives exactly two
 * quantities — did the player change teams, and what share of his team's prior
 * opportunity walked out the door — both from `player_week_usage`. That is the
 * honest floor of what a single table can support, and it is nowhere near the
 * information that is actually free and public before Week 1.
 *
 * This file is the wider net. Everything here is sourced from nflverse's GitHub
 * release CSVs (no key, no rate limit), from tables this app already ingests, or
 * from Sleeper's open players endpoint. Nothing is scraped, nothing is paywalled,
 * and every column that could not be sourced honestly is absent rather than
 * faked — see docs/OFFSEASON_DATA.md for the per-column coverage counts and the
 * list of things that turned out not to exist for free.
 *
 * Ownership note: this module only ever creates and writes tables prefixed
 * `off_`. It reads a dozen existing tables and modifies none of them. The CSV
 * parser is imported from nflverse.js rather than reimplemented — a second
 * RFC-4180 parser is a second place for the quoting bug to come back.
 *
 * Layout:
 *   1. schema          the off_* tables
 *   2. fetch/parse     gzip-aware CSV loading on top of nflverse.js's parseCsv
 *   3. ingest          one function per upstream dataset
 *   4. compute         off_team_season and off_player_season_features
 *   5. read            offseasonFeatures / offseasonFeatureRow
 */
import { db, rows, row } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { recordSync } from './scheduler.js';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SLEEPER_PLAYERS = 'https://api.sleeper.app/v1/players/nfl';

/** Seasons the feature table is built for. 2021 is the first with a usable prior. */
export const FEATURE_SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];
/** Skill positions the feature table covers. Everything else is team context. */
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

/* ------------------------------------------------------- 2. fetch and parse */

const numOf = v => {
  if (v === '' || v == null || v === 'NA' || v === 'NULL') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOf = v => { const n = numOf(v); return n == null ? null : Math.round(n); };
const strOf = v => (v === '' || v == null || v === 'NA') ? null : String(v);
const boolOf = v => (v === 'TRUE' || v === 'true' || v === '1' || v === 1) ? 1
  : (v === 'FALSE' || v === 'false' || v === '0' || v === 0) ? 0 : null;

/** Column-name -> index lookup so an upstream reorder cannot shift a column. */
export function indexer(header) {
  const map = new Map(header.map((h, i) => [h, i]));
  return name => map.get(name) ?? -1;
}

/**
 * A CSV row as a name-keyed accessor. Slower than raw indices but this runs
 * once per sync over a few hundred thousand rows, and it keeps the ingest
 * functions readable enough to audit against the upstream header.
 */
function accessors(header) {
  const at = indexer(header);
  return {
    at,
    s: (rec, name) => { const i = at(name); return i < 0 ? null : strOf(rec[i]); },
    n: (rec, name) => { const i = at(name); return i < 0 ? null : numOf(rec[i]); },
    i: (rec, name) => { const j = at(name); return j < 0 ? null : intOf(rec[j]); },
    b: (rec, name) => { const i = at(name); return i < 0 ? null : boolOf(rec[i]); }
  };
}

/**
 * Fetch a CSV, transparently gunzipping `.gz` assets. Several nflverse releases
 * (contracts, nextgen_stats) publish ONLY a gzipped CSV — the plain `.csv` URL
 * 404s — so this is not an optimisation, it is the only way in.
 */
export async function fetchCsv(url, { timeoutMs = 300000 } = {}) {
  const res = await fetch(url, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url.split('/').pop()} -> HTTP ${res.status}`);
  if (url.endsWith('.gz')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return parseCsv(gunzipSync(buf).toString('utf8'));
  }
  return parseCsv(await res.text());
}

/** Every write goes through here: one transaction, rolled back as a unit. */
function inTransaction(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ------------------------------------------------------------ team codes */

/**
 * OverTheCap names teams by nickname; nflverse uses abbreviations. Relocations
 * are mapped to the CURRENT abbreviation on purpose — a contract signed with the
 * Oakland Raiders in 2019 is the same Las Vegas roster slot in 2021.
 */
const NICKNAME_TO_ABBR = {
  cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR',
  bears: 'CHI', bengals: 'CIN', browns: 'CLE', cowboys: 'DAL', broncos: 'DEN',
  lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND', jaguars: 'JAX',
  chiefs: 'KC', raiders: 'LV', chargers: 'LAC', rams: 'LA', dolphins: 'MIA',
  vikings: 'MIN', patriots: 'NE', saints: 'NO', giants: 'NYG', jets: 'NYJ',
  eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', seahawks: 'SEA',
  buccaneers: 'TB', titans: 'TEN', commanders: 'WAS', redskins: 'WAS',
  'football team': 'WAS', 'washington football team': 'WAS'
};
export function nicknameToAbbr(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  return NICKNAME_TO_ABBR[key] ?? NICKNAME_TO_ABBR[key.split(' ').pop()] ?? null;
}

/** Historical franchise codes seen in old nflverse rows, folded onto today's. */
const TEAM_ALIAS = { OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', WSH: 'WAS', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', JAC: 'JAX' };
export const normTeam = t => (t ? (TEAM_ALIAS[t] ?? t) : null);

/* ---------------------------------------------------------------- 3. ingest */

/** Rookie draft capital by team/position/round/pick. One file, all seasons. */
export async function syncDraftPicks({ from = 2015 } = {}) {
  const { header, records } = await fetchCsv(`${RELEASE}/draft_picks/draft_picks.csv`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_draft_picks
    (season, pick, round, team, gsis_id, pfr_id, player_name, position, side, college, age)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  inTransaction(() => {
    for (const rec of records) {
      const season = a.i(rec, 'season'), pick = a.i(rec, 'pick');
      if (season == null || pick == null || season < from) continue;
      stmt.run(season, pick, a.i(rec, 'round'), normTeam(a.s(rec, 'team')), a.s(rec, 'gsis_id'),
        a.s(rec, 'pfr_player_id'), a.s(rec, 'pfr_player_name'), a.s(rec, 'position'),
        a.s(rec, 'side'), a.s(rec, 'college'), a.n(rec, 'age'));
      inserted++;
    }
  });
  return { dataset: 'draft_picks', upstream_rows: records.length, inserted };
}

/**
 * OverTheCap contract history. The upstream file carries no gsis_id, so the
 * crosswalk is resolved after off_rosters exists (see resolveContractIds).
 */
export async function syncContracts() {
  const { header, records } = await fetchCsv(`${RELEASE}/contracts/historical_contracts.csv.gz`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_contracts
    (otc_id, year_signed, years, player, position, team, team_abbr, is_active,
     value, apy, guaranteed, apy_cap_pct, draft_year, draft_round, draft_overall,
     date_of_birth, college, gsis_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
      (SELECT gsis_id FROM off_contracts c WHERE c.otc_id = ? LIMIT 1))`);
  let inserted = 0, skipped = 0;
  inTransaction(() => {
    for (const rec of records) {
      const otc = a.s(rec, 'otc_id'), ys = a.i(rec, 'year_signed'), yrs = a.i(rec, 'years');
      if (!otc || ys == null || yrs == null) { skipped++; continue; }
      const team = a.s(rec, 'team');
      stmt.run(otc, ys, yrs, a.s(rec, 'player'), a.s(rec, 'position'), team, nicknameToAbbr(team),
        a.b(rec, 'is_active'), a.n(rec, 'value'), a.n(rec, 'apy'), a.n(rec, 'guaranteed'),
        a.n(rec, 'apy_cap_pct'), a.i(rec, 'draft_year'), a.i(rec, 'draft_round'),
        a.i(rec, 'draft_overall'), a.s(rec, 'date_of_birth'), a.s(rec, 'college'), otc);
      inserted++;
    }
  });
  return { dataset: 'contracts', upstream_rows: records.length, inserted, skipped };
}

/** Week-1 roster for one season, plus the id crosswalk it carries. */
export async function syncRosters(season) {
  const { header, records } = await fetchCsv(`${RELEASE}/rosters/roster_${season}.csv`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_rosters
    (season, gsis_id, team, position, depth_chart_position, status, jersey_number,
     years_exp, birth_date, height, weight, college, espn_id, pfr_id, sleeper_id,
     entry_year, rookie_year, draft_club, draft_number, player_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0, noGsis = 0;
  inTransaction(() => {
    for (const rec of records) {
      const gsis = a.s(rec, 'gsis_id');
      if (!gsis) { noGsis++; continue; }
      stmt.run(season, gsis, normTeam(a.s(rec, 'team')), a.s(rec, 'position'),
        a.s(rec, 'depth_chart_position'), a.s(rec, 'status'), a.i(rec, 'jersey_number'),
        a.i(rec, 'years_exp'), a.s(rec, 'birth_date'), a.n(rec, 'height'), a.n(rec, 'weight'),
        a.s(rec, 'college'), a.i(rec, 'espn_id'), a.s(rec, 'pfr_id'), a.s(rec, 'sleeper_id'),
        a.i(rec, 'entry_year'), a.i(rec, 'rookie_year'), a.s(rec, 'draft_club'),
        a.i(rec, 'draft_number'), a.s(rec, 'full_name'));
      inserted++;
    }
  });
  return { dataset: 'rosters', season, upstream_rows: records.length, inserted, no_gsis: noGsis };
}

/**
 * The earliest depth chart published for a season.
 *
 * nflverse changed this feed in 2025. Through 2024 it is the NFL's own weekly
 * chart (season/club_code/week/depth_team/depth_position); from 2025 it is a
 * dated ESPN scrape (dt/team/pos_abb/pos_rank) with no season or week column at
 * all. Both are reduced to the same thing — the opening-week ordering — because
 * that is the only part of a depth chart that is knowable before Week 1.
 */
export async function syncDepthCharts(season) {
  const { header, records } = await fetchCsv(`${RELEASE}/depth_charts/depth_charts_${season}.csv`);
  const a = accessors(header);
  const modern = a.at('dt') >= 0;

  // Pick the snapshot that represents the opening-week ordering.
  //
  // For the weekly format that is simply week 1. For the dated ESPN format it
  // is the earliest snapshot taken on or after 1 August — the file for an
  // upcoming season starts in MARCH, and a March depth chart predates free
  // agency and the draft, so taking the literal earliest row would describe a
  // roster that no longer exists. If nothing has been published yet in August
  // (a season being synced in the spring), fall back to the latest row there
  // is, which is the most informative thing available and never a future leak.
  const keyOf = rec => modern ? a.s(rec, 'dt') : String(a.i(rec, 'week') ?? '');
  const AUGUST = `${season}-08-01`;
  let earliest = null, latest = null;
  for (const rec of records) {
    if (!modern && a.s(rec, 'game_type') !== 'REG') continue;
    const k = keyOf(rec);
    if (!k) continue;
    if (latest == null || k > latest) latest = k;
    if (modern && k < AUGUST) continue;
    if (earliest == null || k < earliest) earliest = k;
  }
  earliest ??= latest;
  if (earliest == null) return { dataset: 'depth_charts', season, upstream_rows: records.length, inserted: 0, note: 'no usable rows' };

  const stmt = db.prepare(`INSERT OR REPLACE INTO off_depth_chart
    (season, team, gsis_id, pos_abb, pos_rank, pos_slot, source_week, source_dt, player_name)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  inTransaction(() => {
    for (const rec of records) {
      if (keyOf(rec) !== earliest) continue;
      const gsis = a.s(rec, 'gsis_id');
      if (!gsis) continue;
      const team = normTeam(a.s(rec, modern ? 'team' : 'club_code'));
      const pos = modern ? a.s(rec, 'pos_abb') : (a.s(rec, 'depth_position') || a.s(rec, 'position'));
      if (!team || !pos) continue;
      stmt.run(season, team, gsis, pos,
        modern ? a.i(rec, 'pos_rank') : a.i(rec, 'depth_team'),
        modern ? a.s(rec, 'pos_slot') : a.s(rec, 'formation'),
        modern ? null : a.i(rec, 'week'),
        modern ? earliest : null,
        a.s(rec, modern ? 'player_name' : 'full_name'));
      inserted++;
    }
  });
  return { dataset: 'depth_charts', season, upstream_rows: records.length, inserted, snapshot: earliest, format: modern ? 'espn-dated' : 'nfl-weekly' };
}

const NGS_KINDS = ['receiving', 'rushing', 'passing'];

/**
 * Next Gen Stats season totals — the `week = 0` rows of the weekly files.
 *
 * Read from the ALL-SEASONS assets (`ngs_receiving.csv.gz`), not the per-season
 * ones. The per-season files still exist but stopped being refreshed after 2023:
 * `ngs_2024_receiving.csv.gz` currently holds four rows and there is no 2025
 * file at all, while the combined asset is complete through 2025. A per-season
 * fetch here would have quietly produced a nearly empty column.
 */
export async function syncNextGen(seasons) {
  const want = new Set(seasons);
  const out = { dataset: 'nextgen_stats', seasons: [...want], inserted: 0, kinds: {}, by_season: {} };
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_ngs_season
    (season, gsis_id, kind, team, position, avg_separation, avg_cushion,
     avg_intended_air_yards, air_yards_share, avg_yac_above_expectation, catch_percentage,
     rush_efficiency, rush_yards_over_expected_per_att, pct_attempts_gte_eight_defenders,
     avg_time_to_los, avg_time_to_throw, aggressiveness, completion_pct_above_expectation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const kind of NGS_KINDS) {
    let parsed;
    try { parsed = await fetchCsv(`${RELEASE}/nextgen_stats/ngs_${kind}.csv.gz`); }
    catch (e) { out.kinds[kind] = `error: ${e.message}`; continue; }
    const a = accessors(parsed.header);
    let n = 0;
    inTransaction(() => {
      for (const rec of parsed.records) {
        if (a.i(rec, 'week') !== 0) continue;           // week 0 == season total
        if (a.s(rec, 'season_type') !== 'REG') continue;
        const season = a.i(rec, 'season');
        if (!want.has(season)) continue;
        const gsis = a.s(rec, 'player_gsis_id');
        if (!gsis) continue;
        out.by_season[season] = (out.by_season[season] ?? 0) + 1;
        stmt.run(season, gsis, kind, normTeam(a.s(rec, 'team_abbr')), a.s(rec, 'player_position'),
          a.n(rec, 'avg_separation'), a.n(rec, 'avg_cushion'), a.n(rec, 'avg_intended_air_yards'),
          a.n(rec, 'percent_share_of_intended_air_yards'), a.n(rec, 'avg_yac_above_expectation'),
          a.n(rec, 'catch_percentage'), a.n(rec, 'efficiency'),
          a.n(rec, 'rush_yards_over_expected_per_att'), a.n(rec, 'percent_attempts_gte_eight_defenders'),
          a.n(rec, 'avg_time_to_los'), a.n(rec, 'avg_time_to_throw'), a.n(rec, 'aggressiveness'),
          a.n(rec, 'completion_percentage_above_expectation'));
        n++;
      }
    });
    out.kinds[kind] = n;
    out.inserted += n;
  }
  return out;
}

/** PFR advanced season splits (receiving / rushing / passing), keyed on pfr_id. */
export async function syncPfrAdvanced() {
  const files = { rec: 'advstats_season_rec', rush: 'advstats_season_rush', pass: 'advstats_season_pass' };
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_pfr_adv_season
    (season, pfr_id, kind, player, team, position, games, games_started,
     adot, yac_per_rec, ybc_per_rec, broken_tackles, drop_pct, ybc_per_att, yac_per_att,
     pressure_pct, on_target_pct, pocket_time, play_action_att)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const out = { dataset: 'pfr_advstats', inserted: 0, kinds: {} };
  for (const [kind, file] of Object.entries(files)) {
    let parsed;
    try { parsed = await fetchCsv(`${RELEASE}/pfr_advstats/${file}.csv`); }
    catch (e) { out.kinds[kind] = `error: ${e.message}`; continue; }
    const a = accessors(parsed.header);
    let n = 0;
    inTransaction(() => {
      for (const rec of parsed.records) {
        const pfr = a.s(rec, 'pfr_id'), season = a.i(rec, 'season');
        if (!pfr || season == null) continue;
        stmt.run(season, pfr, kind, a.s(rec, 'player'),
          normTeam(a.s(rec, 'tm') ?? a.s(rec, 'team')), a.s(rec, 'pos'),
          a.i(rec, 'g'), a.i(rec, 'gs'),
          a.n(rec, 'adot'), a.n(rec, 'yac_r'), a.n(rec, 'ybc_r'), a.n(rec, 'brk_tkl'),
          a.n(rec, 'drop_percent'), a.n(rec, 'ybc_att'), a.n(rec, 'yac_att'),
          a.n(rec, 'pressure_pct'), a.n(rec, 'on_tgt_pct'), a.n(rec, 'pocket_time'),
          a.n(rec, 'pa_pass_att'));
        n++;
      }
    });
    out.kinds[kind] = n;
    out.inserted += n;
  }
  return out;
}

/** ESPN QBR, season level. One file, all seasons. */
export async function syncQbr({ from = 2015 } = {}) {
  const { header, records } = await fetchCsv(`${RELEASE}/espn_data/qbr_season_level.csv`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_qbr_season
    (season, team, espn_player_id, name, qbr_total, pts_added, qb_plays, epa_total, qbr_raw, qualified)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  inTransaction(() => {
    for (const rec of records) {
      const season = a.i(rec, 'season');
      if (season == null || season < from) continue;
      if (a.s(rec, 'season_type') !== 'Regular') continue;
      const team = normTeam(a.s(rec, 'team_abb')), pid = a.i(rec, 'player_id');
      if (!team || pid == null) continue;
      stmt.run(season, team, pid, a.s(rec, 'name_display'), a.n(rec, 'qbr_total'),
        a.n(rec, 'pts_added'), a.i(rec, 'qb_plays'), a.n(rec, 'epa_total'),
        a.n(rec, 'qbr_raw'), a.b(rec, 'qualified'));
      inserted++;
    }
  });
  return { dataset: 'espn_qbr', upstream_rows: records.length, inserted };
}

/** nflverse schedules — one file, every season, including the upcoming one. */
export async function syncSchedules({ from = 2019 } = {}) {
  const { header, records } = await fetchCsv(`${RELEASE}/schedules/games.csv`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_schedule_games
    (game_id, season, game_type, week, gameday, weekday, away_team, home_team, location,
     spread_line, total_line, away_moneyline, home_moneyline, div_game, roof, surface,
     stadium_id, away_rest, home_rest, away_coach, home_coach, away_qb_id, home_qb_id,
     away_score, home_score)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  inTransaction(() => {
    for (const rec of records) {
      const season = a.i(rec, 'season'), gid = a.s(rec, 'game_id');
      if (!gid || season == null || season < from) continue;
      stmt.run(gid, season, a.s(rec, 'game_type'), a.i(rec, 'week'), a.s(rec, 'gameday'),
        a.s(rec, 'weekday'), normTeam(a.s(rec, 'away_team')), normTeam(a.s(rec, 'home_team')),
        a.s(rec, 'location'), a.n(rec, 'spread_line'), a.n(rec, 'total_line'),
        a.i(rec, 'away_moneyline'), a.i(rec, 'home_moneyline'), a.i(rec, 'div_game'),
        a.s(rec, 'roof'), a.s(rec, 'surface'), a.s(rec, 'stadium_id'),
        a.i(rec, 'away_rest'), a.i(rec, 'home_rest'), a.s(rec, 'away_coach'), a.s(rec, 'home_coach'),
        a.s(rec, 'away_qb_id'), a.s(rec, 'home_qb_id'), a.i(rec, 'away_score'), a.i(rec, 'home_score'));
      inserted++;
    }
  });
  return { dataset: 'schedules', upstream_rows: records.length, inserted };
}

/**
 * Team season totals. Preferred over aggregating play-by-play: nflverse already
 * publishes this pre-aggregated at ~30KB a season, where the pbp CSV is ~200MB.
 */
export async function syncTeamStats(season) {
  const { header, records } = await fetchCsv(`${RELEASE}/stats_team/stats_team_reg_${season}.csv`);
  const a = accessors(header);
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_team_season_stats
    (season, team, games, attempts, carries, sacks_suffered, completions,
     passing_yards, rushing_yards, passing_tds, rushing_tds, passing_epa, rushing_epa,
     passing_air_yards, targets, passing_first_downs, rushing_first_downs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  inTransaction(() => {
    for (const rec of records) {
      const team = normTeam(a.s(rec, 'team'));
      if (!team) continue;
      stmt.run(season, team, a.i(rec, 'games'), a.n(rec, 'attempts'), a.n(rec, 'carries'),
        a.n(rec, 'sacks_suffered'), a.n(rec, 'completions'), a.n(rec, 'passing_yards'),
        a.n(rec, 'rushing_yards'), a.n(rec, 'passing_tds'), a.n(rec, 'rushing_tds'),
        a.n(rec, 'passing_epa'), a.n(rec, 'rushing_epa'), a.n(rec, 'passing_air_yards'),
        a.n(rec, 'targets'), a.n(rec, 'passing_first_downs'), a.n(rec, 'rushing_first_downs'));
      inserted++;
    }
  });
  return { dataset: 'team_stats', season, upstream_rows: records.length, inserted };
}

/** Sleeper's open players dump — current depth order and injury designation. */
export async function syncSleeper() {
  const res = await fetch(SLEEPER_PLAYERS, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`sleeper players -> HTTP ${res.status}`);
  const all = await res.json();
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_sleeper_players
    (sleeper_id, gsis_id, espn_id, full_name, position, team, status, injury_status,
     injury_body_part, practice_participation, depth_chart_position, depth_chart_order,
     years_exp, age, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  let inserted = 0;
  inTransaction(() => {
    for (const [id, p] of Object.entries(all)) {
      if (!p || p.sport !== 'nfl') continue;
      if (!p.team && !p.gsis_id) continue;              // free agents with no id are noise
      stmt.run(String(id), p.gsis_id ?? null, Number.isFinite(p.espn_id) ? p.espn_id : null,
        p.full_name ?? null, p.position ?? null, normTeam(p.team ?? null), p.status ?? null,
        p.injury_status ?? null, p.injury_body_part ?? null, p.practice_participation ?? null,
        p.depth_chart_position ?? null,
        Number.isFinite(p.depth_chart_order) ? p.depth_chart_order : null,
        Number.isFinite(p.years_exp) ? p.years_exp : null, null, now);
      inserted++;
    }
  });
  return { dataset: 'sleeper_players', upstream_rows: Object.keys(all).length, inserted, ...resolveSleeperIds() };
}

/**
 * Fill in the gsis_id Sleeper mostly does not publish.
 *
 * Sleeper carries a `gsis_id` field but only populates it for about a third of
 * its player universe, and skews heavily towards retired players — Ja'Marr Chase
 * has none while Chase Daniel does. nflverse's roster file publishes `sleeper_id`
 * for nearly everyone, so the join runs in that direction instead, with espn_id
 * as the fallback. Nothing is matched by name.
 */
export function resolveSleeperIds() {
  const bySleeper = new Map(), byEspn = new Map();
  for (const r of rows(`SELECT gsis_id, sleeper_id, espn_id FROM off_rosters
                        WHERE gsis_id IS NOT NULL ORDER BY season DESC`)) {
    if (r.sleeper_id && !bySleeper.has(r.sleeper_id)) bySleeper.set(r.sleeper_id, r.gsis_id);
    if (r.espn_id != null && !byEspn.has(r.espn_id)) byEspn.set(r.espn_id, r.gsis_id);
  }
  const up = db.prepare('UPDATE off_sleeper_players SET gsis_id = ? WHERE sleeper_id = ?');
  let filled = 0;
  inTransaction(() => {
    for (const s of rows(`SELECT sleeper_id, espn_id, gsis_id FROM off_sleeper_players`)) {
      const g = bySleeper.get(s.sleeper_id) ?? (s.espn_id != null ? byEspn.get(s.espn_id) : null) ?? s.gsis_id;
      if (!g || g === s.gsis_id) continue;
      up.run(g, s.sleeper_id);
      filled++;
    }
  });
  return { sleeper_gsis_filled: filled };
}

/**
 * Resolve OverTheCap rows to gsis_id.
 *
 * OTC publishes draft_year + draft_overall for drafted players, and nflverse's
 * rosters publish draft_number + entry_year. That pair is a near-unique key and
 * is immune to the name-spelling drift that makes name matching unreliable
 * ("Marvin Mims Jr.", "Chris Lindstrom" vs "Christopher"). Names are the
 * fallback, and only when normalised name + position resolves to exactly ONE
 * roster player — an ambiguous name is left NULL rather than guessed.
 */
export function resolveContractIds() {
  const norm = s => (s ?? '').toLowerCase().replace(/[.'’-]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();

  const roster = rows(`SELECT gsis_id, player_name, position, draft_number, entry_year
                       FROM off_rosters GROUP BY gsis_id`);
  const byDraft = new Map(), byName = new Map();
  for (const r of roster) {
    if (r.draft_number != null && r.entry_year != null) {
      const k = `${r.entry_year}|${r.draft_number}`;
      if (!byDraft.has(k)) byDraft.set(k, []);
      byDraft.get(k).push(r.gsis_id);
    }
    const nk = `${norm(r.player_name)}|${r.position}`;
    if (!byName.has(nk)) byName.set(nk, new Set());
    byName.get(nk).add(r.gsis_id);
  }

  const contracts = rows(`SELECT DISTINCT otc_id, player, position, draft_year, draft_overall FROM off_contracts`);
  const up = db.prepare('UPDATE off_contracts SET gsis_id = ? WHERE otc_id = ?');
  let byDraftHit = 0, byNameHit = 0, ambiguous = 0, unresolved = 0;
  inTransaction(() => {
    for (const c of contracts) {
      let gsis = null;
      if (c.draft_year != null && c.draft_overall != null) {
        const hit = byDraft.get(`${c.draft_year}|${c.draft_overall}`);
        if (hit?.length === 1) { gsis = hit[0]; byDraftHit++; }
      }
      if (!gsis) {
        const hit = byName.get(`${norm(c.player)}|${c.position}`);
        if (hit?.size === 1) { gsis = [...hit][0]; byNameHit++; }
        else if (hit?.size > 1) { ambiguous++; }
      }
      if (!gsis) { unresolved++; continue; }
      up.run(gsis, c.otc_id);
    }
  });
  return { contracts: contracts.length, by_draft: byDraftHit, by_name: byNameHit, ambiguous, unresolved };
}

/* --------------------------------------------------------------- 4. compute */

const avg = a => { const v = a.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const sum = a => a.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
const div = (n, d) => (d && Number.isFinite(n) && d !== 0 ? n / d : null);

/** PPR points from a player_week_usage row. Half-PPR/standard would rescale it. */
export function pprPoints(u) {
  return 0.04 * (u.passing_yards ?? 0) + 4 * (u.passing_tds ?? 0) - 2 * (u.interceptions ?? 0)
    + 0.1 * (u.rushing_yards ?? 0) + 6 * (u.rushing_tds ?? 0)
    + 0.1 * (u.receiving_yards ?? 0) + 6 * (u.receiving_tds ?? 0) + 1 * (u.receptions ?? 0)
    - 2 * (u.fumbles_lost ?? 0);
}

/**
 * Implied points for both sides of one scheduled game.
 * nflverse's `spread_line` is the HOME spread with a positive number meaning the
 * home team is favoured, so the favourite's implied total is the higher one.
 */
export function impliedPoints({ total_line, spread_line }) {
  if (total_line == null || spread_line == null) return { home: null, away: null };
  return { home: total_line / 2 + spread_line / 2, away: total_line / 2 - spread_line / 2 };
}

/** Per-team season implied totals, opponent strength, bye week, venue. */
function scheduleContext(season) {
  const games = rows(`SELECT * FROM off_schedule_games WHERE season = ? AND game_type = 'REG'`, season);
  const byTeam = new Map();
  const teamOf = t => {
    if (!byTeam.has(t)) byTeam.set(t, { team: t, implied: [], totals: [], spreads: [], opponents: [], weeks: new Set(), div: 0, neutral: 0, homeRoof: [], homeSurface: [], coaches: [] });
    return byTeam.get(t);
  };
  for (const g of games) {
    const ip = impliedPoints(g);
    for (const side of ['home', 'away']) {
      const me = side === 'home' ? g.home_team : g.away_team;
      const opp = side === 'home' ? g.away_team : g.home_team;
      if (!me) continue;
      const t = teamOf(me);
      if (ip[side] != null) t.implied.push(ip[side]);
      if (g.total_line != null) t.totals.push(g.total_line);
      // spread from this team's perspective, negative = favoured (book convention)
      if (g.spread_line != null) t.spreads.push(side === 'home' ? -g.spread_line : g.spread_line);
      if (opp) t.opponents.push(opp);
      if (g.week != null) t.weeks.add(g.week);
      if (g.div_game) t.div++;
      if (g.location && g.location !== 'Home') t.neutral++;
      if (side === 'home') { t.homeRoof.push(g.roof); t.homeSurface.push(g.surface); }
      const coach = side === 'home' ? g.home_coach : g.away_coach;
      if (coach) t.coaches.push(coach);
    }
  }
  const out = new Map();
  for (const t of byTeam.values()) {
    const maxWeek = t.weeks.size ? Math.max(...t.weeks) : 0;
    let bye = null;
    for (let w = 1; w <= maxWeek; w++) if (!t.weeks.has(w)) { bye = w; break; }
    // Home venue: the modal roof/surface of this team's home games. A team that
    // plays a home game in London does not become a dome team because of it.
    const mode = arr => {
      const c = new Map();
      for (const v of arr) if (v) c.set(v, (c.get(v) ?? 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const roof = mode(t.homeRoof);
    out.set(t.team, {
      team: t.team, games_scheduled: t.weeks.size, bye_week: bye,
      implied_team_points: avg(t.implied), team_total_line_avg: avg(t.totals),
      team_spread_avg: avg(t.spreads), opponents: t.opponents,
      div_games: t.div, neutral_site_games: t.neutral,
      dome_home: roof == null ? null : (roof === 'dome' || roof === 'closed' ? 1 : 0),
      home_surface: mode(t.homeSurface),
      head_coach: mode(t.coaches)
    });
  }
  // Opponent strength: the mean of the implied points our opponents are given
  // this season. A higher number means we face better offences.
  for (const t of out.values()) {
    t.opp_implied_points_avg = avg(t.opponents.map(o => out.get(o)?.implied_team_points ?? null));
    t.division_sos_proxy = t.opp_implied_points_avg;
  }
  return out;
}

/** The team's primary QB in a completed season: most pass attempts. */
function primaryQb(season) {
  const r = rows(`SELECT team, player_id, SUM(COALESCE(attempts,0)) att
                  FROM player_week_usage WHERE season = ? AND team IS NOT NULL AND position = 'QB'
                  GROUP BY team, player_id ORDER BY att DESC`, season);
  const best = new Map();
  for (const x of r) if (!best.has(x.team) && x.att > 0) best.set(x.team, x.player_id);
  return best;
}

/** The team's projected QB1 for a season that has not been played: depth chart. */
function depthChartQb(season) {
  const r = rows(`SELECT d.team, d.gsis_id, d.pos_rank
                  FROM off_depth_chart d WHERE d.season = ? AND d.pos_abb = 'QB'
                  ORDER BY d.pos_rank ASC`, season);
  const best = new Map();
  for (const x of r) if (!best.has(x.team)) best.set(x.team, x.gsis_id);
  return best;
}

/**
 * Builds off_team_season for one season, then returns it as a Map.
 * Everything here uses season T's schedule and season T-1's results.
 */
export function computeTeamSeason(season) {
  const sched = scheduleContext(season);
  const schedPrior = scheduleContext(season - 1);
  const prior = rows(`SELECT * FROM off_team_season_stats WHERE season = ?`, season - 1);
  const priorByTeam = new Map(prior.map(r => [r.team, r]));

  const coachPrior = new Map([...schedPrior.entries()].map(([t, v]) => [t, v.head_coach]));
  // Coach tenure walks back through prior schedules until the name changes.
  const tenure = (team, coach) => {
    if (!coach) return null;
    let n = 1;
    for (let s = season - 1; s >= 2010; s--) {
      const c = scheduleCache(s).get(team)?.head_coach;
      if (c !== coach) break;
      n++;
    }
    return n;
  };
  const cache = new Map();
  const scheduleCache = s => {
    if (!cache.has(s)) cache.set(s, scheduleContext(s));
    return cache.get(s);
  };
  cache.set(season - 1, schedPrior);

  // QB identity. A season with usage rows resolves from what actually happened;
  // the upcoming season can only resolve from the opening depth chart.
  const haveUsage = row(`SELECT COUNT(*) n FROM player_week_usage WHERE season = ?`, season)?.n > 0;
  const qbNow = haveUsage ? gsisMapFromPlayerIds(primaryQb(season)) : depthChartQb(season);
  const qbPrior = gsisMapFromPlayerIds(primaryQb(season - 1));

  // QBR is keyed on ESPN athlete ids; off_rosters carries the gsis->espn map.
  const espnOf = new Map(rows(`SELECT gsis_id, espn_id FROM off_rosters
                               WHERE espn_id IS NOT NULL GROUP BY gsis_id`).map(r => [r.gsis_id, r.espn_id]));
  const qbrPrior = new Map(rows(`SELECT espn_player_id, qbr_total, qb_plays FROM off_qbr_season
                                 WHERE season = ?`, season - 1).map(r => [r.espn_player_id, r]));
  const qbrOf = gsis => {
    const espn = espnOf.get(gsis);
    return espn == null ? null : (qbrPrior.get(espn)?.qbr_total ?? null);
  };

  const draftR13 = new Map(rows(`SELECT team, COUNT(*) n FROM off_draft_picks
                                 WHERE season = ? AND round <= 3 GROUP BY team`, season).map(r => [r.team, r.n]));

  const stmt = db.prepare(`INSERT OR REPLACE INTO off_team_season
    (season, team, games_scheduled, bye_week, implied_team_points, implied_points_prior,
     implied_points_delta, team_total_line_avg, team_spread_avg, opp_implied_points_avg,
     division_sos_proxy, div_games, neutral_site_games, dome_home, home_surface,
     head_coach, hc_change, hc_tenure_years, qb_gsis_id, qb_prior_gsis_id, qb_change,
     qb_qbr_prior, qb_prior_starter_qbr, qb_qbr_delta, team_pass_rate_prior,
     team_plays_per_game_prior, team_pass_epa_prior, team_points_per_game_prior, draft_picks_r1_3)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const pointsPrior = new Map(rows(`SELECT team, AVG(team_score) pts FROM game_lines
                                    WHERE season = ? AND team_score IS NOT NULL GROUP BY team`, season - 1)
    .map(r => [normTeam(r.team), r.pts]));

  const out = new Map();
  inTransaction(() => {
    for (const [team, s] of sched) {
      const p = priorByTeam.get(team);
      // Dropbacks, not attempts: a sack is a called pass play. This is the
      // standard nflverse pass-rate denominator and it moves a run-heavy team's
      // number by a couple of points, which matters for a rate this flat.
      const dropbacks = p ? (p.attempts ?? 0) + (p.sacks_suffered ?? 0) : null;
      const plays = p ? dropbacks + (p.carries ?? 0) : null;
      const impliedPrior = schedPrior.get(team)?.implied_team_points ?? null;
      const coach = s.head_coach, coachP = coachPrior.get(team) ?? null;
      const qbT = qbNow.get(team) ?? null, qbP = qbPrior.get(team) ?? null;
      const qbrT = qbT ? qbrOf(qbT) : null, qbrP = qbP ? qbrOf(qbP) : null;
      const rec = {
        season, team,
        games_scheduled: s.games_scheduled, bye_week: s.bye_week,
        implied_team_points: s.implied_team_points, implied_points_prior: impliedPrior,
        implied_points_delta: (s.implied_team_points != null && impliedPrior != null)
          ? s.implied_team_points - impliedPrior : null,
        team_total_line_avg: s.team_total_line_avg, team_spread_avg: s.team_spread_avg,
        opp_implied_points_avg: s.opp_implied_points_avg, division_sos_proxy: s.division_sos_proxy,
        div_games: s.div_games, neutral_site_games: s.neutral_site_games,
        dome_home: s.dome_home, home_surface: s.home_surface,
        head_coach: coach,
        hc_change: (coach && coachP) ? (coach === coachP ? 0 : 1) : null,
        hc_tenure_years: tenure(team, coach),
        qb_gsis_id: qbT, qb_prior_gsis_id: qbP,
        qb_change: (qbT && qbP) ? (qbT === qbP ? 0 : 1) : null,
        qb_qbr_prior: qbrT, qb_prior_starter_qbr: qbrP,
        qb_qbr_delta: (qbrT != null && qbrP != null) ? qbrT - qbrP : null,
        team_pass_rate_prior: div(dropbacks, plays),
        team_plays_per_game_prior: p ? div(plays, p.games) : null,
        team_pass_epa_prior: p ? div(p.passing_epa, dropbacks) : null,
        team_points_per_game_prior: pointsPrior.get(team) ?? null,
        draft_picks_r1_3: draftR13.get(team) ?? 0
      };
      stmt.run(...[
        rec.season, rec.team, rec.games_scheduled, rec.bye_week, rec.implied_team_points,
        rec.implied_points_prior, rec.implied_points_delta, rec.team_total_line_avg,
        rec.team_spread_avg, rec.opp_implied_points_avg, rec.division_sos_proxy,
        rec.div_games, rec.neutral_site_games, rec.dome_home, rec.home_surface,
        rec.head_coach, rec.hc_change, rec.hc_tenure_years, rec.qb_gsis_id, rec.qb_prior_gsis_id,
        rec.qb_change, rec.qb_qbr_prior, rec.qb_prior_starter_qbr, rec.qb_qbr_delta,
        rec.team_pass_rate_prior, rec.team_plays_per_game_prior, rec.team_pass_epa_prior,
        rec.team_points_per_game_prior, rec.draft_picks_r1_3
      ]);
      out.set(team, rec);
    }
  });
  return out;
}

/** Translate a Map<team, players.id> to Map<team, gsis_id>. */
function gsisMapFromPlayerIds(m) {
  const ids = [...m.values()];
  if (!ids.length) return new Map();
  const gsis = new Map(rows(`SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL
                             AND id IN (${ids.map(() => '?').join(',')})`, ...ids).map(r => [r.id, r.gsis_id]));
  return new Map([...m.entries()].map(([t, id]) => [t, gsis.get(id) ?? null]).filter(([, g]) => g));
}

/** Prior-season per-player usage aggregates, keyed by gsis_id. */
function priorUsage(season) {
  const usage = rows(`SELECT u.*, p.gsis_id FROM player_week_usage u
                      JOIN players p ON p.id = u.player_id
                      WHERE u.season = ? AND p.gsis_id IS NOT NULL`, season);
  const byPlayer = new Map();
  const teamTotals = new Map();
  for (const u of usage) {
    const t = normTeam(u.team);
    if (t) {
      if (!teamTotals.has(t)) teamTotals.set(t, { targets: 0, carries: 0, air_yards: 0 });
      const tt = teamTotals.get(t);
      tt.targets += u.targets ?? 0; tt.carries += u.carries ?? 0; tt.air_yards += u.receiving_air_yards ?? 0;
    }
    if (!byPlayer.has(u.gsis_id)) byPlayer.set(u.gsis_id, { gsis_id: u.gsis_id, player_id: u.player_id, weeks: [], teams: new Map() });
    const p = byPlayer.get(u.gsis_id);
    p.weeks.push(u);
    if (t) p.teams.set(t, (p.teams.get(t) ?? 0) + (u.targets ?? 0) + (u.carries ?? 0) + (u.attempts ?? 0));
  }
  for (const p of byPlayer.values()) {
    const w = p.weeks;
    p.games = w.length;
    p.points = sum(w.map(pprPoints));
    p.ppg = div(p.points, w.length);
    p.target_share = avg(w.map(x => x.target_share));
    p.air_yard_share = avg(w.map(x => x.air_yards_share));
    p.wopr = avg(w.map(x => x.wopr));
    p.targets = sum(w.map(x => x.targets));
    p.carries = sum(w.map(x => x.carries));
    p.receiving_air_yards = sum(w.map(x => x.receiving_air_yards));
    p.position = w.find(x => x.position)?.position ?? null;
    const epa = sum(w.map(x => (x.passing_epa ?? 0) + (x.rushing_epa ?? 0) + (x.receiving_epa ?? 0)));
    const plays = sum(w.map(x => (x.attempts ?? 0) + (x.carries ?? 0) + (x.targets ?? 0)));
    p.epa_per_play = div(epa, plays);
    p.team = [...p.teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const tt = p.team ? teamTotals.get(p.team) : null;
    p.carry_share = tt ? div(p.carries, tt.carries) : null;
  }
  return { byPlayer, teamTotals };
}

/**
 * Vacated opportunity: the share of a team's prior-season targets and carries
 * that belonged to players who are no longer on that roster.
 *
 * "No longer on the roster" is resolved from season T's roster file, not from
 * news — a player who signed elsewhere in March is on the new team's T roster
 * and therefore counts as departed from the old one. Players with no T roster
 * row at all (unsigned free agents, retirements) count as departed too, which
 * is the correct treatment: their opportunity is genuinely available.
 */
export function vacatedShares(season, priorAgg) {
  const rosterTeam = new Map(rows(`SELECT gsis_id, team FROM off_rosters WHERE season = ?`, season)
    .map(r => [r.gsis_id, r.team]));
  const vac = new Map();
  const bump = (team, key, v) => {
    if (!team) return;
    if (!vac.has(team)) vac.set(team, { targets: 0, carries: 0, vac_targets: 0, vac_carries: 0 });
    vac.get(team)[key] += v;
  };
  for (const p of priorAgg.byPlayer.values()) {
    if (!p.team) continue;
    bump(p.team, 'targets', p.targets);
    bump(p.team, 'carries', p.carries);
    const now = rosterTeam.get(p.gsis_id) ?? null;
    if (now !== p.team) {
      bump(p.team, 'vac_targets', p.targets);
      bump(p.team, 'vac_carries', p.carries);
    }
  }
  const out = new Map();
  for (const [team, v] of vac) {
    out.set(team, {
      vacated_target_share: div(v.vac_targets, v.targets),
      vacated_carry_share: div(v.vac_carries, v.carries)
    });
  }
  return out;
}

/** Coarse position groups, so a WR's competition is other WRs and not a guard. */
const POSITION_GROUP = p => {
  if (!p) return null;
  const u = p.toUpperCase();
  if (u === 'QB') return 'QB';
  if (u === 'RB' || u === 'FB' || u === 'HB') return 'RB';
  if (u === 'WR') return 'WR';
  if (u === 'TE') return 'TE';
  return u;
};

/** Prior-season availability from the weekly injury report. */
function priorInjuries(season) {
  const r = rows(`SELECT gsis_id, week, report_status FROM nfl_injuries WHERE season = ?`, season);
  const byPlayer = new Map();
  for (const x of r) {
    if (!x.gsis_id) continue;
    if (!byPlayer.has(x.gsis_id)) byPlayer.set(x.gsis_id, []);
    byPlayer.get(x.gsis_id).push(x);
  }
  const out = new Map();
  for (const [gsis, list] of byPlayer) {
    const outWeeks = list.filter(x => x.report_status === 'Out').map(x => x.week).sort((a, b) => a - b);
    // An "IR stint" here is a run of three or more consecutive Out weeks. The
    // injury report itself never says IR, and weekly rosters would only push the
    // count around the margins — this is the honest proxy, named as one.
    let stints = 0, runLen = 0, prev = null;
    for (const w of outWeeks) {
      runLen = (prev != null && w === prev + 1) ? runLen + 1 : 1;
      if (runLen === 3) stints++;
      prev = w;
    }
    const maxWeek = Math.max(0, ...list.map(x => x.week ?? 0));
    out.set(gsis, {
      games_missed: outWeeks.length,
      reports: list.length,
      ir_stints: stints,
      late_season: outWeeks.some(w => w >= Math.max(1, maxWeek - 3)) ? 1 : 0
    });
  }
  return out;
}

const FEATURE_COLUMNS = [
  'season', 'gsis_id', 'player_id', 'player_name', 'position', 'team', 'prior_team',
  'prior_ppg', 'prior_games', 'prior_target_share', 'prior_carry_share',
  'prior_air_yard_share', 'prior_snap_share', 'prior_wopr', 'prior_epa_per_play',
  'prior_xfp_per_game', 'prior_xfp_diff', 'prior_ngs_separation', 'prior_ngs_cushion',
  'prior_ngs_air_yards_share', 'prior_ryoe_per_att', 'prior_yac_oe', 'prior_adot',
  'prior_broken_tackles', 'prior_drop_pct',
  'team_change', 'new_team_vacated_target_share', 'new_team_vacated_carry_share',
  'own_team_vacated_share', 'capital_added_at_position', 'top_pick_added_at_position',
  'veterans_added_at_position',
  'apy', 'apy_cap_pct', 'apy_rank_on_team_at_position', 'contract_year', 'new_contract',
  'contract_years_remaining',
  'qb_change', 'qb_qbr_delta', 'hc_change', 'hc_tenure_years', 'implied_team_points',
  'implied_points_delta_vs_prior', 'team_pass_rate_prior', 'team_plays_prior',
  'team_points_per_game_prior', 'division_sos_proxy', 'bye_week', 'dome_home', 'home_surface',
  'depth_slot_t', 'depth_slot_prior_end', 'depth_slot_delta',
  'sleeper_depth_chart_order', 'sleeper_injury_status',
  'age_at_season', 'years_exp', 'rookie', 'draft_round', 'draft_pick',
  'injury_games_missed_prior', 'injury_reports_prior', 'ir_stints_prior',
  'late_season_injury_flag', 'computed_at'
];

/** Every column the feature table exposes, in table order. */
export const featureColumns = () => FEATURE_COLUMNS.slice();

/**
 * Build off_player_season_features for one season.
 *
 * Cutoff discipline: everything read here is either season T-1 or earlier
 * (production, injuries, team stats), or a season-T fact that is settled before
 * Week 1 (roster, draft, contracts, schedule, opening depth chart, betting
 * lines). Nothing reads a season-T game result.
 */
export function computeFeatures(season) {
  const teamSeason = computeTeamSeason(season);
  const prior = priorUsage(season - 1);
  const vacated = vacatedShares(season, prior);
  const injuries = priorInjuries(season - 1);

  const roster = rows(`SELECT * FROM off_rosters WHERE season = ?`, season);
  const rosterByGsis = new Map(roster.map(r => [r.gsis_id, r]));
  const priorRoster = new Map(rows(`SELECT * FROM off_rosters WHERE season = ?`, season - 1)
    .map(r => [r.gsis_id, r]));

  // Draft capital added at each team+position, restricted to rounds 1-3 (a
  // day-three pick is not meaningful competition for an established starter).
  const capital = new Map(), topPick = new Map();
  for (const d of rows(`SELECT team, position, round, pick FROM off_draft_picks WHERE season = ?`, season)) {
    const k = `${d.team}|${POSITION_GROUP(d.position)}`;
    if (d.round != null && d.round <= 3) capital.set(k, (capital.get(k) ?? 0) + 1);
    if (d.pick != null && (!topPick.has(k) || d.pick < topPick.get(k))) topPick.set(k, d.pick);
  }

  // Veteran arrivals: on this team in T, on a different team (or nowhere) in
  // T-1, with prior NFL experience. Rookies are already counted as capital.
  const vetsAdded = new Map();
  for (const r of roster) {
    if (!r.team) continue;
    const was = priorRoster.get(r.gsis_id)?.team ?? null;
    if (was === r.team) continue;
    if ((r.years_exp ?? 0) < 1) continue;
    const k = `${r.team}|${POSITION_GROUP(r.position)}`;
    vetsAdded.set(k, (vetsAdded.get(k) ?? 0) + 1);
  }

  // Active contracts covering season T, latest signing per player.
  const contracts = new Map();
  for (const c of rows(`SELECT * FROM off_contracts WHERE gsis_id IS NOT NULL
                        AND year_signed <= ? AND year_signed + years > ?
                        ORDER BY year_signed ASC`, season, season)) {
    contracts.set(c.gsis_id, c);      // later year_signed wins
  }
  // APY rank within team+position, computed over the players actually rostered
  // there in T so a stale OTC team label cannot inflate a rank.
  const apyGroups = new Map();
  for (const r of roster) {
    const c = contracts.get(r.gsis_id);
    if (!r.team || c?.apy == null) continue;
    const k = `${r.team}|${POSITION_GROUP(r.position)}`;
    if (!apyGroups.has(k)) apyGroups.set(k, []);
    apyGroups.get(k).push({ gsis_id: r.gsis_id, apy: c.apy });
  }
  const apyRank = new Map();
  for (const [, list] of apyGroups) {
    list.sort((a, b) => b.apy - a.apy);
    list.forEach((x, i) => apyRank.set(x.gsis_id, i + 1));
  }

  const depthT = new Map(rows(`SELECT gsis_id, MIN(pos_rank) rank FROM off_depth_chart
                               WHERE season = ? GROUP BY gsis_id`, season).map(r => [r.gsis_id, r.rank]));
  // Prior-season END slot: the last REGULAR-season week of the prior year's
  // depth chart, read from the app's own nfl_depth table (2021-2025).
  //
  // Capped at week 18 deliberately. nfl_depth runs to week 22, but weeks 19-22
  // are the playoffs — only a handful of teams are still playing, so taking the
  // literal MAX(week) resolves this column for about three percent of players.
  const depthPriorEnd = new Map();
  {
    const lastWeek = row(`SELECT MAX(week) w FROM nfl_depth WHERE season = ? AND week <= 18`, season - 1)?.w;
    if (lastWeek != null) {
      for (const r of rows(`SELECT gsis_id, MIN(pos_rank) rank FROM nfl_depth
                            WHERE season = ? AND week = ? GROUP BY gsis_id`, season - 1, lastWeek)) {
        depthPriorEnd.set(r.gsis_id, r.rank);
      }
    }
  }

  const ngsRec = new Map(rows(`SELECT * FROM off_ngs_season WHERE season = ? AND kind = 'receiving'`, season - 1)
    .map(r => [r.gsis_id, r]));
  const ngsRush = new Map(rows(`SELECT * FROM off_ngs_season WHERE season = ? AND kind = 'rushing'`, season - 1)
    .map(r => [r.gsis_id, r]));
  const pfrByGsis = new Map();
  for (const r of rows(`SELECT a.*, o.gsis_id FROM off_pfr_adv_season a
                        JOIN (SELECT pfr_id, gsis_id FROM off_rosters WHERE pfr_id IS NOT NULL GROUP BY pfr_id) o
                          ON o.pfr_id = a.pfr_id
                        WHERE a.season = ?`, season - 1)) {
    if (!pfrByGsis.has(r.gsis_id)) pfrByGsis.set(r.gsis_id, {});
    pfrByGsis.get(r.gsis_id)[r.kind] = r;
  }

  const xfp = new Map(rows(`SELECT player_gsis_id gsis_id,
                                   SUM(expected_fantasy_points) xfp,
                                   SUM(actual_fantasy_points) afp,
                                   COUNT(*) g
                            FROM nfl_ffopportunity_weekly WHERE season = ?
                            GROUP BY player_gsis_id`, season - 1).map(r => [r.gsis_id, r]));

  const snapPrior = new Map(rows(`SELECT p.gsis_id, AVG(s.offense_pct) pct
                                  FROM player_week_snaps s JOIN players p ON p.id = s.player_id
                                  WHERE s.season = ? AND p.gsis_id IS NOT NULL
                                  GROUP BY p.gsis_id`, season - 1).map(r => [r.gsis_id, r.pct]));

  // Sleeper publishes a live snapshot with no history, so its two columns are
  // only meaningful for the season currently being played or approached. Filling
  // them for 2022 would be stamping today's depth chart onto a settled season.
  const currentSeason = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  const sleeper = season === currentSeason
    ? new Map(rows(`SELECT gsis_id, depth_chart_order, injury_status
                    FROM off_sleeper_players WHERE gsis_id IS NOT NULL`).map(r => [r.gsis_id, r]))
    : new Map();

  const playerRowId = new Map(), playerRowName = new Map();
  for (const r of rows(`SELECT id, name, gsis_id FROM players WHERE gsis_id IS NOT NULL`)) {
    playerRowId.set(r.gsis_id, r.id);
    playerRowName.set(r.gsis_id, r.name);
  }
  const bio = new Map(rows(`SELECT gsis_id, birth_date, rookie_season, draft_round, draft_pick
                            FROM nflverse_player_positions`).map(r => [r.gsis_id, r]));

  // Universe: anyone at a skill position on a season-T roster, plus anyone who
  // produced at a skill position in T-1 (so a player who is between teams in
  // August still gets a row rather than silently vanishing from the feature set).
  const universe = new Map();
  for (const r of roster) if (SKILL.has(POSITION_GROUP(r.position))) universe.set(r.gsis_id, r.position);
  for (const p of prior.byPlayer.values()) {
    if (SKILL.has(POSITION_GROUP(p.position)) && !universe.has(p.gsis_id)) universe.set(p.gsis_id, p.position);
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT OR REPLACE INTO off_player_season_features
    (${FEATURE_COLUMNS.join(', ')}) VALUES (${FEATURE_COLUMNS.map(() => '?').join(',')})`);

  let written = 0;
  inTransaction(() => {
    for (const [gsis, position] of universe) {
      const r = rosterByGsis.get(gsis) ?? null;
      const p = prior.byPlayer.get(gsis) ?? null;
      const team = r?.team ?? null;
      const priorTeam = p?.team ?? null;
      const ts = team ? teamSeason.get(team) : null;
      const posGroup = POSITION_GROUP(position);
      const key = team ? `${team}|${posGroup}` : null;
      const c = contracts.get(gsis) ?? null;
      const b = bio.get(gsis) ?? null;
      const inj = injuries.get(gsis) ?? null;
      const nr = ngsRec.get(gsis) ?? null, nrun = ngsRush.get(gsis) ?? null;
      const pf = pfrByGsis.get(gsis) ?? {};
      const x = xfp.get(gsis) ?? null;
      const vacNew = team ? vacated.get(team) : null;
      const vacOwn = priorTeam ? vacated.get(priorTeam) : null;
      const dT = depthT.get(gsis) ?? null, dP = depthPriorEnd.get(gsis) ?? null;
      const sl = sleeper.get(gsis) ?? null;

      const birth = r?.birth_date ?? b?.birth_date ?? c?.date_of_birth ?? null;
      // Age on 1 September of season T — the start of the season, not today, so
      // the same row means the same thing whenever it is recomputed.
      const age = birth ? (new Date(`${season}-09-01`) - new Date(birth)) / (365.25 * 864e5) : null;
      const rookieSeason = r?.rookie_year ?? r?.entry_year ?? b?.rookie_season ?? null;

      // A running back is graded on carry share, a receiver on target share —
      // but "own team vacated share" should reflect whichever one he competes
      // for, so it follows position rather than blending both.
      const ownVac = posGroup === 'RB' ? (vacOwn?.vacated_carry_share ?? null)
        : (vacOwn?.vacated_target_share ?? null);

      const rec = {
        season, gsis_id: gsis, player_id: playerRowId.get(gsis) ?? null,
        player_name: r?.player_name ?? playerRowName.get(gsis) ?? c?.player ?? null,
        position, team, prior_team: priorTeam,
        prior_ppg: p?.ppg ?? null, prior_games: p?.games ?? null,
        prior_target_share: p?.target_share ?? null, prior_carry_share: p?.carry_share ?? null,
        prior_air_yard_share: p?.air_yard_share ?? null,
        prior_snap_share: snapPrior.get(gsis) ?? null,
        prior_wopr: p?.wopr ?? null, prior_epa_per_play: p?.epa_per_play ?? null,
        prior_xfp_per_game: x ? div(x.xfp, x.g) : null,
        prior_xfp_diff: x ? div((x.afp ?? 0) - (x.xfp ?? 0), x.g) : null,
        prior_ngs_separation: nr?.avg_separation ?? null,
        prior_ngs_cushion: nr?.avg_cushion ?? null,
        prior_ngs_air_yards_share: nr?.air_yards_share ?? null,
        prior_ryoe_per_att: nrun?.rush_yards_over_expected_per_att ?? null,
        prior_yac_oe: nr?.avg_yac_above_expectation ?? null,
        prior_adot: pf.rec?.adot ?? null,
        prior_broken_tackles: (pf.rec || pf.rush)
          ? (pf.rec?.broken_tackles ?? 0) + (pf.rush?.broken_tackles ?? 0) : null,
        prior_drop_pct: pf.rec?.drop_pct ?? null,
        team_change: (team && priorTeam) ? (team === priorTeam ? 0 : 1) : null,
        new_team_vacated_target_share: vacNew?.vacated_target_share ?? null,
        new_team_vacated_carry_share: vacNew?.vacated_carry_share ?? null,
        own_team_vacated_share: ownVac,
        capital_added_at_position: key ? (capital.get(key) ?? 0) : null,
        top_pick_added_at_position: key ? (topPick.get(key) ?? null) : null,
        veterans_added_at_position: key ? (vetsAdded.get(key) ?? 0) : null,
        apy: c?.apy ?? null, apy_cap_pct: c?.apy_cap_pct ?? null,
        apy_rank_on_team_at_position: apyRank.get(gsis) ?? null,
        contract_year: c ? (c.year_signed + c.years - 1 === season ? 1 : 0) : null,
        new_contract: c ? (c.year_signed === season ? 1 : 0) : null,
        contract_years_remaining: c ? c.year_signed + c.years - season : null,
        qb_change: ts?.qb_change ?? null, qb_qbr_delta: ts?.qb_qbr_delta ?? null,
        hc_change: ts?.hc_change ?? null, hc_tenure_years: ts?.hc_tenure_years ?? null,
        implied_team_points: ts?.implied_team_points ?? null,
        implied_points_delta_vs_prior: ts?.implied_points_delta ?? null,
        team_pass_rate_prior: ts?.team_pass_rate_prior ?? null,
        team_plays_prior: ts?.team_plays_per_game_prior ?? null,
        team_points_per_game_prior: ts?.team_points_per_game_prior ?? null,
        division_sos_proxy: ts?.division_sos_proxy ?? null,
        bye_week: ts?.bye_week ?? null, dome_home: ts?.dome_home ?? null,
        home_surface: ts?.home_surface ?? null,
        depth_slot_t: dT, depth_slot_prior_end: dP,
        depth_slot_delta: (dT != null && dP != null) ? dT - dP : null,
        sleeper_depth_chart_order: sl?.depth_chart_order ?? null,
        sleeper_injury_status: sl?.injury_status ?? null,
        age_at_season: age, years_exp: r?.years_exp ?? null,
        rookie: rookieSeason != null ? (rookieSeason === season ? 1 : 0) : null,
        draft_round: b?.draft_round ?? c?.draft_round ?? null,
        draft_pick: b?.draft_pick ?? c?.draft_overall ?? r?.draft_number ?? null,
        injury_games_missed_prior: inj?.games_missed ?? null,
        injury_reports_prior: inj?.reports ?? null,
        ir_stints_prior: inj?.ir_stints ?? null,
        late_season_injury_flag: inj?.late_season ?? null,
        computed_at: now
      };
      stmt.run(...FEATURE_COLUMNS.map(k => rec[k] ?? null));
      written++;
    }
  });
  return { season, players: written, teams: teamSeason.size };
}

/* -------------------------------------------------------------- orchestration */

/**
 * Full offseason sync. Each dataset is isolated: one 404 upstream costs that
 * dataset and nothing else, and the failure is reported rather than swallowed.
 */
export async function syncOffseasonData({ seasons = FEATURE_SEASONS, log = () => {} } = {}) {
  const started = Date.now();
  const result = { seasons, datasets: [], failures: [], features: [] };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      out.ms = Date.now() - t0;
      result.datasets.push(out);
      recordSync(`offseason_${name}`, 'ok', out);
      log(`  ok   ${name} ${JSON.stringify(out)}`);
      return out;
    } catch (e) {
      const fail = { dataset: name, error: e.message, ms: Date.now() - t0 };
      result.failures.push(fail);
      recordSync(`offseason_${name}`, 'error', e.message);
      log(`  FAIL ${name}: ${e.message}`);
      return null;
    }
  };

  // Season T's features read season T-1's rosters, NGS and team totals, so the
  // ingest window is one season wider than the feature window.
  const withPrior = [Math.min(...seasons) - 1, ...seasons];
  // The upcoming season has no team totals or NGS yet — a 404 there is the
  // absence of a season that has not been played, not a broken feed, so it is
  // reported as a skip rather than counted against the run.
  const played = withPrior.filter(s => s < Math.max(...seasons)
    || row(`SELECT COUNT(*) n FROM player_week_usage WHERE season = ?`, s)?.n > 0);
  result.skipped = withPrior.filter(s => !played.includes(s))
    .map(s => ({ dataset: 'team_stats/nextgen', season: s, reason: 'season not yet played' }));

  // Rosters first: every other crosswalk (pfr_id, espn_id, contracts) needs them.
  for (const s of withPrior) await step(`rosters_${s}`, () => syncRosters(s));
  await step('draft_picks', () => syncDraftPicks());
  await step('contracts', () => syncContracts());
  await step('contract_ids', async () => ({ dataset: 'contract_ids', ...resolveContractIds() }));
  for (const s of seasons) await step(`depth_charts_${s}`, () => syncDepthCharts(s));
  await step('nextgen', () => syncNextGen(played));
  await step('pfr_advstats', () => syncPfrAdvanced());
  await step('espn_qbr', () => syncQbr());
  await step('schedules', () => syncSchedules());
  for (const s of played) await step(`team_stats_${s}`, () => syncTeamStats(s));
  await step('sleeper', () => syncSleeper());

  for (const s of seasons) {
    const t0 = Date.now();
    try {
      const out = computeFeatures(s);
      out.ms = Date.now() - t0;
      result.features.push(out);
      log(`  ok   features_${s} ${JSON.stringify(out)}`);
    } catch (e) {
      result.failures.push({ dataset: `features_${s}`, error: e.message });
      log(`  FAIL features_${s}: ${e.message}`);
    }
  }
  recordSync('offseason_features', result.failures.length ? 'partial' : 'ok',
    { seasons, features: result.features, failures: result.failures });
  result.ms = Date.now() - started;
  return result;
}

/* ------------------------------------------------------------------ 5. read */

const cache = new Map();

/**
 * Every player's offseason feature row for a season, keyed by our players.id.
 *
 * One query, indexed in memory, cached for the life of the process. Rows with
 * no players.id (a player nflverse knows and this app's roster does not) are
 * still reachable by gsis_id through offseasonFeatureRow.
 */
export function offseasonFeatures(season) {
  const hit = cache.get(season);
  if (hit) return hit.byPlayerId;
  const all = rows('SELECT * FROM off_player_season_features WHERE season = ?', season);
  const byPlayerId = new Map(), byGsis = new Map();
  for (const r of all) {
    byGsis.set(r.gsis_id, r);
    if (r.player_id != null) byPlayerId.set(r.player_id, r);
  }
  cache.set(season, { byPlayerId, byGsis });
  return byPlayerId;
}

/** One player's row. Accepts a players.id or an nflverse gsis_id. */
export function offseasonFeatureRow(playerId, season) {
  offseasonFeatures(season);
  const c = cache.get(season);
  if (!c) return null;
  return (typeof playerId === 'string' ? c.byGsis.get(playerId) : c.byPlayerId.get(playerId)) ?? null;
}

/** Drop the in-process cache (after a sync, or in tests). */
export function clearOffseasonCache() { cache.clear(); }

/** Row counts per off_ table and per season — what the docs' coverage table reads. */
export function offseasonDataStatus() {
  const tables = ['off_draft_picks', 'off_contracts', 'off_rosters', 'off_depth_chart',
    'off_ngs_season', 'off_pfr_adv_season', 'off_qbr_season', 'off_schedule_games',
    'off_team_season_stats', 'off_sleeper_players', 'off_team_season',
    'off_player_season_features'];
  const out = {};
  for (const t of tables) {
    try { out[t] = row(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0; }
    catch { out[t] = null; }
  }
  out.features_by_season = rows(`SELECT season, COUNT(*) players FROM off_player_season_features
                                 GROUP BY season ORDER BY season`);
  return out;
}
