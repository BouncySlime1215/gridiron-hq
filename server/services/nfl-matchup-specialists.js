/**
 * Matchup and situational evidence candidates (PROFITABILITY_PLAN Priority 4).
 *
 * Four new council roles, each a small ridge regression of the market
 * residual (actual home margin minus the market's) on a handful of matchup
 * differentials the market may not fully price:
 *
 *   trench_continuity      offensive-line and quarterback continuity from
 *                          snap counts (who actually played, week to week)
 *   tendency_matchup       pass-rate-over-expected, shotgun, no-huddle and
 *                          early-down pass rate against the opponent's
 *                          defensive tendencies
 *   situational_efficiency early-down EPA, explosive-play creation and
 *                          prevention, red-zone and third-down conversion
 *   pressure_matchup       pressure-versus-clean-pocket EPA, sack and hit
 *                          rates against the opponent's havoc and pass rush
 *
 * Every input is a team profile built ONLY from weeks strictly before the
 * target week (this season, blended with last season while the sample is
 * thin), and every fit uses only games settled before the target week. A
 * role abstains, with a reason, when its evidence is missing or its training
 * sample is too small. These are candidates: the coordinator learns whether
 * they deserve weight, and the specialist audit says whether they add or
 * remove error. None of them has staking authority.
 */
import { rows } from '../db/index.js';

export const MATCHUP_SPECIALISTS_VERSION = 'nfl-matchup-specialists-v1';
const MIN_TRAINING_ROWS = 200;
const MIN_PRIOR_WEEKS = 2;
const RIDGE_LAMBDA = 25;
const FORECAST_CAP = 4;

// [own offensive key, opponent defensive key] pairs; the differential is
// (home_off - away_def) - (away_off - home_def), i.e. how much better the home
// offence-versus-defence matchup is than the away one, per feature.
export const ROLE_FEATURES = Object.freeze({
  tendency_matchup: [['off_proe', 'def_proe'], ['off_shotgun_rate', 'def_shotgun_rate'],
    ['off_no_huddle_rate', 'def_no_huddle_rate'], ['off_early_down_pass_rate', 'def_early_down_pass_rate'],
    ['off_neutral_pass_rate', 'def_neutral_pass_rate']],
  situational_efficiency: [['off_early_down_epa', 'def_early_down_epa'], ['off_explosive_play_rate', 'def_explosive_play_rate'],
    ['off_red_zone_td_rate', 'def_red_zone_td_rate'], ['off_third_down_rate', 'def_third_down_rate'],
    ['off_series_success_rate', 'def_series_success_rate']],
  pressure_matchup: [['off_pressure_epa_delta', 'def_pressure_epa_delta'], ['off_sack_rate', 'def_sack_rate'],
    ['off_qb_hit_rate', 'def_qb_hit_rate'], ['off_clean_pocket_epa', 'def_clean_pocket_epa'],
    ['off_havoc_rate', 'def_havoc_rate']]
});

const r3 = value => (Number.isFinite(value) ? +value.toFixed(3) : null);
const mean = list => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);

/* ---------------------------------------------------------- team profiles */

let _featureRows = null;
/** Every team-week feature row, parsed once. */
function featureRows() {
  if (_featureRows) return _featureRows;
  _featureRows = new Map();
  for (const row of rows('SELECT season,week,team,features FROM nfl_team_week_features')) {
    let features; try { features = JSON.parse(row.features); } catch { continue; }
    _featureRows.set(`${row.season}|${row.week}|${row.team}`, features);
  }
  return _featureRows;
}
export function clearMatchupCache() { _featureRows = null; _snapRows = null; _fits.clear(); }

/** Mean of `keys` over a team's weeks strictly before `week` this season, blended with last season while thin. */
function teamProfile(season, week, team, keys) {
  const all = featureRows();
  const current = [], prior = [];
  for (let w = 1; w < week; w++) { const f = all.get(`${season}|${w}|${team}`); if (f) current.push(f); }
  for (let w = 1; w <= 18; w++) { const f = all.get(`${season - 1}|${w}|${team}`); if (f) prior.push(f); }
  if (current.length < MIN_PRIOR_WEEKS && !prior.length) return null;
  const weightCurrent = Math.min(1, current.length / 6);
  const out = {};
  for (const key of keys) {
    const now = mean(current.map(f => f[key]).filter(Number.isFinite));
    const then = mean(prior.map(f => f[key]).filter(Number.isFinite));
    if (now == null && then == null) return null;
    out[key] = now == null ? then : then == null ? now : weightCurrent * now + (1 - weightCurrent) * then;
  }
  return out;
}

let _snapRows = null;
function snapRows() {
  if (_snapRows) return _snapRows;
  _snapRows = new Map();
  for (const row of rows(`SELECT season,week,team,player,position,offense_pct FROM nfl_snaps
      WHERE position IN ('T','G','C','OL','QB') AND offense_pct IS NOT NULL`)) {
    const key = `${row.season}|${row.week}|${row.team}`;
    const list = _snapRows.get(key) ?? []; list.push(row); _snapRows.set(key, list);
  }
  return _snapRows;
}

/**
 * Line and quarterback continuity from snaps in the weeks before `week`: the
 * share of the top-five linemen retained week to week (mean over the last
 * three completed pairs) and whether the snap-leading quarterback changed
 * between the last two completed weeks.
 */
function continuityProfile(season, week, team) {
  const snaps = snapRows();
  const weeks = [];
  for (let w = week - 1; w >= 1 && weeks.length < 4; w--) { const list = snaps.get(`${season}|${w}|${team}`); if (list?.length) weeks.push(list); }
  if (weeks.length < 2) return null;
  const topLine = list => list.filter(r => r.position !== 'QB').sort((a, b) => b.offense_pct - a.offense_pct).slice(0, 5).map(r => r.player);
  const qb = list => list.filter(r => r.position === 'QB').sort((a, b) => b.offense_pct - a.offense_pct)[0]?.player ?? null;
  const retained = [];
  for (let i = 0; i + 1 < weeks.length; i++) {
    const newer = new Set(topLine(weeks[i])), older = topLine(weeks[i + 1]);
    if (!older.length) continue;
    retained.push(older.filter(p => newer.has(p)).length / older.length);
  }
  if (!retained.length) return null;
  return { ol_retention: mean(retained), qb_change: qb(weeks[0]) && qb(weeks[1]) && qb(weeks[0]) !== qb(weeks[1]) ? 1 : 0 };
}

/* ----------------------------------------------------------- differentials */

function differential(role, season, week, home, away) {
  if (role === 'trench_continuity') {
    const h = continuityProfile(season, week, home), a = continuityProfile(season, week, away);
    if (!h || !a) return null;
    return [h.ol_retention - a.ol_retention, h.qb_change - a.qb_change];
  }
  const pairs = ROLE_FEATURES[role];
  const keys = [...new Set(pairs.flat())];
  const h = teamProfile(season, week, home, keys), a = teamProfile(season, week, away, keys);
  if (!h || !a) return null;
  return pairs.map(([off, def]) => (h[off] - a[def]) - (a[off] - h[def]));
}

/* ------------------------------------------------------------------ ridge */

function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function ridge(X, y, lambda) {
  const k = X[0].length;
  const mx = Array.from({ length: k }, (_, j) => mean(X.map(row => row[j])));
  const sx = Array.from({ length: k }, (_, j) => Math.sqrt(mean(X.map(row => (row[j] - mx[j]) ** 2))) || 1);
  const Z = X.map(row => row.map((v, j) => (v - mx[j]) / sx[j]));
  const my = mean(y);
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) =>
    Z.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j ? lambda : 0)));
  const b = Array.from({ length: k }, (_, i) => Z.reduce((sum, row, n) => sum + row[i] * (y[n] - my), 0));
  const beta = solve(A, b);
  if (!beta) return null;
  const predict = row => my + row.reduce((sum, v, j) => sum + beta[j] * (v - mx[j]) / sx[j], 0);
  const residuals = X.map((row, n) => y[n] - predict(row));
  return { beta, predict, sigma: Math.sqrt(mean(residuals.map(r => r * r))), intercept: my };
}

const _fits = new Map();

/** Fit one role on every game settled before (season, week). Cached per role and week. */
function fitRole(role, season, week) {
  const key = `${role}|${season}|${week}`;
  if (_fits.has(key)) return _fits.get(key);
  const games = rows(`SELECT season,week,team home,opponent away,spread,team_score,opp_score FROM game_lines
    WHERE home=1 AND spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND season>=? AND (season<? OR (season=? AND week<?)) ORDER BY season,week`, season - 4, season, season, week);
  const X = [], y = [];
  for (const g of games) {
    const d = differential(role, g.season, g.week, g.home, g.away);
    if (!d || d.some(v => !Number.isFinite(v))) continue;
    const residual = (g.team_score - g.opp_score) - (-g.spread);
    if (Math.abs(residual) > 45) continue;
    X.push(d); y.push(residual);
  }
  const fit = X.length >= MIN_TRAINING_ROWS ? ridge(X, y, RIDGE_LAMBDA) : null;
  const out = { role, season, week, training_rows: X.length, fit,
    reason: fit ? null : `only ${X.length} prior settled games with ${role} evidence (need ${MIN_TRAINING_ROWS})` };
  _fits.set(key, out);
  return out;
}

/**
 * One role's opinion on one game. `forecast` is the market residual in home
 * points, capped; null with a reason when the role must abstain.
 */
export function matchupOpinion(role, season, week, home, away) {
  if (!ROLE_FEATURES[role] && role !== 'trench_continuity') return { forecast: null, uncertainty: null, missing_reason: `unknown role ${role}` };
  const d = differential(role, season, week, home, away);
  if (!d || d.some(v => !Number.isFinite(v))) {
    return { forecast: null, uncertainty: null, missing_reason: `no cutoff-safe ${role.replaceAll('_', ' ')} profile for both teams before week ${week}` };
  }
  const model = fitRole(role, season, week);
  if (!model.fit) return { forecast: null, uncertainty: null, missing_reason: model.reason, differential: d.map(r3) };
  const raw = model.fit.predict(d) - model.fit.intercept;
  const forecast = Math.max(-FORECAST_CAP, Math.min(FORECAST_CAP, raw));
  return { forecast: r3(forecast), uncertainty: r3(model.fit.sigma), differential: d.map(r3),
    coefficients: model.fit.beta.map(r3), training_rows: model.training_rows, version: MATCHUP_SPECIALISTS_VERSION,
    provenance: 'ridge fit of the market residual on strictly-prior team profiles; earlier settled games only' };
}

export const MATCHUP_ROLES = Object.freeze(['trench_continuity', 'tendency_matchup', 'situational_efficiency', 'pressure_matchup']);
