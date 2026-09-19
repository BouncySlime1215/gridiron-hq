#!/usr/bin/env node
/**
 * Does the frozen weekly feature vector discriminate a player's GOOD weeks
 * from his BAD ones?
 *
 * The question is narrow on purpose. Measured 2026-09-17 on identical 2025
 * rows: the production ensemble is at MAE 4.390 and an oracle that knows each
 * player's true season mean, leave-one-out, is at 4.411. The player level is
 * saturated -- anything that is really a better estimate of a player's average
 * cannot help, and three candidates (xFP, an opponent adjustment, a 15-key
 * feature ridge) have already failed exactly that way. So season-level
 * aggregates are not tested here. What is tested is week-level movement: the
 * store's z_latest / delta_1 / slope_6 transforms, and a matchup interaction
 * that changes from opponent to opponent.
 *
 * Four families are graded SEPARATELY, because a live signal pooled with forty
 * dead ones is a signal you will never see:
 *
 *   (a) per-receiver man/zone efficiency split x the opponent's own man rate
 *   (b) the deviation transforms only, over the player vector
 *   (c) the full player vector through a regularised linear fit
 *   (d) O-line continuity and pressure allowed, as their own small family
 *
 * Procedure is the one that promoted the current champion, so the numbers are
 * comparable: fit on 2021-2023, select the architecture (and the ridge
 * penalty) on 2024, open 2025 exactly once.
 *
 * Leak argument, stated so it can be attacked:
 *   1. Every feature comes from nfl_player_feature_vectors / nfl_team_feature_vectors,
 *      which the store froze with a cutoff and an evidence hash. Nothing here
 *      recomputes a feature; this script only reads frozen JSON.
 *   2. The store's own history queries are bounded by `season<? OR (season=? AND
 *      week<?)`, and the satellite caches go through mergePrior, which drops
 *      every stamp at or after the target week.
 *   3. The only week-t facts used are the schedule (who the opponent is) and
 *      the player's team, both of which are public days before kickoff. The
 *      opponent's man rate is his OWN prior weeks, not this week's.
 *   4. Ridge coefficients, standardisation constants and blend weights are fit
 *      on 2021-2023 only; the penalty is chosen on 2024; 2025 is scored once.
 *
 * Usage: node --env-file-if-exists=.env scripts/grade-feature-vector.mjs
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDY_DB = path.join(REPO_ROOT, 'data', 'derived', 'feature-store-study.sqlite');
if (!existsSync(STUDY_DB)) {
  console.error(`no study database at ${STUDY_DB} -- run scripts/backfill-feature-store.mjs first`);
  process.exit(1);
}
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_DB_PATH = process.env.GRIDIRON_DB_PATH || STUDY_DB;
process.env.NFL_TRUSTED_HISTORY_START = process.env.NFL_TRUSTED_HISTORY_START || '2021';

const { db, rows } = await import('../server/db/index.js');
const { WEEKLY_FEATURE_STORE_VERSION } = await import('../server/services/nfl-weekly-feature-store-v2.js');
const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { activeKVector } = await import('../server/services/shrinkage-fit.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { spearman } = await import('../server/services/backtest.js');

const BASE = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const FIT = [2021, 2022, 2023];
const SELECT = 2024;
const TEST = 2025;
const ALL_SEASONS = [...FIT, SELECT, TEST];
const LAMBDAS = [0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10];

const mean = list => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
const sd = list => {
  const average = mean(list);
  return Math.sqrt(mean(list.map(value => (value - average) ** 2)));
};
const corr = (xs, ys) => {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const u = xs[i] - mx, v = ys[i] - my; sxy += u * v; sxx += u * u; syy += v * v; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
};

/**
 * Ridge regression, closed form, intercept unpenalised.
 *
 * Split into gram() and solveRidge() on purpose. The full-vector family is
 * ~900 features over ~12,000 rows, and accumulating X'X costs n*(d+1)^2 --
 * about ten billion operations. Doing that once and then only touching the
 * diagonal for each of the eight candidate penalties is the difference between
 * a minute and ten. test-new-heads.mjs fuses the two because its d is 15.
 */
function gram(X, y) {
  const n = X.length, d = X[0].length, size = d + 1;
  const A = new Float64Array(size * size), b = new Float64Array(size);
  const xi = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    xi[0] = 1;
    const source = X[i];
    for (let k = 0; k < d; k++) xi[k + 1] = source[k];
    const yi = y[i];
    for (let r = 0; r < size; r++) {
      const vr = xi[r];
      if (vr === 0) { b[r] += 0; continue; }
      b[r] += vr * yi;
      const offset = r * size;
      for (let c = r; c < size; c++) A[offset + c] += vr * xi[c];
    }
  }
  // X'X is symmetric; only the upper triangle was accumulated.
  for (let r = 0; r < size; r++) for (let c = 0; c < r; c++) A[r * size + c] = A[c * size + r];
  return { A, b, n, size };
}

function solveRidge({ A, b, n, size }, lambda) {
  const M = Array.from({ length: size }, (_, r) => {
    const row = new Float64Array(size + 1);
    for (let c = 0; c < size; c++) row[c] = A[r * size + c];
    row[size] = b[r];
    return row;
  });
  for (let r = 1; r < size; r++) M[r][r] += lambda * n;
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let r = col + 1; r < size; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col] || 1e-9;
    for (let r = col + 1; r < size; r++) {
      const factor = M[r][col] / p;
      if (!factor) continue;
      for (let c = col; c <= size; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const w = new Float64Array(size);
  for (let r = size - 1; r >= 0; r--) {
    let sum = M[r][size];
    for (let c = r + 1; c < size; c++) sum -= M[r][c] * w[c];
    w[r] = sum / (M[r][r] || 1e-9);
  }
  return w;
}

const applyRidge = (w, x) => {
  let sum = w[0];
  for (let k = 0; k < x.length; k++) sum += w[k + 1] * x[k];
  return sum;
};

/* ------------------------------------------------------------- the replay */

console.log('replaying 2021-2025 (the slow part)...');
const common = { startWeek: 5, endWeek: 18, distributions: false,
  kOverride: undefined /* cutoff-safe default: shrinkage-fit.js cutoffSafeKVector */, roleRecency: WEEKLY_ROLE_RECENCY };
const seasons = {};
for (const season of ALL_SEASONS) {
  const replay = replaySeasonWeekly(season, common);
  seasons[season] = replay._predictions.map(item => ({ ...item, season }));
  console.log(`  ${season}: ${seasons[season].length} player-weeks`);
}

// The replay keys on the app's internal players.id; the store keys on gsis.
const gsisOf = new Map(rows(`SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL`)
  .map(item => [item.id, item.gsis_id]));
// Opponent and team come from the schedule, which is public before kickoff.
const scheduleOf = new Map(rows(`SELECT season, week, team, opponent FROM game_lines
  WHERE season BETWEEN 2021 AND 2025 AND opponent IS NOT NULL`)
  .map(item => [`${item.season}|${item.week}|${item.team}`, item.opponent]));

/* --------------------------------------------------- frozen vector loaders */

/**
 * Team vectors, projected to the handful of keys the targeted families need.
 *
 * A team vector is 4,515 features and 166KB of JSON. Parsing each one once and
 * keeping twenty numbers is the difference between 40MB and 350MB resident.
 */
const TEAM_KEYS = [
  'part_def_man__mean_6', 'part_def_man__latest', 'part_def_man__mean_12', 'part_def_man_n__mean_6',
  'part_def_zone__mean_6', 'advdef_man_rate__mean_6', 'advdef_zone_rate__mean_6',
  'advdef_blitz_rate__mean_6', 'advdef_pressure_rate__mean_6', 'part_def_pressure__mean_6',
  'part_def_cover1__mean_6', 'part_def_cover3__mean_6', 'part_def_pers_nickel__mean_6',
  'ol_continuity__latest', 'ol_continuity__mean_6', 'ol_changes__latest', 'ol_same_five__latest',
  'ol_same_five__mean_6', 'ol_starter_snaps__latest', 'ol_starter_snaps__delta_1',
  'part_off_pressure_allowed__mean_6', 'part_off_pressure_allowed__latest',
  'part_off_pressure_allowed__delta_1', 'part_off_time_to_throw__mean_6',
  'advoff_pressure_rate__mean_6', 'advoff_sack_rate__mean_6', 'advoff_sack_rate__delta_1',
  'part_off_man_faced__mean_6', 'part_off_box_faced__mean_6'
];
const teamVectors = new Map();
{
  const started = Date.now();
  const statement = db.prepare(`SELECT season, week, team, vector_json FROM nfl_team_feature_vectors
    WHERE version = ? AND season BETWEEN 2021 AND 2025`);
  let loaded = 0;
  for (const row of statement.iterate(WEEKLY_FEATURE_STORE_VERSION)) {
    let vector; try { vector = JSON.parse(row.vector_json); } catch { continue; }
    const projected = {};
    for (const key of TEAM_KEYS) if (Number.isFinite(vector[key])) projected[key] = vector[key];
    teamVectors.set(`${row.season}|${row.week}|${row.team}`, projected);
    loaded++;
  }
  console.log(`team vectors loaded: ${loaded} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/**
 * Player vectors. Two passes: the first counts how often each key is present
 * on the FIT seasons, the second extracts the surviving keys into a dense
 * array. The key list is chosen on FIT only, so the TEST season cannot
 * influence which features exist.
 */
const COVERAGE_FLOOR = 0.8;
const playerKeyCount = new Map();
let fitVectorRows = 0;
{
  const started = Date.now();
  const statement = db.prepare(`SELECT vector_json FROM nfl_player_feature_vectors
    WHERE version = ? AND season IN (?, ?, ?)`);
  for (const row of statement.iterate(WEEKLY_FEATURE_STORE_VERSION, ...FIT)) {
    let vector; try { vector = JSON.parse(row.vector_json); } catch { continue; }
    fitVectorRows++;
    for (const key of Object.keys(vector)) playerKeyCount.set(key, (playerKeyCount.get(key) ?? 0) + 1);
  }
  console.log(`player key census over ${fitVectorRows} fit-season vectors, ` +
    `${playerKeyCount.size} distinct keys (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
const PLAYER_KEYS = [...playerKeyCount.entries()]
  .filter(([, count]) => count / Math.max(1, fitVectorRows) >= COVERAGE_FLOOR)
  .map(([key]) => key).sort();
const DEVIATION_KEYS = PLAYER_KEYS.filter(key => /__(z_latest|delta_1|slope_6)$/.test(key));
// The man/zone split is a count-based family: pooled ratios are built from
// mean_6 of the numerator over mean_6 of the denominator, never from mean_6 of
// a weekly ratio, which is a different and much noisier quantity.
const MZ_KEYS = ['mz_man_yards__mean_6', 'mz_man_routes__mean_6', 'mz_man_targets__mean_6',
  'mz_zone_yards__mean_6', 'mz_zone_routes__mean_6', 'mz_zone_targets__mean_6',
  'mz_man_rec__mean_6', 'mz_zone_rec__mean_6', 'mz_man_routes__mean_12', 'mz_zone_routes__mean_12'];
const EXTRACT_KEYS = [...new Set([...PLAYER_KEYS, ...MZ_KEYS])];
const extractIndex = new Map(EXTRACT_KEYS.map((key, i) => [key, i]));
console.log(`player features at >=${COVERAGE_FLOOR * 100}% fit coverage: ${PLAYER_KEYS.length} ` +
  `(${DEVIATION_KEYS.length} of them deviation transforms)`);

const playerVectors = new Map();
{
  const started = Date.now();
  const statement = db.prepare(`SELECT season, week, player_id, vector_json
    FROM nfl_player_feature_vectors WHERE version = ? AND season BETWEEN 2021 AND 2025`);
  let loaded = 0;
  for (const row of statement.iterate(WEEKLY_FEATURE_STORE_VERSION)) {
    let vector; try { vector = JSON.parse(row.vector_json); } catch { continue; }
    const dense = new Float64Array(EXTRACT_KEYS.length).fill(NaN);
    for (const [key, value] of Object.entries(vector)) {
      const index = extractIndex.get(key);
      if (index !== undefined) dense[index] = value;
    }
    playerVectors.set(`${row.season}|${row.week}|${row.player_id}`, dense);
    loaded++;
  }
  console.log(`player vectors loaded: ${loaded} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/* ------------------------------------------------------- attach to the replay */

const at = (dense, key) => { const i = extractIndex.get(key); return i === undefined ? NaN : dense[i]; };
const ratio = (numerator, denominator) => Number.isFinite(numerator) && denominator > 1e-9 ? numerator / denominator : NaN;

{
  // The store froze the player's team on the vector row; the schedule then
  // gives the opponent. Both are known days before kickoff, which is why
  // reading them at week t is not a leak.
  const teamOf = new Map();
  for (const row of rows(`SELECT season, week, player_id, team FROM nfl_player_feature_vectors
    WHERE version = ? AND season BETWEEN 2021 AND 2025 AND team IS NOT NULL`, WEEKLY_FEATURE_STORE_VERSION)) {
    teamOf.set(`${row.season}|${row.week}|${row.player_id}`, row.team);
  }
  for (const season of ALL_SEASONS) for (const row of seasons[season]) {
    const gsis = gsisOf.get(row.player_id) ?? null;
    row.gsis = gsis;
    row.dense = gsis ? playerVectors.get(`${season}|${row.week}|${gsis}`) ?? null : null;
    const team = gsis ? teamOf.get(`${season}|${row.week}|${gsis}`) : null;
    row.team = team ?? null;
    row.opponent = team ? scheduleOf.get(`${season}|${row.week}|${team}`) ?? null : null;
    row.ownTeamVector = team ? teamVectors.get(`${season}|${row.week}|${team}`) ?? null : null;
    row.oppTeamVector = row.opponent ? teamVectors.get(`${season}|${row.week}|${row.opponent}`) ?? null : null;
  }
}

for (const season of ALL_SEASONS) {
  const withVector = seasons[season].filter(row => row.dense).length;
  const withOpponent = seasons[season].filter(row => row.oppTeamVector).length;
  console.log(`  ${season}: vector coverage ${(100 * withVector / seasons[season].length).toFixed(0)}%, ` +
    `opponent-vector coverage ${(100 * withOpponent / seasons[season].length).toFixed(0)}%`);
}

/* --------------------------------------------------------------- families */

const RECEIVER_POSITIONS = new Set(['WR', 'TE', 'RB']);
const MIN_SPLIT_ROUTES = 20;

/**
 * (a) The man/zone split crossed with the opponent's own man rate.
 *
 * The main effects are carried alongside the interaction on purpose: without
 * them the interaction term absorbs whatever the main effects would have
 * explained, and a null becomes unreadable.
 */
function manZoneFeatures(row) {
  if (!row.dense || !row.oppTeamVector) return null;
  if (!RECEIVER_POSITIONS.has(row.position)) return null;
  const manRoutes = at(row.dense, 'mz_man_routes__mean_6');
  const zoneRoutes = at(row.dense, 'mz_zone_routes__mean_6');
  if (!(manRoutes * 6 >= MIN_SPLIT_ROUTES) || !(zoneRoutes * 6 >= MIN_SPLIT_ROUTES)) return null;
  const yprMan = ratio(at(row.dense, 'mz_man_yards__mean_6'), manRoutes);
  const yprZone = ratio(at(row.dense, 'mz_zone_yards__mean_6'), zoneRoutes);
  const trMan = ratio(at(row.dense, 'mz_man_targets__mean_6'), manRoutes);
  const trZone = ratio(at(row.dense, 'mz_zone_targets__mean_6'), zoneRoutes);
  const oppMan = row.oppTeamVector.part_def_man__mean_6 ?? row.oppTeamVector.advdef_man_rate__mean_6;
  if (![yprMan, yprZone, trMan, trZone, oppMan].every(Number.isFinite)) return null;
  const routes = manRoutes + zoneRoutes;
  const yprAll = ratio(at(row.dense, 'mz_man_yards__mean_6') + at(row.dense, 'mz_zone_yards__mean_6'), routes);
  const trAll = ratio(at(row.dense, 'mz_man_targets__mean_6') + at(row.dense, 'mz_zone_targets__mean_6'), routes);
  return { values: [routes, yprAll, trAll, yprMan - yprZone, trMan - trZone, oppMan,
    (yprMan - yprZone) * oppMan, (trMan - trZone) * oppMan,
    routes * oppMan, yprAll * oppMan],
  names: ['routes_6', 'ypr_all', 'target_rate_all', 'ypr_man_minus_zone', 'target_rate_man_minus_zone',
    'opp_man_rate_prior', 'ypr_gap_x_opp_man', 'target_gap_x_opp_man', 'routes_x_opp_man', 'ypr_x_opp_man'] };
}

function deviationFeatures(row) {
  if (!row.dense) return null;
  const values = DEVIATION_KEYS.map(key => at(row.dense, key));
  // A missing deviation is a real state -- no prior week to differ from -- and
  // is held at zero with a companion indicator rather than dropped.
  const filled = [], flags = [];
  for (const value of values) { filled.push(Number.isFinite(value) ? value : 0); flags.push(Number.isFinite(value) ? 0 : 1); }
  return { values: [...filled, ...flags],
    names: [...DEVIATION_KEYS, ...DEVIATION_KEYS.map(key => `${key}__absent`)] };
}

function fullVectorFeatures(row) {
  if (!row.dense) return null;
  // No per-key absent flag here, unlike the deviation family: doubling ~900
  // features to ~1,800 doubles the dimension of a fit that is already the
  // worst-conditioned one in this script. One scalar says how much of the
  // vector was present, which is the part that actually varies.
  const values = [];
  let present = 0;
  for (const key of PLAYER_KEYS) {
    const value = at(row.dense, key);
    if (Number.isFinite(value)) { values.push(value); present++; } else values.push(0);
  }
  values.push(present / PLAYER_KEYS.length);
  return { values, names: [...PLAYER_KEYS, 'vector_present_share'] };
}

/**
 * (f)/(g) Family (c), split into what v1 already had and what v2 added.
 *
 * This exists because (c) violates this file's own stated design principle:
 * grade families separately, because a live signal pooled with forty dead ones
 * is a signal you will never see. (c) pools 612 keys the store already had --
 * which are the SAME base/ngs/injury surface that the 15-key ridge of
 * test-new-heads.mjs already took zero weight from -- with 259 keys that
 * arrived with v2 (regularised APM and the per-receiver man/zone counts).
 * Measured: the v1-only 612 FAIL the gate (+0.0023 on 2025, bootstrap flat),
 * while the v2-only 259 clear it with roughly five times (c)'s forward effect.
 * Pooling them diluted the only thing in this wave that moved.
 *
 * Read the v2-only number with the discount it deserves: it is a post-hoc
 * subset, chosen after (c) had already been seen to pass, and scored on a TEST
 * season this file has now opened several times. It is a hypothesis to
 * pre-register and send through the all-play replay, not a result.
 */
const V2_NEW_KEYS = PLAYER_KEYS.filter(key => /^(apm_|mz_)/.test(key));
const V1_OLD_KEYS = PLAYER_KEYS.filter(key => !/^(apm_|mz_)/.test(key));

function subsetVectorFeatures(keys) {
  return row => {
    if (!row.dense) return null;
    const values = [];
    let present = 0;
    for (const key of keys) {
      const value = at(row.dense, key);
      if (Number.isFinite(value)) { values.push(value); present++; } else values.push(0);
    }
    values.push(present / keys.length);
    return { values, names: [...keys, 'vector_present_share'] };
  };
}

/**
 * (h) CALIBRATION, not a candidate: the player's own leave-one-out season mean.
 *
 * It contains his actual scores in the other weeks of the same season,
 * including weeks after this one, so no live model can ever have it. It is
 * here to put a ruler against the gate: whatever the gate says about a real
 * family should be read next to what it says about an oracle. It clears the
 * bar 5/5 at a mean delta of about +0.055, which is the size of the entire
 * remaining opportunity at the player level -- and 2026-09-17 already measured
 * that this same quantity, used STANDALONE, loses to the production ensemble.
 */
function oracleSeasonMeanFeatures(row) {
  if (!row.dense || !Number.isFinite(row.looSeasonMean)) return null;
  return { values: [row.looSeasonMean], names: ['loo_season_mean'] };
}
{
  const byPlayerSeason = new Map();
  for (const season of ALL_SEASONS) for (const row of seasons[season]) {
    const key = `${season}|${row.player_id}`;
    (byPlayerSeason.get(key) ?? byPlayerSeason.set(key, []).get(key)).push(row);
  }
  for (const list of byPlayerSeason.values()) {
    if (list.length < 2) continue;
    const total = list.reduce((sum, row) => sum + row.actual, 0);
    for (const row of list) row.looSeasonMean = (total - row.actual) / (list.length - 1);
  }
}

/**
 * (e) The same 871 features, attached to the WRONG player.
 *
 * Family (c) is the only thing in this wave that earns weight, and a
 * 871-feature fit that improves MAE by a hundredth of a point is exactly the
 * shape of result that a broken gate produces. So the gate is run against a
 * vector that has been permuted within its own season-week: the marginal
 * distribution of every feature is untouched, the row counts are identical,
 * and the only thing destroyed is the link between a player and his own
 * history. If the placebo also passes, the gate is measuring the procedure,
 * not the features, and (c) means nothing.
 */
const placeboPartner = new Map();
{
  let state = 19122026;
  const nextRandom = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const byWeek = new Map();
  for (const season of ALL_SEASONS) for (const row of seasons[season]) {
    if (!row.dense) continue;
    const key = `${season}|${row.week}`;
    (byWeek.get(key) ?? byWeek.set(key, []).get(key)).push(row);
  }
  for (const list of byWeek.values()) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    list.forEach((row, index) => placeboPartner.set(row, shuffled[index].dense));
  }
}

function placeboVectorFeatures(row) {
  const dense = placeboPartner.get(row);
  if (!dense) return null;
  return fullVectorFeatures({ dense });
}

const PROTECTION_OWN = ['ol_continuity__latest', 'ol_continuity__mean_6', 'ol_changes__latest',
  'ol_same_five__latest', 'ol_same_five__mean_6', 'ol_starter_snaps__delta_1',
  'part_off_pressure_allowed__mean_6', 'part_off_pressure_allowed__latest',
  'part_off_pressure_allowed__delta_1', 'part_off_time_to_throw__mean_6',
  'advoff_pressure_rate__mean_6', 'advoff_sack_rate__mean_6', 'advoff_sack_rate__delta_1'];
const PROTECTION_OPP = ['advdef_blitz_rate__mean_6', 'advdef_pressure_rate__mean_6', 'part_def_pressure__mean_6'];

function protectionFeatures(row) {
  if (!row.ownTeamVector || !row.oppTeamVector) return null;
  const values = [], names = [];
  for (const key of PROTECTION_OWN) {
    const value = row.ownTeamVector[key];
    if (!Number.isFinite(value)) return null;
    values.push(value); names.push(`own_${key}`);
  }
  for (const key of PROTECTION_OPP) {
    const value = row.oppTeamVector[key];
    if (!Number.isFinite(value)) return null;
    values.push(value); names.push(`opp_${key}`);
  }
  // The structural projection is carried in so the head predicts points rather
  // than a league-average constant; the protection block then only has to earn
  // the residual.
  values.push(row.structural); names.push('structural');
  return { values, names };
}

/* ------------------------------------------------------------- evaluation */

function weightGrid(n, step) {
  const out = [], steps = Math.round(1 / step);
  const recurse = (acc, left, index) => {
    if (index === n - 1) { out.push([...acc, left * step]); return; }
    for (let k = 0; k <= left; k++) recurse([...acc, k * step], left - k, index + 1);
  };
  recurse([], steps, 0);
  return out;
}
// Both grids use the SAME step, so the five-head weight vector is a point in
// the six-head grid with w_head = 0. Without that the candidate is not nested
// in the baseline and a head with zero weight can still appear to improve the
// selection season -- which is exactly what a 0.05/0.10 mismatch produced on
// the first run of this script, for the O-line family.
const GRID_STEP = 0.1;
const GRID5 = weightGrid(5, GRID_STEP);
const GRID6 = weightGrid(6, GRID_STEP);

function fitWeights(data, heads, grid) {
  let best = null, bestMae = Infinity;
  for (const w of grid) {
    let sum = 0;
    for (const row of data) {
      let prediction = 0;
      for (let i = 0; i < heads.length; i++) prediction += w[i] * row[heads[i]];
      sum += Math.abs(prediction - row.actual);
    }
    const mae = sum / data.length;
    if (mae < bestMae) { bestMae = mae; best = w; }
  }
  return { weights: best, mae: bestMae };
}

function score(data, heads, weights) {
  const errors = [], pairs = [], groups = [];
  for (const row of data) {
    let prediction = 0;
    for (let i = 0; i < heads.length; i++) prediction += weights[i] * row[heads[i]];
    errors.push(Math.abs(prediction - row.actual));
    pairs.push({ pred: prediction, act: row.actual });
    groups.push(row.season);
  }
  return { mae: mean(errors), spearman: spearman(pairs), errors, groups, n: errors.length };
}

/** Leave-one-out season-mean oracle, so the ceiling is quoted without its own leak. */
function oracleFloor(data) {
  const byPlayer = new Map();
  for (const row of data) (byPlayer.get(row.player_id) ?? byPlayer.set(row.player_id, []).get(row.player_id)).push(row.actual);
  const errors = [];
  for (const row of data) {
    const list = byPlayer.get(row.player_id);
    if (list.length < 4) continue;
    const others = (list.reduce((sum, value) => sum + value, 0) - row.actual) / (list.length - 1);
    errors.push(Math.abs(row.actual - others));
  }
  return { mae: mean(errors), n: errors.length };
}

/**
 * Leave-one-season-out, so all five season signs are out of sample.
 *
 * The mandated protocol -- fit 2021-2023, select on 2024, open 2025 once -- is
 * the headline, because it is what promoted the current champion and the
 * numbers have to stay comparable. But it leaves only two seasons out of
 * sample, and TARGET-SPEC's gate wants five. Scoring each season from a model
 * that never saw it is the only way to get five honest signs out of five
 * seasons of data; the first run of this script counted 2021-2023 as evidence
 * for a model fitted on 2021-2023, and the full-vector family "passed" a gate
 * on the strength of its own training data while losing on the one season it
 * had not seen.
 *
 * The ridge penalty is NOT re-chosen per fold -- it is the one the headline
 * protocol picked on 2024. Re-choosing it per fold would need a third split
 * inside each fold, and the penalty is not where the overfitting lives.
 */
function leaveOneSeasonOut(built, dimension, lambda) {
  const deltas = [];
  for (const held of ALL_SEASONS) {
    const trainSeasons = ALL_SEASONS.filter(season => season !== held);
    const trainRows = trainSeasons.flatMap(season => built[season]);
    const heldRows = built[held];
    if (trainRows.length < 300 || heldRows.length < 50) continue;
    const mu = new Float64Array(dimension), sigma = new Float64Array(dimension);
    for (let i = 0; i < dimension; i++) {
      let sum = 0;
      for (const row of trainRows) sum += row.features[i];
      mu[i] = sum / trainRows.length;
      let variance = 0;
      for (const row of trainRows) variance += (row.features[i] - mu[i]) ** 2;
      sigma[i] = Math.sqrt(variance / trainRows.length) || 1;
    }
    const design = list => list.map(row => {
      const x = new Float64Array(dimension);
      for (let i = 0; i < dimension; i++) x[i] = (row.features[i] - mu[i]) / sigma[i];
      return x;
    });
    const Xtrain = design(trainRows), Xheld = design(heldRows);
    const coefficients = solveRidge(gram(Xtrain, trainRows.map(row => row.actual)), lambda);
    trainRows.forEach((row, index) => { row.losoHead = applyRidge(coefficients, Xtrain[index]); });
    heldRows.forEach((row, index) => { row.losoHead = applyRidge(coefficients, Xheld[index]); });
    const heads = [...BASE, 'losoHead'];
    const baseWeights = fitWeights(trainRows, BASE, GRID5).weights;
    const newWeights = fitWeights(trainRows, heads, GRID6).weights;
    const baseMae = score(heldRows, BASE, baseWeights).mae;
    const newMae = score(heldRows, heads, newWeights).mae;
    deltas.push({ season: held, base: baseMae, candidate: newMae, delta: baseMae - newMae,
      headWeight: newWeights.at(-1), n: heldRows.length });
  }
  return deltas;
}

/** Percentile interval from resampling the SEASONS, not the player-weeks. */
function seasonClusteredInterval(values, { iterations = 4000, seed = 20260917 } = {}) {
  let state = seed;
  const nextRandom = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const draws = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(nextRandom() * values.length)];
    draws.push(sum / values.length);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.05 * draws.length)], draws[Math.floor(0.95 * draws.length)]];
}

const testOpens = [];

function gradeFamily(name, builder, { grid = GRID6 } = {}) {
  console.log(`\n${'='.repeat(78)}\n${name}\n${'='.repeat(78)}`);
  const built = {};
  for (const season of ALL_SEASONS) {
    built[season] = [];
    for (const row of seasons[season]) {
      const features = builder(row);
      if (features) built[season].push({ ...row, features: features.values, names: features.names });
    }
  }
  const sample = ALL_SEASONS.map(season => built[season][0]).find(Boolean);
  const dimension = sample?.names.length ?? 0;
  const fitRows = FIT.flatMap(season => built[season]);
  const selectRows = built[SELECT], testRows = built[TEST];
  console.log(`rows: fit ${fitRows.length}, select ${selectRows.length}, test ${testRows.length}`);
  console.log(`features: ${dimension}  (rows per feature on fit: ${(fitRows.length / Math.max(1, dimension)).toFixed(1)})`);
  if (fitRows.length < 300 || !dimension) { console.log('too few rows to fit; family abandoned'); return null; }

  // Standardise on FIT only -- the TEST season must not reach the scaling
  // constants any more than it reaches the coefficients.
  const mu = new Float64Array(dimension), sigma = new Float64Array(dimension);
  for (let i = 0; i < dimension; i++) {
    let sum = 0;
    for (const row of fitRows) sum += row.features[i];
    mu[i] = sum / fitRows.length;
    let variance = 0;
    for (const row of fitRows) variance += (row.features[i] - mu[i]) ** 2;
    sigma[i] = Math.sqrt(variance / fitRows.length) || 1;
  }
  const design = list => list.map(row => {
    const x = new Float64Array(dimension);
    for (let i = 0; i < dimension; i++) x[i] = (row.features[i] - mu[i]) / sigma[i];
    return x;
  });
  const designed = {};
  for (const season of ALL_SEASONS) designed[season] = design(built[season]);
  const Xfit = FIT.flatMap(season => designed[season]);
  const yFit = fitRows.map(row => row.actual);

  const started = Date.now();
  const normal = gram(Xfit, yFit);
  // Penalty chosen on the SELECT season, never on TEST.
  let chosen = null;
  for (const lambda of LAMBDAS) {
    const coefficients = solveRidge(normal, lambda);
    let sum = 0;
    for (let i = 0; i < selectRows.length; i++) sum += Math.abs(applyRidge(coefficients, designed[SELECT][i]) - selectRows[i].actual);
    const selectMae = sum / selectRows.length;
    if (!chosen || selectMae < chosen.selectMae) chosen = { lambda, coefficients, selectMae };
  }
  console.log(`ridge penalty chosen on ${SELECT}: lambda=${chosen.lambda} ` +
    `(select MAE ${chosen.selectMae.toFixed(4)}, ${((Date.now() - started) / 1000).toFixed(1)}s for ${LAMBDAS.length} penalties)`);

  for (const season of ALL_SEASONS) {
    built[season].forEach((row, index) => { row.head = applyRidge(chosen.coefficients, designed[season][index]); });
  }

  const standalone = list => mean(list.map(row => Math.abs(row.head - row.actual)));
  const fitMae = standalone(fitRows), testMae = standalone(testRows);
  console.log(`standalone head MAE: fit ${fitMae.toFixed(4)}  select ${standalone(selectRows).toFixed(4)}  ` +
    `test ${testMae.toFixed(4)}   train/test gap ${(testMae - fitMae).toFixed(4)} ` +
    `(${(100 * (testMae - fitMae) / fitMae).toFixed(1)}%)`);
  console.log('  for comparison on the same rows: ' + BASE.map(head =>
    `${head} ${mean(testRows.map(row => Math.abs(row[head] - row.actual))).toFixed(3)}`).join('  '));
  console.log('  correlation of the head with the existing five, on ' + TEST + ': ' +
    BASE.map(head => `${head}:${corr(testRows.map(r => r.head), testRows.map(r => r[head])).toFixed(2)}`).join('  '));

  const heads = [...BASE, 'head'];
  const baseFit = fitWeights(fitRows, BASE, GRID5);
  const newFit = fitWeights(fitRows, heads, grid);
  const baseSelect = score(selectRows, BASE, baseFit.weights);
  const newSelect = score(selectRows, heads, newFit.weights);
  console.log(`blend weights on fit: base [${baseFit.weights.map(w => w.toFixed(2)).join(' ')}]`);
  console.log(`                      with head [${newFit.weights.map(w => w.toFixed(2)).join(' ')}]  ` +
    `-> head weight ${newFit.weights.at(-1).toFixed(2)}`);
  console.log(`${SELECT}: base ${baseSelect.mae.toFixed(4)}  with head ${newSelect.mae.toFixed(4)}  ` +
    `(${(100 * (newSelect.mae - baseSelect.mae) / baseSelect.mae).toFixed(2)}%)`);

  if (newFit.weights.at(-1) === 0) {
    console.log(`VERDICT: zero weight in the fit. The head carries nothing the five already have.` +
      ` The base and candidate grids share a step, so this is the same weight vector as the base,` +
      ` and ${SELECT} is identical by construction.`);
  }

  // The gate runs whether or not the headline protocol opens TEST: five
  // out-of-sample season signs are the thing TARGET-SPEC asks for, and a
  // family that fails the selection season can still be reported honestly.
  const loso = leaveOneSeasonOut(built, dimension, chosen.lambda);
  console.log('\n  leave-one-season-out (each season scored by a model that never saw it)');
  for (const item of loso) {
    console.log(`    ${item.season}  base ${item.base.toFixed(4)}  cand ${item.candidate.toFixed(4)}  ` +
      `delta ${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(4)}  head weight ${item.headWeight.toFixed(2)}  n=${item.n}`);
  }
  const deltas = loso.map(item => item.delta);
  const positive = deltas.filter(value => value > 0).length;
  const [low, high] = seasonClusteredInterval(deltas);
  const passes = positive >= 4 && low > 0;
  console.log(`  sign stable in ${positive} of ${loso.length} seasons; ` +
    `season-clustered 90% CI on mean delta [${low.toFixed(4)}, ${high.toFixed(4)}]`);
  // Named for the metric it is computed on. TARGET-SPEC section 5 says in so
  // many words that MAE is REPLACED as the gate for a projection change: the
  // primary is attainable-arm all-play win rate with a minimum practical
  // effect of 0.010. Nothing in this script measures that, so a pass here is
  // a licence to run the all-play replay, not a licence to promote. The
  // calibration that makes this concrete: a head consisting of the player's
  // own leave-one-out SEASON MEAN -- an outright within-season oracle, which
  // no live model can have -- clears this same bar 5/5 with a mean delta of
  // +0.055, several times anything measured here. This shape of gate does not
  // separate a real improvement from a small oracle.
  console.log(`  MAE-PROXY GATE (>=4 of 5 seasons out of sample, interval clear of zero): ` +
    `${passes ? 'PASS' : 'FAIL'}  -- not TARGET-SPEC's gate, which is attainable-arm all-play`);

  if (newSelect.mae >= baseSelect.mae) {
    console.log(`VERDICT: did not beat the base heads on ${SELECT}. ${TEST} is NOT opened.`);
    return { name, opened: false, dimension, fitMae, testMae,
      headWeight: newFit.weights.at(-1), seasons: positive, ci: [low, high], passes };
  }

  // TEST is opened once PER FAMILY, not once per study. Every family that
  // beats the selection season gets its own look at 2025, so the family-wise
  // error rate across this file is not controlled and a single "significant"
  // bootstrap among several families is worth much less than it reads.
  testOpens.push(name);
  const baseTest = score(testRows, BASE, baseFit.weights);
  const newTest = score(testRows, heads, newFit.weights);
  const boot = pairedBootstrapDiff(baseTest.errors, newTest.errors, { seed: 20260917 });
  console.log(`\n${TEST} opened once (n=${newTest.n})`);
  console.log(`  base     MAE ${baseTest.mae.toFixed(4)}  rho ${baseTest.spearman.toFixed(4)}`);
  console.log(`  + head   MAE ${newTest.mae.toFixed(4)}  rho ${newTest.spearman.toFixed(4)}  ` +
    `(${(100 * (newTest.mae - baseTest.mae) / baseTest.mae).toFixed(2)}%)`);
  console.log(`  paired bootstrap over player-weeks: ${JSON.stringify(boot)}`);
  const floor = oracleFloor(testRows);
  console.log(`  leave-one-out season-mean oracle on these rows: ${floor.mae.toFixed(4)} (n=${floor.n})`);

  return { name, opened: true, dimension, fitMae, testMae, headWeight: newFit.weights.at(-1),
    testDelta: baseTest.mae - newTest.mae, seasons: positive, ci: [low, high], passes };
}

const FAMILIES = [
  ['a', '(a) man/zone split x opponent man rate, receivers only', manZoneFeatures],
  ['b', '(b) deviation transforms only (z_latest, delta_1, slope_6)', deviationFeatures],
  ['c', '(c) full player vector, regularised linear fit', fullVectorFeatures],
  ['d', '(d) O-line continuity and pressure allowed', protectionFeatures],
  ['e', '(e) PLACEBO: the same 871 features attached to the wrong player', placeboVectorFeatures],
  ['f', '(f) DECOMPOSITION of (c): v1 keys only (no apm_, no mz_)', subsetVectorFeatures(V1_OLD_KEYS)],
  ['g', '(g) DECOMPOSITION of (c): v2-new keys only (apm_ + mz_)', subsetVectorFeatures(V2_NEW_KEYS)],
  ['h', '(h) CALIBRATION ORACLE: leave-one-out season mean (not promotable)', oracleSeasonMeanFeatures]
];
const only = process.argv.find(item => item.startsWith('--only='))?.slice(7).split(',');
const results = [];
for (const [code, label, builder] of FAMILIES) {
  if (only && !only.includes(code)) continue;
  results.push(gradeFamily(label, builder));
}

console.log(`\n${'='.repeat(78)}\nSUMMARY\n${'='.repeat(78)}`);
for (const item of results) {
  if (!item) { console.log('  (family abandoned)'); continue; }
  console.log(`  ${item.name}`);
  console.log(`    features ${item.dimension}  head weight ${item.headWeight?.toFixed(2)}  ` +
    `train/test gap ${(item.testMae - item.fitMae).toFixed(4)}  ` +
    (item.opened ? `${TEST} delta ${item.testDelta >= 0 ? '+' : ''}${item.testDelta.toFixed(4)}  ` : `${TEST} not opened  `) +
    `LOSO seasons ${item.seasons}/5 CI [${item.ci[0].toFixed(4)}, ${item.ci[1].toFixed(4)}] ` +
    `MAE-PROXY GATE ${item.passes ? 'PASS' : 'FAIL'}`);
}
console.log(`\n  ${TEST} was opened ${testOpens.length} time(s), once per family that beat ${SELECT}: ` +
  `${testOpens.length ? testOpens.map(item => item.slice(0, 3)).join(' ') : 'none'}.`);
console.log('  A pass above is on MAE. TARGET-SPEC section 5 grades a projection change on ' +
  'attainable-arm all-play win rate, minimum practical effect 0.010; none of that is measured here.');
process.exit(0);
