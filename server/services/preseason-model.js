/**
 * Season-long (preseason) fantasy point projection.
 *
 * The weekly engine in `projections.js` answers "what is this player worth per game
 * given everything we know". A draft board asks a harder question three months
 * earlier: how many points will he score over a whole season, when the biggest single
 * source of variance is whether he is on the field at all.
 *
 * Two things shape every design decision here.
 *
 * 1. THE MARKET IS THE BASELINE, NOT THE STRAW MAN. FantasyPros ECR is a consensus of
 *    people who do this full time. `docs/DRAFT_AUDIT_2021_2025.md` measured what it
 *    actually delivered 2021-2025 and it is hard to beat. So the market rank is a
 *    FEATURE, the market-implied points curve is a BASELINE, and nothing ships unless
 *    it beats that curve out-of-sample on held-out seasons.
 *
 * 2. RANK IS NOT POINTS, AND THE DIFFERENCE IS A TRAP. The player ranked #1 can only
 *    fall; the player ranked #60 can only rise. Grading a rank against realized points
 *    without accounting for that manufactures a "model" that is really just
 *    mean-reversion. The fix used throughout: the market baseline is not "the points
 *    the #1 finisher scored" but "the points the AVERAGE player drafted at this rank
 *    scored", fitted on training seasons only with a smoothing kernel over rank. Every
 *    model is then graded against that same honest curve.
 *
 * Points are decomposed as `ppg x expected_games` rather than predicted in one shot,
 * because the audit's loudest finding was availability: a top-12 pick who plays nine
 * games is the most common way a draft goes wrong. Splitting them let the two halves
 * be graded separately, and that is exactly how the availability head was caught
 * failing — see `componentsFor`.
 *
 * WHAT ACTUALLY SHIPS IS THE MARKET CURVE. Ridge, GBM and three stacked blends were
 * fitted walk-forward for T in 2023/2024/2025 and NONE of them beat that curve by a
 * significant margin on any season. Under this repo's governance a model that does not
 * beat its baselines out-of-sample is documented as declined, not shipped, so the
 * point estimate is the curve and the learned heads survive only as a disagreement
 * signal and as the ordering behind the explanation strings. The full held-out table,
 * the declines and the limits are in `docs/PRESEASON_MODEL.md`; the evaluation scripts
 * are in `scratchpad/preseason/`. This module WRITES NOTHING to the database.
 *
 * v2 added the offseason charting block (see `CHART_COLUMNS`) to the feature set and
 * re-ran the same walk-forward. It did not change the verdict — the best charting
 * variant improved pooled MAE by 0.29 points and was significant on 0 of 3 seasons — so
 * the curve still ships and the charting facts are used only as `drivers`.
 */
import { rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { buildProjections } from './projections.js';

/**
 * The receiving/rushing charting block from `docs/OFFSEASON_MODEL.md` §9 — the one
 * block that was additive over usage trend, age and depth chart in the offseason
 * share/PPG model (prior air-yard share 1.22, YAC over expected 1.17, broken tackles
 * 1.11; −0.0053 SIG on opportunity share). It was re-tested here as a preseason
 * projection feature set and DECLINED as a point estimate (docs/PRESEASON_MODEL.md,
 * "v2"): 0 of 3 seasons significantly better than the market curve. It is carried
 * anyway because it is what orders `drivers` — these are the facts that say WHY a
 * player should out- or under-produce his draft slot, which is what the reader wants
 * even when the model may not act on them.
 *
 * `depth_slot_t` is season T's August-or-later chart and `prior_xfp_diff` is season
 * T−1's actual-minus-expected fantasy points per game; both are strictly preseason.
 */
const CHART_COLUMNS = [
  'prior_ngs_air_yards_share', 'prior_yac_oe', 'prior_broken_tackles',
  'prior_adot', 'prior_drop_pct', 'prior_ryoe_per_att',
  'depth_slot_t', 'prior_xfp_diff'
];

export const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const SKILL = new Set(SKILL_POSITIONS);

/** PPR weights, identical to scoring.js — kept literal so the aggregation below can
 * be read against `nfl_player_week_features`' JSON keys without a translation layer. */
const PPR_W = {
  passing_yards: 0.04, passing_tds: 4, interceptions: -2,
  rushing_yards: 0.1, rushing_tds: 6,
  receptions: 1, receiving_yards: 0.1, receiving_tds: 6
};

/**
 * Name changes between FantasyPros' ECR file and nflverse's rosters. Carried over
 * verbatim from the 2021-2025 audit join, where each one was checked by hand.
 */
const ALIAS = {
  'marquise brown': 'hollywood brown', 'robby anderson': 'robbie anderson',
  'ken walker': 'kenneth walker', 'gabriel davis': 'gabe davis',
  'kenneth gainwell': 'kenny gainwell', 'chigoziem okonkwo': 'chig okonkwo',
  'joshua palmer': 'josh palmer'
};

const TEAM_ALIAS = {
  SFO: 'SF', TAM: 'TB', TBB: 'TB', NOR: 'NO', KAN: 'KC', GNB: 'GB', NWE: 'NE',
  LVR: 'LV', JAC: 'JAX', KCC: 'KC', LAR: 'LA', HST: 'HOU', BLT: 'BAL', CLV: 'CLE', ARZ: 'ARI'
};

const num = v => (Number.isFinite(v) ? v : 0);
const r1 = v => (Number.isFinite(v) ? +v.toFixed(1) : null);
const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);

/* ============================================================ small stats */

export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Fractional ranks with ties averaged — the input to Spearman. */
function rankArray(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export function spearman(xs, ys) {
  if (Math.min(xs.length, ys.length) < 3) return null;
  return pearson(rankArray(xs), rankArray(ys));
}

/**
 * Ridge regression by normal equations.
 *
 * Small feature count and a few thousand rows, so an explicit solve is both fast
 * enough and completely inspectable — which matters more here than speed, because the
 * fitted coefficients are read back out as draft-board explanations.
 */
export function ridgeFit(X, y, { lambda = 1, weights = null } = {}) {
  const n = X.length;
  if (!n) return null;
  const p = X[0].length;
  const w = weights ?? new Array(n).fill(1);
  // Standardize so one penalty is meaningful across features on different scales.
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const col = X.map(r => r[j]);
    mu[j] = mean(col);
    const v = mean(col.map(x => (x - mu[j]) ** 2));
    sd[j] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  const Z = X.map(r => r.map((v, j) => (v - mu[j]) / sd[j]));
  const wSum = w.reduce((s, x) => s + x, 0);
  const yBar = y.reduce((s, v, i) => s + v * w[i], 0) / wSum;

  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const zi = Z[i], wi = w[i], yi = y[i] - yBar;
    for (let a = 0; a < p; a++) {
      const za = zi[a] * wi;
      for (let b = a; b < p; b++) A[a][b] += za * zi[b];
      A[a][p] += za * yi;
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    A[a][a] += lambda * (wSum / n);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-10) continue;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  const beta = new Array(p).fill(0);
  for (let c = 0; c < p; c++) if (Math.abs(A[c][c]) > 1e-10) beta[c] = A[c][p] / A[c][c];
  return { beta, mu, sd, intercept: yBar };
}

export function ridgePredict(model, x) {
  if (!model) return 0;
  let v = model.intercept;
  for (let j = 0; j < model.beta.length; j++) v += model.beta[j] * ((x[j] - model.mu[j]) / model.sd[j]);
  return v;
}

/** Per-feature signed contribution, in target units — what the drivers are ranked by. */
export function ridgeContributions(model, x) {
  if (!model) return [];
  return model.beta.map((b, j) => b * ((x[j] - model.mu[j]) / model.sd[j]));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ============================================================ data layer */

const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

/** Test seam: drop every cached table/fit. */
export function resetPreseasonCache() { cache.clear(); }

/**
 * gsis_id -> every normalized name that source tables have used for him.
 *
 * `players.name` is deliberately NOT one of the sources: the audit found that
 * crosswalk carrying another player's gsis on some rows, and a bad name->gsis edge
 * silently attaches one player's career to another's draft slot.
 */
const nameIndex = () => memo('names', () => {
  const byGsis = new Map();
  const add = (g, n) => {
    if (!g || !n || n === 'NA') return;
    const k = normalizePlayerName(n);
    if (!k) return;
    if (!byGsis.has(g)) byGsis.set(g, new Set());
    byGsis.get(g).add(k);
  };
  for (const r of rows('SELECT DISTINCT gsis_id g, player_name n FROM nfl_depth')) add(r.g, r.n);
  for (const r of rows('SELECT DISTINCT gsis_id g, full_name n FROM nfl_injuries')) add(r.g, r.n);
  for (const r of rows('SELECT DISTINCT player_gsis_id g, player_name n FROM nfl_ffopportunity_weekly')) add(r.g, r.n);
  for (const r of rows('SELECT DISTINCT gsis_id g, player_name n FROM nfl_roster_snapshots WHERE gsis_id IS NOT NULL')) add(r.g, r.n);
  const byName = new Map();
  for (const [g, set] of byGsis) for (const n of set) {
    if (!byName.has(n)) byName.set(n, new Set());
    byName.get(n).add(g);
  }
  return { byGsis, byName };
});

const bioIndex = () => memo('bio', () => new Map(rows(
  `SELECT gsis_id, birth_date, rookie_season, draft_year, draft_round, draft_pick, position
   FROM nflverse_player_positions`).map(b => [b.gsis_id, b])));

/**
 * Season totals per player, rebuilt from play-by-play derived weekly features.
 *
 * This is the same aggregation the 2021-2025 audit validated: r=0.9987 against ESPN's
 * own 2025 season totals (n=413, MAD 1.30) and r=0.9999 against nflverse
 * ffopportunity (n=1,742). `player_week_usage` is NOT used — its player_id goes
 * through the crosswalk that was corrupted for several stars.
 *
 * Fumbles lost are absent from this table, so they are omitted (1-4 pts/season for
 * RB/QB). Every model and every baseline is graded on the same totals, so the
 * omission cannot favour one over another.
 */
export const seasonTotals = season => memo(`totals:${season}`, () => {
  const agg = new Map();
  const teamTargets = new Map(), teamCarries = new Map(), teamAttempts = new Map();
  for (const r of rows(
    `SELECT player_id g, player_name pn, position pos, team, features f
     FROM nfl_player_week_features WHERE season = ? AND week BETWEEN 1 AND 18`, season)) {
    let f;
    try { f = JSON.parse(r.f); } catch { continue; }
    let pts = 0;
    for (const [k, w] of Object.entries(PPR_W)) pts += num(f[k]) * w;
    const pos = r.pos === 'FB' ? 'RB' : r.pos;
    const cur = agg.get(r.g) ?? {
      gsis: r.g, name: r.pn, position: pos, points: 0, games: 0, teams: new Set(), team: null,
      targets: 0, carries: 0, attempts: 0, air_yards: 0, receptions: 0,
      rec_tds: 0, rush_tds: 0, pass_tds: 0, rz_targets: 0, rz_carries: 0
    };
    cur.points += pts;
    cur.games += 1;
    if (r.team) { cur.teams.add(r.team); cur.team = r.team; }
    cur.targets += num(f.targets);
    cur.carries += num(f.carries);
    cur.attempts += num(f.pass_attempts);
    cur.air_yards += num(f.air_yards);
    cur.receptions += num(f.receptions);
    cur.rec_tds += num(f.receiving_tds);
    cur.rush_tds += num(f.rushing_tds);
    cur.pass_tds += num(f.passing_tds);
    cur.rz_targets += num(f.red_zone_targets);
    cur.rz_carries += num(f.red_zone_carries);
    agg.set(r.g, cur);
    if (r.team) {
      teamTargets.set(r.team, (teamTargets.get(r.team) ?? 0) + num(f.targets));
      teamCarries.set(r.team, (teamCarries.get(r.team) ?? 0) + num(f.carries));
      teamAttempts.set(r.team, (teamAttempts.get(r.team) ?? 0) + num(f.pass_attempts));
    }
  }
  for (const a of agg.values()) {
    a.ppg = a.games ? a.points / a.games : 0;
    a.target_share = teamTargets.get(a.team) ? a.targets / teamTargets.get(a.team) : 0;
    a.carry_share = teamCarries.get(a.team) ? a.carries / teamCarries.get(a.team) : 0;
    a.attempt_share = teamAttempts.get(a.team) ? a.attempts / teamAttempts.get(a.team) : 0;
  }
  return { players: agg, teamTargets, teamCarries, teamAttempts };
});

/** Expected vs actual fantasy points (nflverse ffopportunity, 2022+) — the TD-luck term. */
const expectedPoints = season => memo(`ffopp:${season}`, () => new Map(rows(
  `SELECT player_gsis_id g, sum(expected_fantasy_points) xp, sum(actual_fantasy_points) ap,
          count(*) w
   FROM nfl_ffopportunity_weekly WHERE season = ? AND week <= 18 GROUP BY player_gsis_id`,
  season).map(r => [r.g, r])));

/**
 * The market's board for a season.
 *
 * 2021-2025: FantasyPros ECR from `nfl_historical_adp`, joined to gsis by name.
 * 2026 (and any season with no historical ECR row): ESPN's live board from
 * `espn_player_market`, joined by espn_id, which is an exact key and needs no name
 * matching. Rank is recomputed as the order within skill positions in both cases, so
 * the rank->points curve fitted on ECR seasons applies unchanged.
 */
export const marketBoard = season => memo(`market:${season}`, () => {
  const ecr = rows(
    `SELECT player_key, name, position, team, ecr_rank, ecr_std_dev
     FROM nfl_historical_adp WHERE season = ? ORDER BY ecr_rank ASC, name ASC`, season);
  if (ecr.length) return joinEcr(season, ecr);

  const espn = rows(
    `SELECT m.espn_id, m.adp, m.ppr_rank, m.season_proj, p.name, p.position, p.gsis_id, p.team_id
     FROM espn_player_market m LEFT JOIN players p ON p.espn_id = m.espn_id
     WHERE m.season = ? AND m.adp IS NOT NULL ORDER BY m.adp ASC`, season);
  const out = [];
  let skillRank = 0;
  const posCount = {};
  for (const r of espn) {
    if (!SKILL.has(r.position)) continue;
    skillRank++;
    posCount[r.position] = (posCount[r.position] ?? 0) + 1;
    out.push({
      season, gsis: r.gsis_id ?? null, name: r.name, position: r.position, team: null,
      market_rank: skillRank, pos_rank: posCount[r.position], rank_std: null,
      market_points: Number.isFinite(r.season_proj) ? r.season_proj : null,
      source: 'espn_adp', join: r.gsis_id ? 'espn_id' : 'unmatched'
    });
  }
  return out;
});

/**
 * ECR name -> gsis. Ported from the audit's validated join: candidate names from four
 * roster sources, then position, then nflverse's abbreviated form ("R.White"), then
 * team, as tie-breaks. Disambiguation is allowed to look at season T's own roster —
 * it decides WHICH player a row is, never anything about how he performed.
 */
function joinEcr(season, ecr) {
  const { byName, byGsis } = nameIndex();
  const bio = bioIndex();
  const prior = seasonTotals(season - 1).players;
  const current = seasonTotals(season).players;
  const known = g => current.get(g) ?? prior.get(g) ?? null;
  const out = [];
  let skillRank = 0;
  const posCount = {};
  for (const r of ecr) {
    if (!SKILL.has(r.position)) continue;
    skillRank++;
    posCount[r.position] = (posCount[r.position] ?? 0) + 1;
    const keys = [r.player_key];
    if (ALIAS[r.player_key]) keys.push(ALIAS[r.player_key]);
    const cands = new Set();
    for (const k of keys) for (const g of byName.get(k) ?? []) cands.add(g);
    const list = [...cands];
    const abbrOK = g => {
      const totals = known(g);
      if (!totals) return false;
      const pn = normalizePlayerName(String(totals.name).replace('.', ' '));
      const parts = r.player_key.split(' ');
      return pn === `${parts[0][0]} ${parts.slice(1).join(' ')}`
        || pn === `${parts[0][0]} ${parts[parts.length - 1]}`;
    };
    const withStats = list.filter(g => known(g));
    const posMatch = withStats.filter(g => known(g).position === r.position);
    let chosen = null, how = null;
    const pick = (arr, tag) => {
      if (!arr.length) return false;
      if (arr.length === 1) { chosen = arr[0]; how = tag; return true; }
      const a = arr.filter(abbrOK);
      if (a.length === 1) { chosen = a[0]; how = `${tag}+abbr`; return true; }
      const pool = a.length ? a : arr;
      const t = pool.filter(g => known(g).teams?.has(r.team) || known(g).teams?.has(TEAM_ALIAS[r.team]));
      if (t.length === 1) { chosen = t[0]; how = `${tag}+team`; return true; }
      how = 'ambiguous';
      return true;
    };
    pick(posMatch, 'name+pos') || pick(withStats, 'name-only');
    if (!chosen && list.length) {
      // On a roster somewhere but no stat line either season: a real player who did
      // not play. Scored as 0 points / 0 games rather than dropped, because dropping
      // him is exactly the survivorship bias that flatters a preseason model.
      const byPos = list.filter(g => bio.get(g)?.position === r.position);
      chosen = byPos[0] ?? list[0];
      how = 'known-no-stats';
    }
    out.push({
      season, gsis: chosen ?? null, name: r.name, player_key: r.player_key,
      position: r.position, team: r.team, market_rank: skillRank,
      pos_rank: posCount[r.position], rank_std: r.ecr_std_dev ?? null,
      market_points: null, source: 'fpecr', join: how ?? 'unmatched'
    });
  }
  return out;
}

/**
 * The charting columns of `off_player_season_features` for season `season`, keyed by
 * gsis. Read-only, and absent-table tolerant: the block is a driver input, not a
 * dependency, and a database that has never run an offseason sync must still produce a
 * board.
 */
const chartRows = season => memo(`chart:${season}`, () => {
  try {
    return new Map(rows(
      `SELECT gsis_id, ${CHART_COLUMNS.join(', ')} FROM off_player_season_features
       WHERE season = ?`, season).map(r => [r.gsis_id, r]));
  } catch { return new Map(); }
});

/**
 * Median of each charting column over the players who actually have it, used to impute
 * the ones who do not.
 *
 * Taken over the season's own charting table rather than over the training seasons.
 * That differs from `scratchpad/preseason/v2.mjs`, which pooled the medians across the
 * training rows; the difference is a fraction of a standard deviation on every column
 * and it cannot affect the shipped number, because the shipped blend puts zero weight
 * on the head these features feed. It is chosen here so that a single season's board
 * can be built without loading its training seasons.
 */
const chartMedians = season => memo(`chartmed:${season}`, () => {
  const all = [...chartRows(season).values()];
  const out = {};
  for (const c of CHART_COLUMNS) {
    const v = all.map(r => r[c]).filter(Number.isFinite).sort((a, b) => a - b);
    out[c] = v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  return out;
});

/** projections.js season output for the season after `through`, keyed by gsis. */
const inHouseProjections = through => memo(`proj:${through}`, () => {
  const out = new Map();
  try {
    for (const p of buildProjections({ through }).values()) {
      if (p.gsis_id) out.set(p.gsis_id, p);
    }
  } catch { /* projections are a feature, not a dependency — absence is imputed */ }
  return out;
});

/* ============================================================ features */

/**
 * The feature vector, in a fixed order. `FEATURE_NAMES` is the contract shared by the
 * ridge fit, the GBM and the driver strings — index i is always the same quantity.
 */
export const FEATURE_NAMES = [
  'log_market_rank', 'log_pos_rank', 'rank_std',
  'ppg_1', 'ppg_2', 'ppg_3', 'ppg_w',
  'games_1', 'games_2', 'availability_3',
  'target_share_1', 'carry_share_1', 'attempt_share_1',
  'targets_pg_1', 'carries_pg_1', 'air_yards_pg_1',
  'td_luck_pg_1', 'has_history',
  'rookie', 'draft_capital', 'age',
  'is_QB', 'is_RB', 'is_WR', 'is_TE',
  'proj_ppg', 'proj_games', 'proj_points',
  // v2 charting block. Each column comes with a has_* indicator, because its absence is
  // structural rather than random — NGS receiving columns exist only for pass catchers
  // with enough routes (43-46% of the board), rush-yards-over-expected only for backs
  // with enough carries (21%). Imputing the median without saying so would tell the fit
  // that a quarterback has an average receiver's air-yards share.
  ...CHART_COLUMNS.flatMap(c => [c, `has_${c}`])
];

const DRIVER_LABEL = {
  log_market_rank: 'market rank', log_pos_rank: 'positional rank', rank_std: 'expert disagreement',
  ppg_1: 'last season ppg', ppg_2: 'two seasons ago ppg', ppg_3: 'three seasons ago ppg',
  ppg_w: 'recency-weighted ppg', games_1: 'games last season', games_2: 'games two seasons ago',
  availability_3: 'three-year availability', target_share_1: 'target share',
  carry_share_1: 'carry share', attempt_share_1: 'dropback share',
  targets_pg_1: 'targets per game', carries_pg_1: 'carries per game',
  air_yards_pg_1: 'air yards per game', td_luck_pg_1: 'points over expected',
  has_history: 'NFL history', rookie: 'rookie', draft_capital: 'draft capital', age: 'age',
  proj_ppg: 'in-house per-game projection', proj_games: 'in-house expected games',
  proj_points: 'in-house season projection',
  prior_ngs_air_yards_share: 'air-yards share', prior_yac_oe: 'YAC over expected',
  prior_broken_tackles: 'broken tackles', prior_adot: 'average depth of target',
  prior_drop_pct: 'drop rate', prior_ryoe_per_att: 'rush yards over expected',
  depth_slot_t: 'depth-chart slot', prior_xfp_diff: 'points over expected fantasy points'
};

/**
 * One player's features for target season `season`, using only seasons <= season-1.
 *
 * Exported so a test can hand it synthetic aggregates and check each field, and so a
 * caller can see exactly what the model was shown.
 */
export function buildFeatureRow(entry, ctx) {
  const { season, priorTotals, ffopp, bio, projections, chart, chartMedian } = ctx;
  const g = entry.gsis;
  const s1 = g ? priorTotals[0]?.get(g) ?? null : null;
  const s2 = g ? priorTotals[1]?.get(g) ?? null : null;
  const s3 = g ? priorTotals[2]?.get(g) ?? null : null;
  const b = g ? bio?.get(g) ?? null : null;
  const proj = g ? projections?.get(g) ?? null : null;

  const ppg1 = s1?.ppg ?? 0, ppg2 = s2?.ppg ?? 0, ppg3 = s3?.ppg ?? 0;
  const games1 = s1?.games ?? 0, games2 = s2?.games ?? 0, games3 = s3?.games ?? 0;
  // Recency-weighted ppg: last season counts most, but one season is a small sample
  // and the two before it carry real information about the true level.
  const wSum = (s1 ? 1 : 0) + (s2 ? 0.55 : 0) + (s3 ? 0.3 : 0);
  const ppgW = wSum ? (ppg1 * (s1 ? 1 : 0) + ppg2 * (s2 ? 0.55 : 0) + ppg3 * (s3 ? 0.3 : 0)) / wSum : 0;

  const ff = g ? ffopp?.get(g) ?? null : null;
  // Points over expected per game, capped: a receiver who scored on a third of his red
  // zone looks like a star and is really a regression candidate. Capping stops one
  // freak season from dominating a linear fit.
  const tdLuck = ff && ff.w > 0 && Number.isFinite(ff.xp) && Number.isFinite(ff.ap)
    ? Math.max(-6, Math.min(6, (ff.ap - ff.xp) / ff.w)) : 0;

  const age = b?.birth_date
    ? (Date.parse(`${season}-09-01`) - Date.parse(b.birth_date)) / (365.25 * 864e5) : null;
  const rookie = b?.rookie_season === season ? 1 : 0;
  // Draft capital on a 0-1 scale: pick 1 -> 1, undrafted -> 0.
  const pick = Number.isFinite(b?.draft_pick) ? b.draft_pick : null;
  const draftCapital = pick ? Math.max(0, 1 - Math.log(pick) / Math.log(262)) : 0;

  const f = {
    log_market_rank: Math.log(entry.market_rank),
    log_pos_rank: Math.log(entry.pos_rank),
    rank_std: Number.isFinite(entry.rank_std) ? entry.rank_std : 0,
    ppg_1: ppg1, ppg_2: ppg2, ppg_3: ppg3, ppg_w: ppgW,
    games_1: games1, games_2: games2,
    availability_3: (games1 + games2 + games3) / 51,
    target_share_1: s1?.target_share ?? 0,
    carry_share_1: s1?.carry_share ?? 0,
    attempt_share_1: s1?.attempt_share ?? 0,
    targets_pg_1: games1 ? (s1.targets / games1) : 0,
    carries_pg_1: games1 ? (s1.carries / games1) : 0,
    air_yards_pg_1: games1 ? (s1.air_yards / games1) : 0,
    td_luck_pg_1: tdLuck,
    has_history: s1 ? 1 : 0,
    rookie, draft_capital: draftCapital,
    age: age ?? 25.5,
    is_QB: entry.position === 'QB' ? 1 : 0,
    is_RB: entry.position === 'RB' ? 1 : 0,
    is_WR: entry.position === 'WR' ? 1 : 0,
    is_TE: entry.position === 'TE' ? 1 : 0,
    proj_ppg: proj?.ppg ?? 0,
    proj_games: proj?.expected_games ?? 0,
    proj_points: proj?.points ?? 0
  };

  // v2 charting block. The player's own value where the feed has one, the board median
  // where it does not, and a has_* indicator either way so the fit can tell the two
  // apart. Absence is structural — a quarterback has no air-yards share and a receiver
  // has no rush yards over expected — so imputing silently would teach the model that
  // every QB sits at the median receiver's charting profile.
  const ch = g ? chart?.get(g) ?? null : null;
  for (const c of CHART_COLUMNS) {
    const v = ch?.[c];
    const ok = Number.isFinite(v);
    f[c] = ok ? v : num(chartMedian?.[c]);
    f[`has_${c}`] = ok ? 1 : 0;
  }

  return {
    ...entry,
    features: f,
    vector: FEATURE_NAMES.map(n => num(f[n])),
    raw: { s1, s2, s3, bio: b, proj, age, ff, chart: ch },
    has_projection: !!proj
  };
}

/**
 * Every top-`limit` market player for `season`, with features from <= season-1 and,
 * when the season is complete, the realized target.
 */
export function buildSeasonRows(season, { limit = 200 } = {}) {
  return memo(`rows:${season}:${limit}`, () => {
    const ctx = {
      season,
      priorTotals: [1, 2, 3].map(k => seasonTotals(season - k).players),
      ffopp: expectedPoints(season - 1),
      bio: bioIndex(),
      projections: inHouseProjections(season - 1),
      // Season T's own `off_player_season_features` row: its `prior_*` columns already
      // hold T−1 charting and `depth_slot_t` is T's August-or-later chart, so both are
      // strictly preseason for target season T.
      chart: chartRows(season),
      chartMedian: chartMedians(season)
    };
    const actual = seasonTotals(season).players;
    const board = marketBoard(season).filter(e => e.market_rank <= limit);
    return board.map(e => {
      const row = buildFeatureRow(e, ctx);
      const a = e.gsis ? actual.get(e.gsis) ?? null : null;
      // A market-ranked player with no stat line played zero games. That is an
      // outcome, not missing data.
      row.actual_points = e.gsis ? (a?.points ?? 0) : null;
      row.actual_games = e.gsis ? (a?.games ?? 0) : null;
      row.actual_ppg = a?.games ? a.points / a.games : null;
      return row;
    });
  });
}

/* ============================================================ the market curve */

/**
 * Points the AVERAGE player drafted at each positional rank actually scored, fitted on
 * `seasons` with a Gaussian kernel over rank.
 *
 * This is the honest form of "what does the market say he is worth". Using the points
 * of the player who FINISHED at that rank instead would bake in the mean-reversion
 * artifact: the #1 slot would be credited with the best season anyone had, which no
 * #1 pick has ever averaged.
 */
export function fitMarketCurve(trainRows, { bandwidth = 9 } = {}) {
  const byPos = new Map();
  for (const r of trainRows) {
    if (r.actual_points == null) continue;
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position).push({ rank: r.pos_rank, points: r.actual_points, games: r.actual_games });
  }
  const curves = {};
  for (const [pos, list] of byPos) {
    const maxRank = Math.max(...list.map(x => x.rank));
    const pts = [], gms = [];
    for (let rank = 1; rank <= maxRank + 40; rank++) {
      // LOCAL LINEAR, not a local average. A plain kernel average is biased at the
      // ends of a sloped curve — at rank 1 every neighbour is a worse player, so the
      // fit drags the #1 slot down. Measured on held-out 2023-25 that cost the elite
      // QB slot 38 points and the elite TE slot 35; a local linear fit removes it
      // (docs/PRESEASON_MODEL.md, "what the curve is").
      let wSum = 0, dSum = 0, pSum = 0, ddSum = 0, dpSum = 0, gSum = 0, dgSum = 0;
      for (const x of list) {
        const w = Math.exp(-((x.rank - rank) ** 2) / (2 * bandwidth ** 2));
        const d = x.rank - rank;
        wSum += w; dSum += w * d; ddSum += w * d * d;
        pSum += w * x.points; dpSum += w * d * x.points;
        gSum += w * x.games; dgSum += w * d * x.games;
      }
      if (wSum <= 0) { pts.push(0); gms.push(0); continue; }
      const den = wSum * ddSum - dSum * dSum;
      const slope = (t, dt) => (Math.abs(den) > 1e-9 ? (wSum * dt - dSum * t) / den : 0);
      pts.push((pSum - slope(pSum, dpSum) * dSum) / wSum);
      gms.push((gSum - slope(gSum, dgSum) * dSum) / wSum);
    }
    // Enforce monotonicity: the curve must not say rank 20 is worth more than rank 19.
    // Kernel smoothing on five noisy seasons produces small inversions that would
    // otherwise show up as "the model likes the later pick", which is an artifact.
    for (let i = 1; i < pts.length; i++) if (pts[i] > pts[i - 1]) pts[i] = pts[i - 1];
    curves[pos] = { points: pts, games: gms };
  }
  return curves;
}

export function marketCurvePoints(curves, position, posRank) {
  const c = curves[position];
  if (!c) return null;
  const i = Math.min(Math.max(1, Math.round(posRank)), c.points.length) - 1;
  return c.points[i];
}

export function marketCurveGames(curves, position, posRank) {
  const c = curves[position];
  if (!c) return null;
  const i = Math.min(Math.max(1, Math.round(posRank)), c.games.length) - 1;
  return Math.max(4, Math.min(17, c.games[i]));
}

/* ============================================================ the model */

/**
 * SHIPPED WEIGHTS — and why they are what they are.
 *
 * The walk-forward evaluation (T = 2023/2024/2025, fitted only on seasons < T, graded
 * on identical player sets) is in `docs/PRESEASON_MODEL.md`. Its result:
 *
 *   pooled Spearman / MAE     market curve 0.5912 / 58.00
 *                             ridge        0.5778 / 61.71
 *                             GBM          0.5707 / 59.41
 *                             stacked      0.5890-0.5901 / 57.85-58.24
 *
 * Every model-bearing variant is inside the paired-bootstrap noise band against the
 * market curve on all three seasons — 0 of 3 significantly better, 0 of 3
 * significantly worse. Under this repo's governance that is a DECLINE, not a ship. So
 * the point estimate is the market curve alone. The learned heads are still fitted and
 * still reported, as `components.model` and as the ordering behind `drivers`: saying
 * where the model disagrees with the board is useful even when acting on the
 * disagreement is not justified.
 */
export const SHIPPED_BLEND = { market: 1, structural: 0, model: 0 };

/**
 * The live board's model-nudge weight — `draft-assist.js` computes
 * `projected_points = ESPN_points x (1 + w x rel)`, with `rel` the projections.js number
 * relative to the board, clipped to +/-35% after dividing out the top-150 mean ratio.
 *
 * 0.2, not the 0.4 that was there: with the market curve standing in for ESPN's points,
 * 0.2 is the only weight that beat w=0 on MAE in 2 of 3 held-out seasons at BOTH top-150
 * and top-200, and it keeps most of the TE gain (-1.03 MAE) while halving the damage
 * 0.4 does to QB (+0.90) and RB (+0.53). No weight was significant on any season
 * (0/3 paired bootstrap), so this is a small, safe reduction of an unvalidated knob
 * rather than a claim that the nudge works — see docs/PRESEASON_MODEL.md, "v2".
 */
export const RECOMMENDED_MODEL_BLEND_WEIGHT = 0.2;

/**
 * Fit the curve and the two learned heads on `trainRows`.
 *
 * ppg is fitted only on players who actually played (>= 4 games), weighted by games:
 * a per-game rate is only estimable when there are games, and a 1-game sample should
 * not carry the weight of a 17-game one. Availability is the separate head, fitted on
 * everyone including the zeros.
 *
 * NOTE ON THE BLEND: no weights are searched here. Fitting stack weights on the same
 * rows the components were fitted on hands almost all the weight to whichever
 * component overfits hardest (the first cut of this did exactly that — the GBM took
 * weight 1.0 because its in-sample residuals are near zero). The honest version needs
 * out-of-fold component predictions; that was run in
 * `scratchpad/preseason/final.mjs`, produced weights of market 0.4-0.85, and still did
 * not clear the significance bar. Hence the fixed `SHIPPED_BLEND`.
 */
export function fitPreseasonModel(trainRows, { lambdaPpg = 12, lambdaGames = 12, curveBandwidth = 9 } = {}) {
  const graded = trainRows.filter(r => r.actual_points != null);
  const curves = fitMarketCurve(graded, { bandwidth: curveBandwidth });

  const ppgRows = graded.filter(r => r.actual_games >= 4);
  const ppgModel = ridgeFit(
    ppgRows.map(r => r.vector), ppgRows.map(r => r.actual_ppg),
    { lambda: lambdaPpg, weights: ppgRows.map(r => r.actual_games) });
  const gamesModel = ridgeFit(
    graded.map(r => r.vector), graded.map(r => r.actual_games), { lambda: lambdaGames });

  const model = { curves, ppgModel, gamesModel, blend: { ...SHIPPED_BLEND }, spread: null, train_n: graded.length };

  // Interval width from training residual ratios, per position. Ratios rather than
  // absolute residuals because a 300-point projection is wrong by more points than a
  // 60-point one, and a draft board needs a band that scales with the number.
  // Banded by position AND draft tier. Pooling them produced a band so wide it was
  // useless (the QB1 slot inherited the relative error of QB40, whose outcomes range
  // from zero to a starting job). A late pick genuinely is far more uncertain in
  // relative terms than an early one, and the band has to say so.
  const spread = {};
  for (const pos of SKILL_POSITIONS) {
    spread[pos] = {};
    for (const tier of SPREAD_TIERS) {
      const ratios = graded
        .filter(r => r.position === pos && r.pos_rank >= tier.lo && r.pos_rank <= tier.hi)
        .map(r => {
          const p = blendPoints(model, componentsFor(model, r));
          return p > 20 ? r.actual_points / p : null;
        })
        .filter(v => v != null && Number.isFinite(v))
        .sort((x, y) => x - y);
      spread[pos][tier.name] = ratios.length >= 20
        ? { p20: +quantile(ratios, 0.2).toFixed(3), p80: +quantile(ratios, 0.8).toFixed(3), n: ratios.length }
        : { p20: 0.5, p80: 1.5, n: ratios.length };
    }
  }
  model.spread = spread;
  return model;
}

/** Draft tiers the prediction interval is banded by. */
export const SPREAD_TIERS = [
  { name: 'early', lo: 1, hi: 12 },
  { name: 'middle', lo: 13, hi: 36 },
  { name: 'late', lo: 37, hi: 9999 }
];

export const spreadFor = (model, position, posRank) => {
  const tier = SPREAD_TIERS.find(t => posRank >= t.lo && posRank <= t.hi) ?? SPREAD_TIERS[2];
  return model.spread?.[position]?.[tier.name] ?? { p20: 0.5, p80: 1.5 };
};

/**
 * The three components a prediction is built from, all in season-points units.
 *
 * `games` is the MARKET CURVE's expected games, not the fitted availability head. The
 * head was measured against it on held-out seasons and lost on all three (MAE 3.61 vs
 * 3.11 games, paired bootstrap significant every season): games missed next season are
 * essentially not forecastable from prior usage, and the average games played at a
 * draft slot beats a model that tries. The head is still fitted and exposed as
 * `model_games` so the disagreement is visible.
 */
export function componentsFor(model, row) {
  // Always the fitted curve, never the vendor's own season projection even when the
  // board carries one (ESPN publishes `season_proj` for 2026). No historical ESPN
  // projections are stored, so that number has never been graded here — using it would
  // ship an unvalidated forecast under a validated model's name. It is reported
  // alongside as `vendor_points` instead.
  const market = marketCurvePoints(model.curves, row.position, row.pos_rank) ?? 0;
  // projections.js has nothing for a rookie or a returning absentee. Falling back to
  // the market curve keeps the component defined for every player without inventing a
  // number, and is recorded in `has_projection` so the docs can report coverage.
  const structural = row.has_projection ? row.features.proj_points : market;
  const ppg = Math.max(0, ridgePredict(model.ppgModel, row.vector));
  const modelGames = Math.max(0, Math.min(17, ridgePredict(model.gamesModel, row.vector)));
  const games = marketCurveGames(model.curves, row.position, row.pos_rank) ?? 14;
  return { market, structural, model: ppg * modelGames, ppg, games, model_games: modelGames };
}

export function blendPoints(model, c) {
  const w = model.blend ?? SHIPPED_BLEND;
  return w.market * c.market + w.structural * c.structural + w.model * c.model;
}

/* ============================================================ drivers */

/**
 * Up to five short strings saying WHY, each tied to a feature value the reader can
 * check. Ordered by the ridge's own signed contribution to ppg, so the reasons given
 * are the reasons the model used, not a hand-written narrative laid over the top.
 */
export function driversFor(model, row, prediction) {
  const out = [];
  const season = row.season;
  const s1 = row.raw.s1, s2 = row.raw.s2;
  const f = row.features;
  // The player's OWN charting row, or an empty object. Every read of it below is gated
  // on the matching `has_*` feature, which is 1 only when this row supplied the value —
  // so a median-imputed field can never be printed as a fact about this player.
  const ch = row.raw.chart ?? {};
  const contrib = ridgeContributions(model.ppgModel, row.vector);
  const order = FEATURE_NAMES
    .map((n, i) => ({ name: n, v: contrib[i], value: row.vector[i] }))
    .filter(x => Math.abs(x.v) > 0.08)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));

  const pct = v => `${(v * 100).toFixed(0)}%`;
  const used = new Set();
  const push = (key, text) => {
    if (used.has(key) || out.length >= 5 || !text) return;
    used.add(key); out.push(text);
  };

  // Availability first when it is doing real work — the audit's loudest finding.
  // Availability first when it is doing real work — but as a RISK FLAG, not a
  // discount. Prior missed games lost to the flat slot average when both were graded
  // on held-out expected games, so the number is not reduced; the reader is told.
  const missed = s1 ? 17 - s1.games : null;
  if (missed != null && missed >= 3) {
    push('avail', `missed ${missed} game${missed === 1 ? '' : 's'} in ${season - 1} — risk flag only, `
      + `not discounted (missed games did not forecast next-season availability out-of-sample)`);
  }

  for (const x of order) {
    if (out.length >= 5) break;
    switch (x.name) {
      case 'target_share_1':
        if (s1 && s1.target_share > 0.12) {
          push('tgt', `${pct(s1.target_share)} target share in ${season - 1}`
            + (s2 && s2.target_share > 0.12 ? ' — second straight season above 12%' : ''));
        }
        break;
      case 'carry_share_1':
        if (s1 && s1.carry_share > 0.25) {
          push('car', `${pct(s1.carry_share)} of his team's carries in ${season - 1}`
            + ` (${(s1.carries / Math.max(1, s1.games)).toFixed(1)}/game)`);
        }
        break;
      case 'ppg_w': case 'ppg_1':
        if (s1) push('ppg', `${s1.ppg.toFixed(1)} ppg in ${season - 1}`
          + (s2 ? ` after ${s2.ppg.toFixed(1)} in ${season - 2}` : ''));
        break;
      case 'td_luck_pg_1':
        if (row.features.td_luck_pg_1 >= 1) {
          push('luck', `scored ${row.features.td_luck_pg_1.toFixed(1)} pts/game above expected in `
            + `${season - 1} — touchdown rate regresses`);
        } else if (row.features.td_luck_pg_1 <= -1) {
          push('luck', `${Math.abs(row.features.td_luck_pg_1).toFixed(1)} pts/game BELOW expected in `
            + `${season - 1} — positive regression candidate`);
        }
        break;
      case 'air_yards_pg_1':
        if (s1 && s1.games && s1.air_yards / s1.games > 60) {
          push('air', `${(s1.air_yards / s1.games).toFixed(0)} air yards per game in ${season - 1}`);
        }
        break;
      case 'rookie':
        if (row.features.rookie) {
          const b = row.raw.bio;
          push('rook', b?.draft_round
            ? `rookie, round ${b.draft_round} pick ${b.draft_pick ?? '?'} — no NFL usage to price`
            : 'rookie — no NFL usage to price');
        }
        break;
      case 'age':
        if (row.raw.age != null && (row.raw.age >= 30 || row.raw.age <= 22.5)) {
          push('age', `age ${row.raw.age.toFixed(1)} in ${season}`);
        }
        break;
      case 'attempt_share_1':
        if (s1 && s1.attempts > 200) {
          push('att', `${Math.round(s1.attempts / Math.max(1, s1.games))} pass attempts per game in ${season - 1}`);
        }
        break;

      // ---- v2 charting facts. Every one is gated on its has_* indicator, so an
      // imputed median is never stated as if it were the player's own number, and every
      // one is gated on a threshold, so the line only appears when the fact is actually
      // extreme enough to explain something. These do NOT move the projection — the
      // shipped blend is the market curve — they say why the learned head leans.
      case 'prior_ngs_air_yards_share': {
        const v = ch.prior_ngs_air_yards_share;
        if (!f.has_prior_ngs_air_yards_share) break;
        if (v >= 25) push('ayshare', `${v.toFixed(0)}% of his team's air yards in ${season - 1}`);
        else if (v <= 12) push('ayshare', `only ${v.toFixed(0)}% of his team's air yards in ${season - 1}`
          + ' — a complementary role, not a focal one');
        break;
      }
      case 'prior_xfp_diff': {
        const v = ch.prior_xfp_diff;
        // Same fact as td_luck_pg_1 (actual minus expected fantasy points per game),
        // measured uncapped by the offseason feed. Shares the 'luck' key so the two can
        // never both be printed.
        if (!f.has_prior_xfp_diff || Math.abs(v) < 1) break;
        push('luck', v > 0
          ? `scored ${v.toFixed(1)} pts/game above expected in ${season - 1} — touchdown rate regresses`
          : `${Math.abs(v).toFixed(1)} pts/game BELOW expected in ${season - 1} — positive regression candidate`);
        break;
      }
      case 'prior_yac_oe': {
        const v = ch.prior_yac_oe;
        if (!f.has_prior_yac_oe) break;
        if (v >= 1) push('yac', `${v.toFixed(1)} yards after the catch above expected in ${season - 1}`);
        else if (v <= -0.5) push('yac', `${v.toFixed(1)} yards after the catch below expected in ${season - 1}`);
        break;
      }
      case 'prior_broken_tackles':
        if (f.has_prior_broken_tackles && ch.prior_broken_tackles >= 8) {
          push('brk', `${ch.prior_broken_tackles.toFixed(0)} broken tackles in ${season - 1}`);
        }
        break;
      case 'prior_ryoe_per_att': {
        const v = ch.prior_ryoe_per_att;
        if (!f.has_prior_ryoe_per_att) break;
        if (v >= 0.4) push('ryoe', `+${v.toFixed(2)} rush yards over expected per carry in ${season - 1}`);
        else if (v <= -0.3) push('ryoe', `${v.toFixed(2)} rush yards over expected per carry in `
          + `${season - 1} — the blocking was doing the work`);
        break;
      }
      case 'prior_adot': {
        const v = ch.prior_adot;
        // Receivers and tight ends only. The column is populated for backs too, but a
        // back's average depth of target is near zero by definition of the position, so
        // saying so is not a fact about the player — it crowded out real drivers.
        if (!f.has_prior_adot || (row.position !== 'WR' && row.position !== 'TE')) break;
        if (v >= 12) push('adot', `${v.toFixed(1)}-yard average depth of target in ${season - 1} — a downfield role`);
        else if (v <= 4) push('adot', `${v.toFixed(1)}-yard average depth of target in ${season - 1}`
          + ' — volume-dependent, little big-play equity');
        break;
      }
      case 'prior_drop_pct':
        if (f.has_prior_drop_pct && ch.prior_drop_pct >= 0.09) {
          push('drop', `${(ch.prior_drop_pct * 100).toFixed(0)}% drop rate in ${season - 1}`);
        }
        break;
      case 'depth_slot_t':
        if (f.has_depth_slot_t && ch.depth_slot_t >= 2) {
          push('depth', `listed ${ch.depth_slot_t}${ch.depth_slot_t === 2 ? 'nd' : ch.depth_slot_t === 3 ? 'rd' : 'th'}`
            + ` on the ${season} depth chart, not first`);
        }
        break;
      default: break;
    }
  }

  // The board slot is always stated, so it is appended last with room reserved for
  // it — a caller that renders only the drivers must never be left without the one
  // line that anchors everything else.
  out.splice(4);
  // Where the (declined, unblended) learned head disagrees with that slot's average. Phrased as a disagreement
  // rather than an edge: it did not beat the board out-of-sample.
  const head = prediction.components.model ?? 0;
  const slot = prediction.components.market ?? 0;
  push('market', `${row.position}${row.pos_rank} on the board (overall ${row.market_rank})`
    + (Math.abs(head - slot) >= 20
      ? ` — ${head.toFixed(0)} pts if he repeats last season's role for a normal season; `
        + `the ${slot.toFixed(0)}-pt slot average ${head > slot ? 'includes the busts' : 'is what this slot has actually averaged'}`
      : ' — repeat-his-role case matches the slot average'));

  return out.slice(0, 5);
}

/* ============================================================ public API */

const DEFAULT_SEASON = Number(process.env.NFL_SEASON) || 2026;

/**
 * The shipped fit for `season`: trained on every graded season strictly before it.
 */
function shippedModel(season) {
  return memo(`fit:${season}`, () => {
    const train = [];
    for (let s = 2022; s < season; s++) {
      // Fit on the top 450 of each board rather than the top 200 the model is graded
      // on: the deep ranks are what pin down the tail of the curve, and the extra rows
      // measurably steadied the fit for the earliest target season.
      for (const r of buildSeasonRows(s, { limit: 450 })) if (r.actual_points != null) train.push(r);
    }
    return train.length >= 200 ? fitPreseasonModel(train) : null;
  });
}

/**
 * Season-long projection for every market-ranked player.
 *
 * @returns Map<gsis_id, projection>
 */
export function preseasonProjections(season = DEFAULT_SEASON) {
  return memo(`projections:${season}`, () => {
    const model = shippedModel(season);
    const out = new Map();
    if (!model) return out;
    for (const row of buildSeasonRows(season, { limit: 400 })) {
      if (!row.gsis) continue;
      const c = componentsFor(model, row);
      const points = blendPoints(model, c);
      // Expected games is the average games actually played at this draft slot,
      // clamped away from the degenerate ends: nobody is a certainty for 17 and nobody
      // ranked this highly is a certainty for 0.
      const games = Math.max(4, Math.min(17, c.games));
      const sp = spreadFor(model, row.position, row.pos_rank);
      const projection = {
        player_id: row.gsis, gsis_id: row.gsis, name: row.name, position: row.position,
        season, market_rank: row.market_rank, pos_rank: row.pos_rank,
        points: r1(points), ppg: r2(points / games), expected_games: r1(games),
        p20: r1(points * sp.p20), p80: r1(points * sp.p80),
        // `model` is reported, not blended in — it is the declined learned head, kept
        // so a caller can show where the model disagrees with the board.
        components: { market: r1(c.market), structural: r1(c.structural), model: r1(c.model) },
        model_expected_games: r1(c.model_games),
        // The board vendor's own season projection where it publishes one (ESPN, 2026).
        // Never graded against history here, so it is shown, not used.
        vendor_points: r1(row.market_points ?? NaN),
        drivers: []
      };
      projection.drivers = driversFor(model, row, {
        points: projection.points, expected_games: games, components: projection.components
      });
      out.set(row.gsis, projection);
    }
    return out;
  });
}

/**
 * One player's projection. Accepts a gsis_id, a `players.id`, or an espn_id — the
 * draft board holds all three depending on which sync produced the row.
 */
export function preseasonProjection(playerId, season = DEFAULT_SEASON) {
  const all = preseasonProjections(season);
  if (playerId == null) return null;
  const key = String(playerId);
  if (all.has(key)) return all.get(key);
  const p = rows(
    `SELECT gsis_id FROM players WHERE id = ? OR espn_id = ? OR gsis_id = ? LIMIT 1`,
    Number(key) || -1, Number(key) || -1, key)[0];
  return p?.gsis_id ? all.get(p.gsis_id) ?? null : null;
}
