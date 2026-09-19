/**
 * STUDY-ONLY COPY of the weekly feature store at version v2 (satellite sources:
 * line history, nflverse participation, player value, man/zone). NOTHING in the
 * server imports this file, and nothing should until a gate says v2 ships.
 *
 * Why it is separate, 2026-09-17: v2 was built for the feature-store-as-substrate
 * study and landed by editing the production module in place. The server's
 * nfl_model_growth job freezes weekly vectors at WEEKLY_FEATURE_STORE_VERSION, so
 * on the next restart it found no v2 rows and began rebuilding every 2026 player
 * vector synchronously on the main thread — the app stopped answering requests
 * for 4+ minutes and wrote 684 player / 32 team v2 rows into the production
 * database before it was stopped. The study's verdict was that no v2 family
 * ships (man/zone, deviations and O-line took zero weight; the 871-feature ridge
 * gain did not survive a bootstrap), so production stays on v1 and this copy
 * serves scripts/backfill-feature-store.mjs and scripts/grade-feature-vector.mjs,
 * which run against data/derived/feature-store-study.sqlite.
 */
/**
 * High-dimensional weekly feature factory.
 *
 * Raw metrics become useful state only when their history, trend, volatility,
 * coverage and missingness are represented at the prediction cutoff. The store
 * generates those transformations uniformly and freezes the resulting vector.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';

// v2 adds the satellite sources below. The vector tables are immutable by
// trigger, so a new source family has to arrive as a new version rather than
// as a rewrite of frozen rows; v1 vectors stay readable at their own version.
export const WEEKLY_FEATURE_STORE_VERSION = 'nfl-weekly-feature-store-v2';
export const TRUSTED_HISTORY_START = Math.max(1999, Number(process.env.NFL_TRUSTED_HISTORY_START) || 2022);

const TRANSFORMS = Object.freeze(['latest', 'mean_3', 'mean_6', 'mean_12', 'ewma_6',
  'slope_6', 'sd_6', 'min_6', 'max_6', 'delta_1', 'z_latest', 'coverage_12', 'missing']);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const optionalRows = (sql, ...args) => { try { return rows(sql, ...args); } catch { return []; } };
const finite = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sd = values => {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const r6 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(6);

/* ======================================================================
 * Satellite sources.
 *
 * The store's own database holds nothing about coverage shells, motion,
 * play-action, personnel or pressure before 2024: nfl_play_formations is
 * empty, nfl_play_charting is 2026-only and nfl_pfr_adv starts in 2024. That
 * data does exist, in three databases this process does not own. They are
 * opened READ-ONLY and never written.
 *
 * Every satellite is loaded once per process and cached, because these are
 * historical archives that do not change under us. The cache is keyed by the
 * entity and holds a list of weekly observations sorted newest first; the
 * merge below then drops every observation that is not strictly earlier than
 * the target week. That is where leak-safety lives: the cache is indexed by
 * the week the play actually happened, and no consumer can reach a stamp at or
 * after the cutoff, because mergePrior refuses to hand one over.
 * ==================================================================== */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SATELLITES = Object.freeze({
  nflverse: process.env.NFLVERSE_DB_PATH || path.join(REPO_ROOT, 'data', 'line-history', 'nflverse.sqlite'),
  lineHistory: process.env.LINE_HISTORY_DB_PATH || path.join(REPO_ROOT, 'data', 'line-history', 'line_history.sqlite'),
  playerValue: process.env.PLAYER_VALUE_DB_PATH || path.join(REPO_ROOT, 'data', 'derived', 'player_value.sqlite')
});
// A 12-week lookback from week 5 reaches into the previous season, so the
// satellites are read from one season below the trusted floor.
const SATELLITE_FLOOR = TRUSTED_HISTORY_START - 1;

const satelliteHandles = new Map();
const satelliteErrors = new Map();
function satellite(name) {
  if (satelliteHandles.has(name)) return satelliteHandles.get(name);
  let handle = null;
  try {
    handle = new DatabaseSync(SATELLITES[name], { readOnly: true });
    handle.exec('PRAGMA busy_timeout = 15000');
  } catch (error) {
    // A missing satellite degrades the vector, it does not break the store:
    // the affected metrics simply never appear and `missing` stays honest.
    satelliteErrors.set(name, error.message);
    handle = null;
  }
  satelliteHandles.set(name, handle);
  return handle;
}

function satelliteRows(name, sql, ...args) {
  const handle = satellite(name);
  if (!handle) return [];
  try { return handle.prepare(sql).all(...args); } catch (error) {
    satelliteErrors.set(`${name}:query`, error.message);
    return [];
  }
}

/** Newest-first weekly observations, keyed by entity, ready for mergePrior. */
function indexByEntity(records) {
  const index = new Map();
  for (const record of records) {
    const list = index.get(record.key) ?? [];
    list.push(record); index.set(record.key, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.season - a.season || b.week - a.week);
  return index;
}

/**
 * Fold satellite observations into a history keyed by season|week, keeping
 * only stamps strictly earlier than the target week.
 *
 * This is deliberately a separate function from teamHistory's local `merge`:
 * the local merge trusts its SQL to have done the cutoff filtering, and these
 * come from a cache that holds every week ever played, including future ones.
 */
function mergePrior(byStamp, list, season, week, limit) {
  if (!list?.length) return;
  let added = 0;
  for (const item of list) {
    if (item.season > season || (item.season === season && item.week >= week)) continue;
    if (item.season < SATELLITE_FLOOR) break;
    const key = `${item.season}|${item.week}`;
    const target = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(target.values, item.values);
    byStamp.set(key, target);
    if (++added >= limit) break;
  }
}

const rate = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;

/* ---------------------------------------------- A/B: team-week tendencies */

/**
 * adv_team_week: motion, play-action, RPO, screen, no-huddle, coverage shells
 * and personnel groupings for 2020-2025, both sides of the ball, already
 * aggregated to the team-week. This is the table that fills the hole left by
 * the empty nfl_play_formations; FTN-derived columns (motion, play-action,
 * RPO, screen) only start in 2022, which the coverage transforms expose
 * rather than hide.
 */
let advTeamCache = null;
function advTeamWeek() {
  if (advTeamCache) return advTeamCache;
  const columns = ['epa_play', 'success_rate', 'proe', 'xpass', 'cpoe', 'dropback_epa', 'rush_epa',
    'adot', 'sack_rate', 'qb_hit_rate', 'scramble_rate', 'shotgun_rate', 'no_huddle_rate',
    'explosive_pass_rate', 'explosive_rush_rate', 'redzone_epa', 'series_success', 'yac',
    'pressure_rate', 'box_count', 'pass_rushers', 'blitz_rate', 'time_to_throw',
    'man_rate', 'zone_rate', 'cover1_rate', 'cover2_rate', 'cover3_rate',
    'pers_11_rate', 'pers_12_rate', 'pers_2rb_rate', 'play_action_rate', 'rpo_rate',
    'screen_rate', 'motion_rate', 'out_of_pocket_rate', 'throwaway_rate', 'catchable_rate',
    'contested_rate', 'int_worthy_rate', 'ftn_box', 'trick_rate'];
  const records = [];
  for (const row of satelliteRows('lineHistory',
    `SELECT season,week,team,side,${columns.join(',')} FROM adv_team_week
     WHERE season>=? AND week BETWEEN 1 AND 18 ORDER BY season DESC,week DESC`, SATELLITE_FLOOR)) {
    const prefix = row.side === 'def' ? 'advdef_' : 'advoff_';
    const values = {};
    for (const column of columns) { const value = finite(row[column]); if (value != null) values[`${prefix}${column}`] = value; }
    if (Object.keys(values).length) records.push({ key: row.team, season: row.season, week: row.week, values });
  }
  advTeamCache = indexByEntity(records);
  return advTeamCache;
}

/* ------------------------------------------- A: participation play detail */

const COVER_SHELLS = Object.freeze(['COVER_0', 'COVER_1', 'COVER_2', 'COVER_3', 'COVER_4', 'COVER_6', '2_MAN']);

/** "1 RB, 1 TE, 3 WR" -> 11 personnel. Anything unparsed lands in `other`. */
function offensePersonnelGroup(text) {
  if (!text) return null;
  const backs = Number(/(\d+)\s*RB/.exec(text)?.[1] ?? NaN);
  const ends = Number(/(\d+)\s*TE/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(backs) || !Number.isFinite(ends)) return null;
  const code = `${backs}${ends}`;
  return ['11', '12', '13', '21', '22', '10', '20'].includes(code) ? code : 'other';
}

/** "4 DL, 2 LB, 5 DB" -> nickel. Five-plus DBs is the thing that moves usage. */
function defensePersonnelGroup(text) {
  if (!text) return null;
  const backs = Number(/(\d+)\s*DB/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(backs)) return null;
  return backs <= 4 ? 'base' : backs === 5 ? 'nickel' : 'dime';
}

const ROUTE_POSITIONS = new Set(['WR', 'TE', 'RB', 'FB']);

let rosterPositionCache = null;
/**
 * gsis id + season -> position, from roster_weekly.
 *
 * pbp_participation only carries offense_positions from 2023 onward; before
 * that the participant list is ids with no positions at all. Without this the
 * man/zone split silently covers 2023-2025 only, which would leave the fit
 * seasons empty and make the whole family untestable -- it is how the first
 * run of this backfill produced zero player observations for 2021 and 2022.
 */
function rosterPosition() {
  if (rosterPositionCache) return rosterPositionCache;
  rosterPositionCache = new Map();
  for (const row of satelliteRows('nflverse', `SELECT DISTINCT season, gsis_id, position
    FROM roster_weekly WHERE season>=? AND gsis_id IS NOT NULL AND position IS NOT NULL`, SATELLITE_FLOOR)) {
    rosterPositionCache.set(`${row.gsis_id}|${row.season}`, row.position);
  }
  return rosterPositionCache;
}

let participationCache = null;
/**
 * One pass over pbp_participation joined to play_by_play, producing three
 * things at once because they share the scan: team offensive tendencies,
 * team defensive tendencies, and the per-receiver man/zone split.
 *
 * Rows are consumed with iterate() rather than all(): the joined result is
 * ~300k rows carrying the full 11-man participant string, and materialising
 * that costs well over a hundred megabytes for aggregates that fit in a few.
 */
function participation() {
  if (participationCache) return participationCache;
  const handle = satellite('nflverse');
  if (!handle) {
    participationCache = { team: new Map(), player: new Map(), scanned: 0, labeled: 0 };
    return participationCache;
  }
  const team = new Map(), player = new Map();
  const teamBucket = (key, season, week) => {
    const id = `${key}|${season}|${week}`;
    let bucket = team.get(id);
    if (!bucket) { bucket = { key, season, week, n: {}, s: {} }; team.set(id, bucket); }
    return bucket;
  };
  const add = (bucket, field, value) => {
    if (value == null) return;
    bucket.s[field] = (bucket.s[field] ?? 0) + value;
    bucket.n[field] = (bucket.n[field] ?? 0) + 1;
  };
  let scanned = 0, labeled = 0;
  let statement;
  try {
    statement = handle.prepare(`
      SELECT b.season season, b.week week, b.posteam posteam, b.defteam defteam,
             p.defense_man_zone_type mz, p.defense_coverage_type shell,
             p.defenders_in_box box, p.number_of_pass_rushers rushers,
             p.was_pressure pressure, p.time_to_throw ttt,
             p.offense_personnel off_pers, p.defense_personnel def_pers,
             p.offense_players off_players, p.offense_positions off_positions,
             b.qb_dropback dropback, b.pass_attempt pass_attempt,
             b.receiver_player_id receiver, b.complete_pass complete,
             b.receiving_yards rec_yards
      FROM pbp_participation p
      JOIN play_by_play b ON b.game_id = p.nflverse_game_id AND b.play_id = p.play_id
      WHERE b.season >= ? AND b.season_type = 'REG' AND b.posteam IS NOT NULL
        AND b.defteam IS NOT NULL AND b.week BETWEEN 1 AND 18
        AND (b.qb_dropback = 1 OR b.rush_attempt = 1)`);
  } catch (error) {
    satelliteErrors.set('nflverse:participation', error.message);
    participationCache = { team: new Map(), player: new Map(), scanned: 0, labeled: 0 };
    return participationCache;
  }
  for (const row of statement.iterate(SATELLITE_FLOOR)) {
    scanned++;
    const offense = teamBucket(row.posteam, row.season, row.week);
    const defense = teamBucket(row.defteam, row.season, row.week);
    const dropback = Number(row.dropback) === 1;
    add(offense, 'off_box_faced', finite(row.box));
    add(defense, 'def_box', finite(row.box));
    if (dropback) {
      add(offense, 'off_rushers_faced', finite(row.rushers));
      add(defense, 'def_rushers', finite(row.rushers));
      add(offense, 'off_pressure_allowed', finite(row.pressure));
      add(defense, 'def_pressure', finite(row.pressure));
      add(offense, 'off_time_to_throw', finite(row.ttt));
      add(defense, 'def_time_to_throw_allowed', finite(row.ttt));
    }
    const offGroup = offensePersonnelGroup(row.off_pers);
    if (offGroup) for (const code of ['11', '12', '13', '21', '22', '10', '20', 'other'])
      add(offense, `off_pers_${code}`, offGroup === code ? 1 : 0);
    const defGroup = defensePersonnelGroup(row.def_pers);
    if (defGroup) for (const code of ['base', 'nickel', 'dime']) {
      add(defense, `def_pers_${code}`, defGroup === code ? 1 : 0);
      add(offense, `off_pers_faced_${code}`, defGroup === code ? 1 : 0);
    }
    if (!row.mz) continue;                       // unlabeled play: no shell evidence
    labeled++;
    const isMan = row.mz === 'MAN_COVERAGE';
    add(offense, 'off_man_faced', isMan ? 1 : 0);
    add(defense, 'def_man', isMan ? 1 : 0);
    if (row.shell) for (const shell of COVER_SHELLS) {
      const key = shell.toLowerCase();
      add(offense, `off_faced_${key}`, row.shell === shell ? 1 : 0);
      add(defense, `def_${key}`, row.shell === shell ? 1 : 0);
    }
    if (!dropback || !row.off_players) continue;
    // Man/zone split, per receiver. A skill player on the field for a dropback
    // is counted as having run a route; some of those are pass protection, and
    // that error is the same under man and under zone, so it biases the level
    // of yards-per-route but not the man-minus-zone difference this is for.
    const ids = row.off_players.split(';');
    const positions = row.off_positions ? row.off_positions.split(';') : null;
    if (positions && positions.length !== ids.length) continue;
    const side = isMan ? 'man' : 'zone';
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (!id) continue;
      const position = positions ? positions[index] : rosterPosition().get(`${id}|${row.season}`);
      if (!ROUTE_POSITIONS.has(position)) continue;
      const stamp = `${id}|${row.season}|${row.week}`;
      let bucket = player.get(stamp);
      if (!bucket) { bucket = { key: id, season: row.season, week: row.week, c: {} }; player.set(stamp, bucket); }
      bucket.c[`${side}_routes`] = (bucket.c[`${side}_routes`] ?? 0) + 1;
      if (row.receiver && row.receiver === id) {
        bucket.c[`${side}_targets`] = (bucket.c[`${side}_targets`] ?? 0) + 1;
        bucket.c[`${side}_rec`] = (bucket.c[`${side}_rec`] ?? 0) + (Number(row.complete) === 1 ? 1 : 0);
        bucket.c[`${side}_yards`] = (bucket.c[`${side}_yards`] ?? 0) + (finite(row.rec_yards) ?? 0);
      }
    }
  }
  const teamRecords = [];
  for (const bucket of team.values()) {
    // Every accumulated field becomes its per-play mean plus the number of
    // plays it was observed on. For an indicator (man faced, 11 personnel)
    // that mean is a rate; for box count or time to throw it is an average.
    // The denominator travels with it so a two-play week cannot look certain.
    const values = {};
    for (const [field, count] of Object.entries(bucket.n)) {
      values[`part_${field}`] = bucket.s[field] / count;
      values[`part_${field}_n`] = count;
    }
    // Zone is the complement of man on labeled plays, carried explicitly so a
    // consumer never has to know that.
    if (values.part_off_man_faced != null) values.part_off_zone_faced = 1 - values.part_off_man_faced;
    if (values.part_def_man != null) values.part_def_zone = 1 - values.part_def_man;
    teamRecords.push({ key: bucket.key, season: bucket.season, week: bucket.week, values });
  }
  const playerRecords = [];
  for (const bucket of player.values()) {
    const c = bucket.c;
    const manRoutes = c.man_routes ?? 0, zoneRoutes = c.zone_routes ?? 0;
    const values = {
      mz_man_routes: manRoutes, mz_zone_routes: zoneRoutes,
      mz_man_targets: c.man_targets ?? 0, mz_zone_targets: c.zone_targets ?? 0,
      mz_man_rec: c.man_rec ?? 0, mz_zone_rec: c.zone_rec ?? 0,
      mz_man_yards: c.man_yards ?? 0, mz_zone_yards: c.zone_yards ?? 0
    };
    // Weekly rates are emitted too, but the counts are the load-bearing
    // outputs: mean_6 of a weekly ratio is not the ratio the analyst wants,
    // whereas mean_6(yards)/mean_6(routes) is.
    const ypr_man = rate(values.mz_man_yards, manRoutes), ypr_zone = rate(values.mz_zone_yards, zoneRoutes);
    if (ypr_man != null) values.mz_man_yards_per_route = ypr_man;
    if (ypr_zone != null) values.mz_zone_yards_per_route = ypr_zone;
    if (ypr_man != null && ypr_zone != null) values.mz_yards_per_route_gap = ypr_man - ypr_zone;
    const tr_man = rate(values.mz_man_targets, manRoutes), tr_zone = rate(values.mz_zone_targets, zoneRoutes);
    if (tr_man != null) values.mz_man_target_rate = tr_man;
    if (tr_zone != null) values.mz_zone_target_rate = tr_zone;
    if (tr_man != null && tr_zone != null) values.mz_target_rate_gap = tr_man - tr_zone;
    const cr_man = rate(values.mz_man_rec, values.mz_man_targets), cr_zone = rate(values.mz_zone_rec, values.mz_zone_targets);
    if (cr_man != null) values.mz_man_catch_rate = cr_man;
    if (cr_zone != null) values.mz_zone_catch_rate = cr_zone;
    playerRecords.push({ key: bucket.key, season: bucket.season, week: bucket.week, values });
  }
  participationCache = { team: indexByEntity(teamRecords), player: indexByEntity(playerRecords), scanned, labeled };
  return participationCache;
}

/* --------------------------------------------------- A: O-line continuity */

let olCache = null;
/**
 * Same five offensive line starters as last week?
 *
 * A shuffled line is a real, short-lived shock to both the run game and the
 * quarterback's time to throw, and nothing anywhere in the app carries it. The
 * five starters are the five OL by snap count, which is how a depth chart
 * would define them after the fact and is available before the next kickoff.
 */
function olContinuity() {
  if (olCache) return olCache;
  const source = satelliteRows('nflverse', `SELECT season,week,team,player,offense_snaps
    FROM snap_counts WHERE season>=? AND game_type='REG' AND position IN ('T','G','C','OL','OT','OG')
      AND offense_snaps > 0 ORDER BY season,week,team,offense_snaps DESC`, SATELLITE_FLOOR);
  const byTeamWeek = new Map();
  for (const row of source) {
    const id = `${row.team}|${row.season}|${row.week}`;
    const list = byTeamWeek.get(id) ?? []; list.push(row); byTeamWeek.set(id, list);
  }
  const startersOf = new Map();
  for (const [id, list] of byTeamWeek) {
    startersOf.set(id, { five: new Set(list.slice(0, 5).map(item => item.player)),
      snaps: list.slice(0, 5).reduce((sum, item) => sum + (item.offense_snaps ?? 0), 0) });
  }
  const records = [];
  for (const [id, current] of startersOf) {
    const [team, season, week] = id.split('|');
    const previous = startersOf.get(`${team}|${season}|${Number(week) - 1}`);
    const values = { ol_starter_snaps: current.snaps, ol_starters_identified: current.five.size };
    if (previous) {
      let shared = 0;
      for (const name of current.five) if (previous.five.has(name)) shared++;
      values.ol_continuity = shared / 5;
      values.ol_changes = 5 - shared;
      values.ol_same_five = shared === 5 ? 1 : 0;
    }
    records.push({ key: team, season: Number(season), week: Number(week), values });
  }
  olCache = indexByEntity(records);
  return olCache;
}

/* ------------------------------------------------------ C: regularised APM */

let playerValueCache = null;
/**
 * player_value_weekly: regularised adjusted plus-minus per player-week,
 * validated out of sample at QB r=0.416 against a 0.10 placebo. `stale` marks
 * a row carried forward rather than re-estimated, and is kept as a feature
 * rather than dropped so the transforms can see the difference.
 */
function playerValue() {
  if (playerValueCache) return playerValueCache;
  const records = [];
  for (const row of satelliteRows('playerValue', `SELECT season,week,player_id,value,se,n_plays,
      value_pass,value_rush,value_rec,value_epa,se_epa,stale FROM player_value_weekly
    WHERE season>=? AND week BETWEEN 1 AND 18`, SATELLITE_FLOOR)) {
    const values = {};
    for (const field of ['value', 'se', 'n_plays', 'value_pass', 'value_rush', 'value_rec', 'value_epa', 'se_epa', 'stale']) {
      const value = finite(row[field]); if (value != null) values[`apm_${field}`] = value;
    }
    if (Object.keys(values).length) records.push({ key: String(row.player_id), season: row.season, week: row.week, values });
  }
  playerValueCache = indexByEntity(records);
  return playerValueCache;
}

/**
 * Which satellites this process actually has.
 *
 * A satellite that cannot be opened degrades the vector silently: the version
 * string still says v2, but the frozen row carries a different feature surface
 * from one built on a machine where the file was present. The version cannot
 * distinguish the two, so the status endpoint has to. `unopened` is not a
 * failure -- nothing has needed that source yet in this process.
 */
export function satelliteStatus() {
  const loaded = [], failed = {}, unopened = [];
  for (const name of Object.keys(SATELLITES)) {
    if (!satelliteHandles.has(name)) { unopened.push(name); continue; }
    if (satelliteHandles.get(name)) loaded.push(name); else failed[name] = satelliteErrors.get(name);
  }
  for (const [key, message] of satelliteErrors) if (key.includes(':')) failed[key] = message;
  return { paths: SATELLITES, loaded, failed, unopened };
}

/** What the satellites actually delivered, per season, for the study writeup. */
export function satelliteCoverage(seasons = [2021, 2022, 2023, 2024, 2025]) {
  const part = participation();
  const count = (index, season) => {
    let entities = 0, observations = 0;
    for (const list of index.values()) {
      const hits = list.filter(item => item.season === season);
      if (hits.length) { entities++; observations += hits.length; }
    }
    return { entities, observations };
  };
  const manZoneStability = (season, minimum = 20) => {
    let eligible = 0, total = 0;
    for (const list of part.player.values()) {
      const hits = list.filter(item => item.season === season);
      if (!hits.length) continue;
      total++;
      const man = hits.reduce((sum, item) => sum + (item.values.mz_man_routes ?? 0), 0);
      const zone = hits.reduce((sum, item) => sum + (item.values.mz_zone_routes ?? 0), 0);
      if (man >= minimum && zone >= minimum) eligible++;
    }
    return { receivers_with_routes: total, stable_split: eligible, minimum_routes_each: minimum };
  };
  return {
    paths: SATELLITES,
    errors: Object.fromEntries(satelliteErrors),
    participation_plays_scanned: part.scanned,
    participation_plays_with_shell_label: part.labeled,
    per_season: seasons.map(season => ({ season,
      adv_team_week: count(advTeamWeek(), season),
      participation_team: count(part.team, season),
      participation_player: count(part.player, season),
      ol_continuity: count(olContinuity(), season),
      player_value: count(playerValue(), season),
      man_zone_split: manZoneStability(season) }))
  };
}

function kickoff(season, week, team) {
  const game = rows(`SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`,
  season, week, team)[0];
  return game?.gameday
    ? nflKickoffDate(game.gameday, game.gametime || '23:59')?.toISOString() ?? `${game.gameday}T23:59:59Z`
    : `${season}-W${week}-pregame`;
}

function numericObject(object, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(result, numericObject(value, `${prefix}${key}_`));
    else if (finite(value) != null) result[`${prefix}${key}`] = finite(value);
  }
  return result;
}

function slope(values) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2, yMean = mean(values);
  let numerator = 0, denominator = 0;
  for (let i = 0; i < values.length; i++) {
    numerator += (i - xMean) * (values[i] - yMean); denominator += (i - xMean) ** 2;
  }
  return denominator ? numerator / denominator : null;
}

function ewma(values, alpha = 0.35) {
  if (!values.length) return null;
  let state = values.at(-1);
  for (let i = values.length - 2; i >= 0; i--) state = alpha * values[i] + (1 - alpha) * state;
  return state;
}

function metricUniverse(history) {
  const keys = new Set();
  for (const observation of history) for (const key of Object.keys(observation.values)) keys.add(key);
  return [...keys].sort();
}

function transforms(history, leagueLatest = new Map()) {
  const vector = {}, missing = [];
  for (const metric of metricUniverse(history)) {
    const observations = history.map(item => item.values[metric]).filter(value => finite(value) != null);
    const recent = observations.slice(0, 12), six = recent.slice(0, 6);
    const latest = recent[0] ?? null, prior = recent[1] ?? null;
    const league = leagueLatest.get(metric) ?? [];
    const leagueMean = mean(league), leagueSd = sd(league);
    const values = {
      latest, mean_3: mean(recent.slice(0, 3)), mean_6: mean(six), mean_12: mean(recent),
      ewma_6: ewma(six), slope_6: slope([...six].reverse()), sd_6: sd(six),
      min_6: six.length ? Math.min(...six) : null, max_6: six.length ? Math.max(...six) : null,
      delta_1: latest != null && prior != null ? latest - prior : null,
      z_latest: latest != null && leagueMean != null && leagueSd > 1e-9 ? (latest - leagueMean) / leagueSd : null,
      coverage_12: recent.length / 12, missing: latest == null ? 1 : 0
    };
    for (const transform of TRANSFORMS) {
      const id = `${metric}__${transform}`, value = r6(values[transform]);
      if (value == null) missing.push(id); else vector[id] = value;
    }
  }
  return { vector, missing, raw_metrics: metricUniverse(history).length };
}

function register(entityType, sourceFamily, vector) {
  const now = new Date().toISOString();
  for (const id of Object.keys(vector)) {
    const marker = id.lastIndexOf('__'), metric = id.slice(0, marker), transform = id.slice(marker + 2);
    run(`INSERT OR IGNORE INTO nfl_feature_dictionary
      (feature_id,entity_type,source_family,source_metric,transform,version,description,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, `${entityType}:${id}`, entityType, sourceFamily, metric, transform,
    WEEKLY_FEATURE_STORE_VERSION, `${transform} of cutoff-safe ${metric} history`, now);
  }
}

function teamHistory(season, week, team, limit = 12) {
  const base = rows(`SELECT season,week,features FROM nfl_team_week_features
    WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START, season, season, week, limit)
    .map(item => ({ season: item.season, week: item.week, values: numericObject(parse(item.features)) }));
  const byStamp = new Map(base.map(item => [`${item.season}|${item.week}`, item]));
  const merge = (items, prefix = '') => {
    for (const item of items) {
      const key = `${item.season}|${item.week}`;
      const target = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
      Object.assign(target.values, numericObject(item, prefix));
      delete target.values[`${prefix}season`]; delete target.values[`${prefix}week`];
      byStamp.set(key, target);
    }
  };
  merge(optionalRows(`SELECT season,week,
      AVG(offense_pct) avg_offense_participation,AVG(defense_pct) avg_defense_participation,
      SUM(offense_snaps) offense_player_snaps,SUM(defense_snaps) defense_player_snaps,
      SUM(CASE WHEN offense_pct>=0.5 THEN 1 ELSE 0 END) offensive_core_players,
      SUM(CASE WHEN defense_pct>=0.5 THEN 1 ELSE 0 END) defensive_core_players
    FROM nfl_snaps WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    GROUP BY season,week ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'snap_');
  merge(optionalRows(`SELECT season,week,COUNT(*) listed,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='out' THEN 1 ELSE 0 END) out_count,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='doubtful' THEN 1 ELSE 0 END) doubtful_count,
      SUM(CASE WHEN lower(COALESCE(report_status,''))='questionable' THEN 1 ELSE 0 END) questionable_count,
      SUM(CASE WHEN lower(COALESCE(practice_status,'')) LIKE '%did not%' THEN 1 ELSE 0 END) did_not_practice
    FROM nfl_injuries WHERE team=? AND season>=? AND (season<? OR (season=? AND week<?))
    GROUP BY season,week ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'injury_');
  merge(optionalRows(`SELECT season,CAST(substr(game_id,6,2) AS INTEGER) week,
      AVG(CASE WHEN offense_formation='SHOTGUN' THEN 1.0 ELSE 0.0 END) shotgun_share,
      AVG(CASE WHEN offense_formation='EMPTY' THEN 1.0 ELSE 0.0 END) empty_share,
      AVG(CASE WHEN offense_formation='SINGLEBACK' THEN 1.0 ELSE 0.0 END) singleback_share,
      AVG(defenders_in_box) defenders_in_box,AVG(pass_rushers) pass_rushers,COUNT(*) plays
    FROM nfl_play_formations WHERE possession=? AND season>=? AND
      (season<? OR (season=? AND CAST(substr(game_id,6,2) AS INTEGER)<?))
    GROUP BY season,CAST(substr(game_id,6,2) AS INTEGER)
    ORDER BY season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'formation_');
  merge(optionalRows(`SELECT f.season,CAST(substr(f.game_id,6,2) AS INTEGER) week,
      AVG(c.motion) motion_share,AVG(c.play_action) play_action_share,AVG(c.screen) screen_share,
      AVG(c.rpo) rpo_share,AVG(c.out_of_pocket) out_of_pocket_share,
      AVG(c.contested) contested_share,AVG(c.defense_box) charted_box,COUNT(*) charted_plays
    FROM nfl_play_formations f JOIN nfl_play_charting c
      ON c.game_id=f.game_id AND c.play_id=f.play_id
    WHERE f.possession=? AND f.season>=? AND (f.season<? OR
      (f.season=? AND CAST(substr(f.game_id,6,2) AS INTEGER)<?))
    GROUP BY f.season,CAST(substr(f.game_id,6,2) AS INTEGER)
    ORDER BY f.season DESC,week DESC LIMIT ?`, team, TRUSTED_HISTORY_START,
  season, season, week, limit), 'charting_');
  // Satellites. Each of these supplies scheme evidence the store's own
  // database does not have before 2024, and mergePrior is what keeps them
  // strictly earlier than the target week.
  mergePrior(byStamp, advTeamWeek().get(team), season, week, limit);
  mergePrior(byStamp, participation().team.get(team), season, week, limit);
  mergePrior(byStamp, olContinuity().get(team), season, week, limit);
  return [...byStamp.values()].sort((a, b) => b.season - a.season || b.week - a.week).slice(0, limit);
}

function teamLeagueLatest(season, week) {
  const latest = rows(`SELECT f.team,f.features FROM nfl_team_week_features f
    JOIN (SELECT team,MAX(season*100+week) stamp FROM nfl_team_week_features
      WHERE season>=? AND (season<? OR (season=? AND week<?)) GROUP BY team) x
    ON x.team=f.team AND x.stamp=f.season*100+f.week`, TRUSTED_HISTORY_START, season, season, week);
  const map = new Map();
  for (const item of latest) for (const [metric, value] of Object.entries(numericObject(parse(item.features)))) {
    const list = map.get(metric) ?? []; list.push(value); map.set(metric, list);
  }
  return map;
}

export function buildTeamFeatureVector(season, week, team) {
  const history = teamHistory(season, week, team);
  if (!history.length) return { error: 'no earlier team-week observations' };
  const result = transforms(history, teamLeagueLatest(season, week));
  const cutoff = kickoff(season, week, team), evidenceHash = sha({ season, week, team, cutoff, history });
  return { version: WEEKLY_FEATURE_STORE_VERSION, entity_type: 'team', season, week, team,
    cutoff, evidence_hash: evidenceHash, feature_count: Object.keys(result.vector).length,
    raw_metrics: result.raw_metrics, coverage: result.raw_metrics
      ? Object.keys(result.vector).length / (result.raw_metrics * TRANSFORMS.length) : 0,
    vector: result.vector, missing: result.missing };
}

export function freezeTeamFeatureVector(season, week, team) {
  const existing = rows(`SELECT * FROM nfl_team_feature_vectors WHERE season=? AND week=? AND team=? AND version=?`,
  season, week, team, WEEKLY_FEATURE_STORE_VERSION)[0];
  if (existing) return { existing: true, ...existing, vector: parse(existing.vector_json) };
  const built = buildTeamFeatureVector(season, week, team);
  if (built.error) return built;
  register('team', 'team_week+snaps+injuries+adv+participation+ol', built.vector);
  run(`INSERT INTO nfl_team_feature_vectors
    (season,week,team,version,cutoff,evidence_hash,feature_count,coverage,vector_json,missing_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, season, week, team, WEEKLY_FEATURE_STORE_VERSION,
  built.cutoff, built.evidence_hash, built.feature_count, built.coverage,
  JSON.stringify(built.vector), JSON.stringify(built.missing), new Date().toISOString());
  return { existing: false, ...built };
}

export function getFrozenTeamFeatureVector(season, week, team) {
  const item = rows(`SELECT * FROM nfl_team_feature_vectors
    WHERE season=? AND week=? AND team=? AND version=?`,
  season, week, team, WEEKLY_FEATURE_STORE_VERSION)[0];
  return item ? { ...item, vector: parse(item.vector_json), missing: parse(item.missing_json, []) } : null;
}

function playerHistory(season, week, playerId, playerName, limit = 12) {
  const base = rows(`SELECT season,week,position,features FROM nfl_player_week_features
    WHERE player_id=? AND season>=? AND (season<? OR (season=? AND week<?))
    ORDER BY season DESC,week DESC LIMIT ?`, playerId, TRUSTED_HISTORY_START,
  season, season, week, limit);
  const byStamp = new Map(base.map(item => [`${item.season}|${item.week}`, {
    season: item.season, week: item.week, position: item.position,
    values: numericObject(parse(item.features), 'base_') }]));
  for (const item of rows(`SELECT season,week,kind,stats FROM nfl_ngs WHERE player_id=?
    AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC`,
  playerId, TRUSTED_HISTORY_START, season, season, week)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(parse(item.stats), `ngs_${item.kind}_`)); byStamp.set(key, row);
  }
  if (playerName) for (const item of rows(`SELECT season,week,kind,stats FROM nfl_pfr_adv
    WHERE player_name=? AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC`,
  playerName, TRUSTED_HISTORY_START, season, season, week)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(parse(item.stats), `pfr_${item.kind}_`)); byStamp.set(key, row);
  }
  if (playerName) for (const item of optionalRows(`SELECT season,week,offense_snaps,offense_pct,
      defense_snaps,defense_pct,st_pct FROM nfl_snaps WHERE player=?
      AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT ?`,
  playerName, TRUSTED_HISTORY_START, season, season, week, limit)) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    Object.assign(row.values, numericObject(item, 'snap_'));
    delete row.values.snap_season; delete row.values.snap_week; byStamp.set(key, row);
  }
  for (const item of optionalRows(`SELECT season,week,report_status,practice_status FROM nfl_injuries
      WHERE gsis_id=? AND season>=? AND (season<? OR (season=? AND week<?))
      ORDER BY season DESC,week DESC LIMIT ?`, playerId, TRUSTED_HISTORY_START,
  season, season, week, limit)) {
    const severity = value => /out/i.test(value ?? '') ? 1 : /doubtful|did not/i.test(value ?? '') ? 0.75
      : /questionable|limited/i.test(value ?? '') ? 0.4 : 0;
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    row.values.injury_game_status_severity = severity(item.report_status);
    row.values.injury_practice_status_severity = severity(item.practice_status); byStamp.set(key, row);
  }
  const grades = rows(`SELECT season,week,overall_grade,facets_json FROM nfl_external_player_grades
    WHERE provider='pff' AND (player_id=? OR player_name=?)
      AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT ?`,
  playerId, playerName ?? '', TRUSTED_HISTORY_START, season, season, week, limit);
  for (const item of grades) {
    const key = `${item.season}|${item.week}`;
    const row = byStamp.get(key) ?? { season: item.season, week: item.week, values: {} };
    row.values.pff_overall_grade = finite(item.overall_grade);
    Object.assign(row.values, numericObject(parse(item.facets_json), 'pff_')); byStamp.set(key, row);
  }
  // Satellites: regularised APM, and the per-receiver man/zone split. Both are
  // keyed on the gsis id, which is what nfl_player_week_features.player_id is.
  mergePrior(byStamp, playerValue().get(String(playerId)), season, week, limit);
  mergePrior(byStamp, participation().player.get(String(playerId)), season, week, limit);
  return [...byStamp.values()].sort((a, b) => b.season - a.season || b.week - a.week).slice(0, limit);
}

export function buildPlayerFeatureVector(season, week, playerId, { playerName = null,
  team = null, position = null } = {}) {
  const history = playerHistory(season, week, String(playerId), playerName);
  if (!history.length) return { error: 'no earlier player observations' };
  const result = transforms(history, new Map()), cutoff = team ? kickoff(season, week, team) : `${season}-W${week}-pregame`;
  const evidenceHash = sha({ season, week, playerId, cutoff, history });
  return { version: WEEKLY_FEATURE_STORE_VERSION, entity_type: 'player', season, week,
    player_id: String(playerId), player_name: playerName, team, position: position ?? history[0]?.position,
    cutoff, evidence_hash: evidenceHash, feature_count: Object.keys(result.vector).length,
    raw_metrics: result.raw_metrics, coverage: result.raw_metrics
      ? Object.keys(result.vector).length / (result.raw_metrics * TRANSFORMS.length) : 0,
    vector: result.vector, missing: result.missing };
}

export function freezePlayerFeatureVector(season, week, playerId, options = {}) {
  const existing = rows(`SELECT * FROM nfl_player_feature_vectors
    WHERE season=? AND week=? AND player_id=? AND version=?`,
  season, week, String(playerId), WEEKLY_FEATURE_STORE_VERSION)[0];
  if (existing) return { existing: true, ...existing, vector: parse(existing.vector_json) };
  const built = buildPlayerFeatureVector(season, week, playerId, options);
  if (built.error) return built;
  register('player', 'player+ngs+pfr+pff+apm+manzone', built.vector);
  run(`INSERT INTO nfl_player_feature_vectors
    (season,week,player_id,player_name,position,team,version,cutoff,evidence_hash,feature_count,
     coverage,vector_json,missing_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  season, week, String(playerId), built.player_name, built.position, built.team,
  WEEKLY_FEATURE_STORE_VERSION, built.cutoff, built.evidence_hash, built.feature_count,
  built.coverage, JSON.stringify(built.vector), JSON.stringify(built.missing), new Date().toISOString());
  return { existing: false, ...built };
}

export function getFrozenPlayerFeatureVector(season, week, playerId) {
  const item = rows(`SELECT * FROM nfl_player_feature_vectors
    WHERE season=? AND week=? AND player_id=? AND version=?`,
  season, week, String(playerId), WEEKLY_FEATURE_STORE_VERSION)[0];
  return item ? { ...item, vector: parse(item.vector_json), missing: parse(item.missing_json, []) } : null;
}

export function backfillTeamFeatureVectors({ seasons = [2021, 2022, 2023, 2024, 2025, 2026],
  startWeek = 5, endWeek = 18, onProgress = null } = {}) {
  const targets = rows(`SELECT DISTINCT season,week,team FROM game_lines
    WHERE season IN (${seasons.map(() => '?').join(',')}) AND week BETWEEN ? AND ?
    ORDER BY season,week,team`, ...seasons, startWeek, endWeek);
  let frozen = 0, existing = 0;
  const failures = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const result = freezeTeamFeatureVector(target.season, target.week, target.team);
    if (result.error) failures.push({ ...target, error: result.error });
    else if (result.existing) existing++;
    else frozen++;
    if (onProgress && (index % 25 === 0 || index === targets.length - 1)) {
      onProgress({ current: index + 1, total: targets.length, frozen, existing,
        failures: failures.length, season: target.season, week: target.week, team: target.team });
    }
  }
  return { version: WEEKLY_FEATURE_STORE_VERSION, targets: targets.length, frozen, existing, failures };
}

export function backfillPlayerFeatureVectors({ seasons = [2021, 2022, 2023, 2024, 2025, 2026],
  startWeek = 5, endWeek = 18, teams = null, onProgress = null } = {}) {
  const teamFilter = teams?.length ? ` AND current.team IN (${teams.map(() => '?').join(',')})` : '';
  const targets = rows(`SELECT current.season,current.week,current.player_id,current.player_name,
      current.team,current.position FROM nfl_player_week_features current
    WHERE current.season IN (${seasons.map(() => '?').join(',')})
      AND current.week BETWEEN ? AND ?${teamFilter}
    ORDER BY current.season,current.week,current.team,current.player_id`,
  ...seasons, startWeek, endWeek, ...(teams ?? []));
  let frozen = 0, existing = 0;
  const failures = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const result = freezePlayerFeatureVector(target.season, target.week, target.player_id, {
      playerName: target.player_name, team: target.team, position: target.position
    });
    if (result.error) failures.push({ ...target, error: result.error });
    else if (result.existing) existing++;
    else frozen++;
    if (onProgress && (index % 100 === 0 || index === targets.length - 1)) {
      onProgress({ current: index + 1, total: targets.length, frozen, existing,
        failures: failures.length, season: target.season, week: target.week,
        team: target.team, player: target.player_name });
    }
  }
  return { version: WEEKLY_FEATURE_STORE_VERSION, targets: targets.length, frozen, existing, failures };
}

/** Freeze the exact team/player state that every model will share next week. */
export function freezeWeeklyFeatureState(season, week) {
  const teams = rows(`SELECT DISTINCT team FROM game_lines WHERE season=? AND week=? ORDER BY team`,
  season, week).map(item => item.team);
  if (!teams.length) return { version: WEEKLY_FEATURE_STORE_VERSION, season, week,
    blocked: true, reason: 'target-week schedule is not loaded' };
  const teamResults = teams.map(team => freezeTeamFeatureVector(season, week, team));
  const latestPlayers = optionalRows(`SELECT p.player_id,p.player_name,p.team,p.position
    FROM nfl_player_week_features p JOIN (
      SELECT player_id,MAX(season*100+week) stamp FROM nfl_player_week_features
      WHERE season>=? AND (season<? OR (season=? AND week<?)) GROUP BY player_id
    ) latest ON latest.player_id=p.player_id AND latest.stamp=p.season*100+p.week
    WHERE p.team IN (${teams.map(() => '?').join(',')})
    ORDER BY p.team,p.player_id`, TRUSTED_HISTORY_START, season, season, week, ...teams);
  const playerResults = latestPlayers.map(player => freezePlayerFeatureVector(season, week,
    player.player_id, { playerName: player.player_name, team: player.team, position: player.position }));
  const summarize = results => ({ targets: results.length,
    frozen: results.filter(item => !item.error && !item.existing).length,
    existing: results.filter(item => item.existing).length,
    failures: results.filter(item => item.error).map(item => item.error),
    avg_features: results.filter(item => Number.isFinite(item.feature_count)).length
      ? r6(mean(results.filter(item => Number.isFinite(item.feature_count)).map(item => item.feature_count))) : null,
    avg_coverage: results.filter(item => Number.isFinite(item.coverage)).length
      ? r6(mean(results.filter(item => Number.isFinite(item.coverage)).map(item => item.coverage))) : null });
  return { version: WEEKLY_FEATURE_STORE_VERSION, season, week,
    teams: summarize(teamResults), players: summarize(playerResults),
    contract: 'All observations are strictly earlier than the target week and frozen before downstream inference.' };
}

export function weeklyFeatureStoreStatus() {
  const dictionary = rows(`SELECT entity_type,COUNT(*) features,COUNT(DISTINCT source_metric) raw_metrics
    FROM nfl_feature_dictionary WHERE version=? GROUP BY entity_type`, WEEKLY_FEATURE_STORE_VERSION);
  const teams = rows(`SELECT season,COUNT(*) vectors,ROUND(AVG(feature_count),1) avg_features,
      ROUND(AVG(coverage),3) avg_coverage FROM nfl_team_feature_vectors
    WHERE version=? GROUP BY season ORDER BY season`, WEEKLY_FEATURE_STORE_VERSION);
  const players = rows(`SELECT season,COUNT(*) vectors,ROUND(AVG(feature_count),1) avg_features,
      ROUND(AVG(coverage),3) avg_coverage FROM nfl_player_feature_vectors
    WHERE version=? GROUP BY season ORDER BY season`, WEEKLY_FEATURE_STORE_VERSION);
  return { version: WEEKLY_FEATURE_STORE_VERSION, transforms: TRANSFORMS,
    trusted_history_start: TRUSTED_HISTORY_START,
    declared_raw_current: { team: 183, player: 67, next_gen: 23, pfr_advanced: 30 },
    potential: { team: 183 * TRANSFORMS.length, player_public_plus_licensed: 120 * TRANSFORMS.length },
    dictionary, team_vectors: teams, player_vectors: players,
    satellites: satelliteStatus(),
    policy: 'Feature count is reported with coverage; missing values remain explicit and never become zero evidence. Earlier quarantined seasons are not used in rolling state.' };
}

export const __test = { transforms, slope, ewma, numericObject, TRANSFORMS };
