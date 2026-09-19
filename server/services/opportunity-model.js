/**
 * O1 — the opportunity model: how many chances a player gets next week.
 *
 * This is the volume half of a fantasy projection, separated from the
 * efficiency half on purpose. Targets, carries and pass attempts are far more
 * stable week to week than yards per target or touchdown rate, so predicting
 * them well is where the room is; the plan's own measurement put the head that
 * used to do this only 1.5-5.7% ahead of a season average.
 *
 * Three rules this module holds itself to, because earlier attempts at the same
 * thing failed on them:
 *
 * 1. **Usage is a number, not a label.** There are no bell-cow / committee /
 *    depth buckets here. A player's role enters as his own measured share, his
 *    snap share and their trends; a teammate's absence enters as the share that
 *    teammate actually carried, not as a category.
 * 2. **Strictly prior.** Every feature is computed from weeks before the graded
 *    week, or from information published before kickoff (the Friday injury
 *    report, the closing spread and total). `buildOpportunityRows` never reads
 *    the graded week's box score except to record the answer.
 * 3. **Graded against the thing it replaces.** The baselines are in the same
 *    file as the model, measured on the same rows, and the study script reports
 *    a paired bootstrap clustered by player. A model that does not beat
 *    share-times-volume is not shipped.
 */
import { rows } from '../db/index.js';
import { solveLinear } from './forecast-combination.js';

/** Positions we model, and the opportunity each one is actually competing for. */
export const OPPORTUNITY_STATS = Object.freeze({
  QB: 'attempts',
  RB: 'carries',
  WR: 'targets',
  TE: 'targets'
});

/** RBs get a second head: their receiving work is a different competition. */
export const SECONDARY_STATS = Object.freeze({ RB: 'targets' });

const EWMA_ALPHA = 0.4;
const MIN_PRIOR_GAMES = 2;
const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

export const FEATURE_NAMES = Object.freeze([
  'share_ewma',          // his own share of the team's chances, recency-weighted
  'share_season',        // and flat over the season so far
  'share_last',          // last week alone, which moves first when a role changes
  'share_trend',         // last week minus the season mean: is the role opening or closing
  'snap_ewma',           // snap share carries role changes a week before the box score does
  'snap_trend',
  'xfp_ewma',            // ffopportunity's expected points: quality of the chances, not just the count
  'team_volume_ewma',    // how many chances the offence generates at all
  'vacated_same_pos',    // share carried by same-position teammates ruled out this week
  'vacated_team',        // and by every skill teammate ruled out, since targets cross positions
  'self_questionable',   // he is playing, but hurt
  'implied_points',      // the market's view of how much offence there is to share
  'spread',              // sign matters: trailing teams throw, leading teams run
  'opp_volume_faced',    // the defence's own funnel, measured not assumed
  'prior_games',         // how much of the above we actually have
  'rest_days'
]);

const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

function ewma(series, alpha = EWMA_ALPHA) {
  if (!series.length) return null;
  let acc = series[0];
  for (let i = 1; i < series.length; i++) acc = alpha * series[i] + (1 - alpha) * acc;
  return acc;
}

/**
 * Every skill-position player-week in one pass, with the team totals each share
 * is measured against. One query per season keeps this usable on the full
 * 2021-2026 history without holding six seasons of SQL cursors open.
 */
function loadSeasonUsage(season) {
  return rows(`
    SELECT u.player_id, u.season, u.week, u.team, u.opponent, u.position,
           u.attempts, u.carries, u.targets, u.receptions,
           u.target_share, u.air_yards_share, u.wopr,
           s.offense_pct,
           p.gsis_id, p.name
      FROM player_week_usage u
      JOIN players p ON p.id = u.player_id
      LEFT JOIN player_week_snaps s
        ON s.player_id = u.player_id AND s.season = u.season AND s.week = u.week
     WHERE u.season = ? AND u.position IN (${SKILL_POSITIONS.map(() => '?').join(',')})
     ORDER BY u.week, u.team`, season, ...SKILL_POSITIONS);
}

function loadSeasonInjuries(season) {
  const out = new Map();
  for (const r of rows(`SELECT week, gsis_id, report_status FROM nfl_injuries
                         WHERE season = ? AND report_status IS NOT NULL`, season)) {
    out.set(`${r.week}|${r.gsis_id}`, r.report_status);
  }
  return out;
}

function loadSeasonLines(season) {
  const out = new Map();
  for (const r of rows(`SELECT week, team, spread, total, implied_points, rest_days, home, div_game
                          FROM game_lines WHERE season = ?`, season)) {
    out.set(`${r.week}|${r.team}`, r);
  }
  return out;
}

function loadSeasonExpectedPoints(season) {
  const out = new Map();
  for (const r of rows(`SELECT week, player_gsis_id, expected_fantasy_points
                          FROM nfl_ffopportunity_weekly WHERE season = ?`, season)) {
    out.set(`${r.week}|${r.player_gsis_id}`, r.expected_fantasy_points);
  }
  return out;
}

/** The denominator a share is measured against, per stat. */
function teamStatFor(position, stat) {
  if (stat === 'attempts') return 'attempts';
  if (stat === 'carries') return 'carries';
  return 'targets';
}

/**
 * Builds the modelling rows for one season and one stat.
 *
 * Returns one row per (player, week) where the player is expected to play, with
 * strictly-prior features and the realised opportunity as `actual`. Rows whose
 * player was ruled Out or Doubtful are dropped: whether he plays at all is the
 * availability model's question, and mixing the two is how an opportunity model
 * ends up being graded on somebody else's job.
 */
export function buildSeasonRows(season, { positions, stat, startWeek = 5, endWeek = 18 } = {}) {
  const usage = loadSeasonUsage(season);
  if (!usage.length) return [];
  const injuries = loadSeasonInjuries(season);
  const lines = loadSeasonLines(season);
  const xfp = loadSeasonExpectedPoints(season);
  const teamStat = teamStatFor(positions[0], stat);

  const byWeek = new Map();
  for (const r of usage) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);

  // Running, strictly-prior history keyed by player and by team.
  const playerHistory = new Map();   // player_id -> { shares:[], snaps:[], xfp:[] }
  const teamVolume = new Map();      // team -> [team stat totals]
  const defenceFaced = new Map();    // team -> [stat totals allowed]
  // Who belongs to a team, built from the weeks already played. A player ruled
  // out has no box-score row for the week he misses, so the roster has to come
  // from history: looking for absent teammates among the players who appeared
  // is the mistake that makes a teammate-absence feature look like it never
  // fires. Keyed by the most recent team so a midseason move follows the player.
  const roster = new Map();          // team -> Map(player_id -> { gsis_id, position })
  const out = [];

  for (const week of weeks) {
    const weekRows = byWeek.get(week);

    // --- team totals for this week, used only to update history AFTER grading
    const teamTotals = new Map();
    const faced = new Map();
    for (const r of weekRows) {
      const v = Number(r[teamStat]) || 0;
      teamTotals.set(r.team, (teamTotals.get(r.team) ?? 0) + v);
      if (r.opponent) faced.set(r.opponent, (faced.get(r.opponent) ?? 0) + v);
    }

    if (week >= startWeek && week <= endWeek) {
      // Who the injury report ruled out, by team, carrying the share each of
      // them actually had. Walks the roster from prior weeks, not this week's
      // box score, because the players this feature is about are precisely the
      // ones with no box-score row.
      const vacatedByTeam = new Map();
      const vacatedByTeamPos = new Map();
      for (const [team, members] of roster) {
        for (const [playerId, meta] of members) {
          const status = meta.gsis_id ? injuries.get(`${week}|${meta.gsis_id}`) : null;
          if (status !== 'Out' && status !== 'Doubtful') continue;
          const h = playerHistory.get(playerId);
          const share = h && h.shares.length ? ewma(h.shares) ?? 0 : 0;
          if (!(share > 0)) continue;
          vacatedByTeam.set(team, (vacatedByTeam.get(team) ?? 0) + share);
          const key = `${team}|${meta.position}`;
          vacatedByTeamPos.set(key, (vacatedByTeamPos.get(key) ?? 0) + share);
        }
      }

      for (const r of weekRows) {
        if (!positions.includes(r.position)) continue;
        const status = r.gsis_id ? injuries.get(`${week}|${r.gsis_id}`) : null;
        if (status === 'Out' || status === 'Doubtful') continue;
        const h = playerHistory.get(r.player_id);
        if (!h || h.shares.length < MIN_PRIOR_GAMES) continue;
        const line = lines.get(`${week}|${r.team}`) ?? {};
        const teamVol = teamVolume.get(r.team) ?? [];
        const oppFaced = r.opponent ? (defenceFaced.get(r.opponent) ?? []) : [];
        if (!teamVol.length) continue;

        const shareEwma = ewma(h.shares) ?? 0;
        const shareSeason = mean(h.shares);
        const shareLast = h.shares[h.shares.length - 1] ?? 0;
        const snapSeries = h.snaps.filter(Number.isFinite);
        const snapEwma = snapSeries.length ? ewma(snapSeries) : null;
        const snapLast = snapSeries.length ? snapSeries[snapSeries.length - 1] : null;
        const vacatedTeamRaw = vacatedByTeam.get(r.team) ?? 0;
        const vacatedPosRaw = vacatedByTeamPos.get(`${r.team}|${r.position}`) ?? 0;

        out.push({
          player_id: r.player_id, gsis_id: r.gsis_id, name: r.name,
          season, week, team: r.team, opponent: r.opponent, position: r.position,
          actual: Number(r[stat]) || 0,
          // features
          share_ewma: shareEwma,
          share_season: shareSeason,
          share_last: shareLast,
          share_trend: shareLast - shareSeason,
          snap_ewma: snapEwma ?? shareEwma,
          snap_trend: snapEwma == null || snapLast == null ? 0 : snapLast - snapEwma,
          xfp_ewma: ewma(h.xfp.filter(Number.isFinite)) ?? 0,
          team_volume_ewma: ewma(teamVol) ?? 0,
          vacated_same_pos: Math.max(0, vacatedPosRaw),
          vacated_team: Math.max(0, vacatedTeamRaw),
          self_questionable: status === 'Questionable' ? 1 : 0,
          implied_points: Number.isFinite(line.implied_points) ? line.implied_points : 22,
          spread: Number.isFinite(line.spread) ? line.spread : 0,
          opp_volume_faced: oppFaced.length ? ewma(oppFaced) : (ewma(teamVol) ?? 0),
          prior_games: h.shares.length,
          rest_days: Number.isFinite(line.rest_days) ? line.rest_days : 7,
          // carried for the baselines
          prior_stat_mean: mean(h.stat),
          prior_stat_ewma: ewma(h.stat) ?? 0
        });
      }
    }

    // --- now, and only now, the graded week joins the history
    for (const r of weekRows) {
      if (!playerHistory.has(r.player_id)) {
        playerHistory.set(r.player_id, { shares: [], snaps: [], xfp: [], stat: [] });
      }
      const h = playerHistory.get(r.player_id);
      const teamTotal = teamTotals.get(r.team) ?? 0;
      const v = Number(r[stat]) || 0;
      h.shares.push(teamTotal > 0 ? v / teamTotal : 0);
      h.snaps.push(Number.isFinite(r.offense_pct) ? r.offense_pct : null);
      h.xfp.push(r.gsis_id ? xfp.get(`${week}|${r.gsis_id}`) ?? null : null);
      h.stat.push(v);
    }
    for (const r of weekRows) {
      if (!roster.has(r.team)) roster.set(r.team, new Map());
      // A player who changed teams stops counting against the old roster.
      for (const [team, members] of roster) if (team !== r.team) members.delete(r.player_id);
      roster.get(r.team).set(r.player_id, { gsis_id: r.gsis_id, position: r.position });
    }
    for (const [team, total] of teamTotals) {
      if (!teamVolume.has(team)) teamVolume.set(team, []);
      teamVolume.get(team).push(total);
    }
    for (const [team, total] of faced) {
      if (!defenceFaced.has(team)) defenceFaced.set(team, []);
      defenceFaced.get(team).push(total);
    }
  }
  return out;
}

export function featureVector(row) {
  return FEATURE_NAMES.map(name => {
    const v = row[name];
    return Number.isFinite(v) ? v : 0;
  });
}

/**
 * Ridge by normal equations on standardised columns, intercept unpenalised.
 * Uses the repository's one linear solver rather than a second copy of
 * Gaussian elimination; a singular system returns null instead of a vector of
 * 1e9s that would silently become a projection.
 */
export function fitRidge(X, y, lambda = 10) {
  const n = X.length, p = X[0]?.length ?? 0;
  if (!n || !p || y.length !== n) return null;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += X[i][j];
    mu[j] = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i][j] - mu[j]) ** 2;
    sd[j] = Math.sqrt(v / n) || 1;
  }
  const Z = X.map(row => row.map((v, j) => (v - mu[j]) / sd[j]));
  const yBar = mean(y);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    for (let k = j; k < p; k++) {
      let s = 0; for (let i = 0; i < n; i++) s += Z[i][j] * Z[i][k];
      A[j][k] = s; A[k][j] = s;
    }
    let s = 0; for (let i = 0; i < n; i++) s += Z[i][j] * (y[i] - yBar);
    b[j] = s;
  }
  const weights = solveLinear(A, b, lambda);
  if (!weights) return null;
  return { weights, mu, sd, intercept: yBar, lambda, featureNames: [...FEATURE_NAMES] };
}

export function predictRidge(model, x) {
  let s = model.intercept;
  for (let j = 0; j < model.weights.length; j++) {
    s += model.weights[j] * ((x[j] - model.mu[j]) / model.sd[j]);
  }
  return s;
}

/**
 * Fits on log1p and predicts back on the count scale. Opportunity counts are
 * right-skewed and bounded below at zero; fitting the raw count lets one
 * 19-target week drag the whole line, and predicting it can go negative.
 */
export function fitOpportunityModel(trainRows, { lambda = 10 } = {}) {
  const usable = trainRows.filter(r => Number.isFinite(r.actual));
  if (usable.length < 200) return null;
  const X = usable.map(featureVector);
  const y = usable.map(r => Math.log1p(Math.max(0, r.actual)));
  const model = fitRidge(X, y, lambda);
  if (!model) return null;
  return { ...model, n: usable.length };
}

export function predictOpportunity(model, row) {
  if (!model) return null;
  const raw = predictRidge(model, featureVector(row));
  return Math.max(0, Math.expm1(raw));
}

/**
 * The baselines the model has to beat. `share_times_volume` is the honest one:
 * it is what a careful person does by hand, and it already uses the same
 * recency weighting, so a win over it is a win from the rest of the features
 * rather than from smoothing.
 */
export const BASELINES = Object.freeze({
  season_mean: row => row.prior_stat_mean,
  ewma: row => row.prior_stat_ewma,
  share_times_volume: row => row.share_ewma * row.team_volume_ewma
});

/**
 * The redistribution question on its own, asked as small as it can be asked.
 *
 * Everything above predicts opportunity from scratch. This instead takes
 * whatever baseline you already trust and asks one thing: when the injury
 * report rules a teammate out, does the share he was carrying show up in this
 * player's numbers, and by how much?
 *
 * It is fitted as a multiplicative correction in log space against the
 * baseline's own prediction, with the intercept discarded on application. That
 * matters: a player with no absent teammate gets his baseline back exactly, so
 * the correction cannot regress the 60-80% of rows it has nothing to say about.
 * The earlier redistribution attempts moved every player on the roster and were
 * graded on a pooled MAE that mixed the two, which is part of why they read as
 * uniformly worse.
 *
 * The absent teammate's share comes from the weeks he actually played, and the
 * roster he is found in comes from prior weeks, never from the graded week's box
 * score — a player who is out has no row in it, so looking there finds nobody
 * and the effect silently measures zero.
 */
export function fitVacatedCorrection(trainRows, { ridge = 1e-6 } = {}) {
  const usable = trainRows.filter(r => Number.isFinite(r.actual) && Number.isFinite(r.prior_stat_ewma));
  if (usable.length < 200) return null;
  const X = usable.map(r => [
    r.vacated_same_pos,
    Math.max(0, r.vacated_team - r.vacated_same_pos),
    r.self_questionable
  ]);
  const y = usable.map(r => Math.log1p(Math.max(0, r.actual)) - Math.log1p(Math.max(0, r.prior_stat_ewma)));
  const fit = olsFit(X, y, ridge);
  if (!fit) return null;
  return {
    samePosition: fit.weights[0],
    otherPosition: fit.weights[1],
    questionable: fit.weights[2],
    // Kept for inspection only. Applying it would shift every row, including the
    // ones with no absent teammate, which is not what this is claiming to know.
    interceptNotApplied: fit.intercept,
    n: usable.length
  };
}

export function applyVacatedCorrection(correction, row, baselinePrediction) {
  const base = Math.max(0, baselinePrediction ?? 0);
  if (!correction) return base;
  const shift = correction.samePosition * (row.vacated_same_pos ?? 0)
    + correction.otherPosition * Math.max(0, (row.vacated_team ?? 0) - (row.vacated_same_pos ?? 0))
    + correction.questionable * (row.self_questionable ?? 0);
  // Nothing to say about this row: hand the baseline straight back rather than
  // round-tripping it through log1p/expm1, which returns 7.249999999999998 for
  // 7.25 and would make "the correction changed nothing" untestable.
  if (shift === 0) return base;
  return Math.max(0, Math.expm1(Math.log1p(base) + shift));
}

/** Ordinary least squares with an intercept, via the shared solver. */
function olsFit(X, y, ridge) {
  const k = X[0].length + 1;
  const design = X.map(r => [1, ...r]);
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < design.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += design[i][a] * y[i];
      for (let c = a; c < k; c++) A[a][c] += design[i][a] * design[i][c];
    }
  }
  for (let a = 0; a < k; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  const beta = solveLinear(A, b, ridge);
  return beta ? { intercept: beta[0], weights: beta.slice(1) } : null;
}
