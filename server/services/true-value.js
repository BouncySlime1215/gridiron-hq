/**
 * AI-01 true value: a rest-of-season (ROS) points-per-game number built from a
 * player's OPPORTUNITY (the chances he gets), with the luck in his box score
 * split out and shown, never used.
 *
 * Why opportunity: fantasy points are volume x efficiency, and the efficiency
 * half (touchdown rate, yards after catch) is the noisy half. Usage — targets,
 * carries, snap share, air-yard share, ffopportunity's expected points —
 * carries over from one month to the next far better. So `true_ros_ppg` is fit
 * on usage features only (no actual fantasy points go in), and `points_ros_ppg`
 * is the same kind of fit on points only, kept next to it for comparison.
 *
 * `luck_ppg` = actual PPR points per game minus expected (xFP) per game so far,
 * split into touchdown luck and yardage luck. It is explanation only: R&D
 * r8 / RL-8-1 found the market already prices it, so it carries zero weight in
 * any verdict. Nothing reads it to rank or price a player.
 *
 * One producer: `trueValueFor` is the only function that computes these
 * numbers; the campaign adapter exposes them as `adapter.trueValueOf(id)` so
 * PLAYER-SCORE, the LOVE check and TRADE-LENSES read the same values.
 *
 * Flag: GRIDIRON_TRUE_VALUE ('1' on, '0' off and vetoes preview); otherwise
 * GRIDIRON_PREVIEW_UNCONFIRMED (read through preview-mode.js) turns it on,
 * labelled preview. Default off. Evidence and the pre-registration live in
 * scripts/fit-true-value.mjs.
 */
import { rows } from '../db/index.js';
import { fitRidge, predictRidge } from './opportunity-model.js';
import { PPR, scoreLine } from './scoring.js';
import { previewUnconfirmed } from './preview-mode.js';

export const TRUE_VALUE_ENV = 'GRIDIRON_TRUE_VALUE';
export const TRUE_VALUE_REASON = 'AI-01 true value: default off; unconfirmed forward (2026 has too few weeks for the rule-5 check)';
export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);
const HORIZON = 5;

/** Usage only: nothing here is an actual fantasy point. */
export const OPP_FEATURES = Object.freeze([
  'xfp_pg',            // ffopportunity expected PPR points per game played
  'xfp_last3',         // same, last three games: a role that is opening or closing
  'exp_td_pg',         // expected touchdowns per game: red-zone / goal-line work
  'targets_pg', 'carries_pg', 'attempts_pg',
  'target_share', 'air_yards_share', 'wopr',
  'snap_pct', 'snap_last3',
  'depth_rank',        // latest depth-chart rank at his position, week <= t
  'team_implied',      // season-to-date implied team points (pace + offence quality)
  'next_implied',      // week t+1 implied team points (published before the window)
  'next_spread',
  'vacated_same_pos',  // usage share of same-position teammates listed Out/Doubtful for week t+1
  'games', 't'
]);

/** Points only: the season-to-date PPG a person would shrink by hand. */
export const PTS_FEATURES = Object.freeze(['std_ppg', 'last3_ppg', 'games', 't']);

export const DRIVER_LABELS = Object.freeze({
  xfp_pg: 'expected points per game', xfp_last3: 'expected points, last 3',
  exp_td_pg: 'red-zone / TD opportunity', targets_pg: 'targets per game', carries_pg: 'carries per game',
  attempts_pg: 'pass attempts per game', target_share: 'target share', air_yards_share: 'air-yard share',
  wopr: 'weighted opportunity', snap_pct: 'snap share', snap_last3: 'snap share, last 3',
  depth_rank: 'depth-chart slot', team_implied: 'team scoring environment', next_implied: 'next game total',
  next_spread: 'next game spread', vacated_same_pos: 'teammates out', games: 'games played', t: 'week of season'
});

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const lastN = (a, n) => a.slice(Math.max(0, a.length - n));
const num = v => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);

/* --------------------------------------------------------------------- data */

const seasonCache = new Map();

/** Every per-week input for one season, loaded once. */
export function loadSeason(season) {
  if (seasonCache.has(season)) return seasonCache.get(season);
  const players = new Map();
  for (const u of rows(`SELECT u.*, p.gsis_id, p.name FROM player_week_usage u JOIN players p ON p.id = u.player_id
                         WHERE u.season = ? AND u.week <= 18`, season)) {
    if (!POSITIONS.includes(u.position)) continue;
    if (!players.has(u.player_id)) players.set(u.player_id, { id: u.player_id, gsis: u.gsis_id, name: u.name, position: u.position, weeks: new Map() });
    const p = players.get(u.player_id);
    p.position = u.position;
    p.weeks.set(u.week, {
      team: u.team, pts: Number(scoreLine(u, PPR)) || 0,
      targets: num(u.targets) ?? 0, carries: num(u.carries) ?? 0, attempts: num(u.attempts) ?? 0,
      target_share: num(u.target_share) ?? 0, air_yards_share: num(u.air_yards_share) ?? 0, wopr: num(u.wopr) ?? 0,
      tds: (num(u.rushing_tds) ?? 0) + (num(u.receiving_tds) ?? 0), pass_tds: num(u.passing_tds) ?? 0,
      yards: (num(u.rushing_yards) ?? 0) + (num(u.receiving_yards) ?? 0), pass_yards: num(u.passing_yards) ?? 0
    });
  }
  const snaps = new Map();
  for (const r of rows('SELECT player_id, week, offense_pct FROM player_week_snaps WHERE season = ?', season)) {
    snaps.set(`${r.player_id}|${r.week}`, num(r.offense_pct));
  }
  const xfp = new Map();
  for (const r of rows(`SELECT player_gsis_id g, week, expected_fantasy_points x, expected_touchdowns td, expected_total_yards y
                          FROM nfl_ffopportunity_weekly WHERE season = ?`, season)) {
    xfp.set(`${r.g}|${r.week}`, { x: num(r.x), td: num(r.td), y: num(r.y) });
  }
  const depth = new Map(); // gsis -> [[week, rank]]
  for (const r of rows(`SELECT gsis_id, week, MIN(pos_rank) rk FROM nfl_depth WHERE season = ? AND pos_abb IN ('QB','RB','WR','TE')
                         GROUP BY gsis_id, week`, season)) {
    if (!depth.has(r.gsis_id)) depth.set(r.gsis_id, []);
    depth.get(r.gsis_id).push([r.week, num(r.rk)]);
  }
  const lines = new Map();
  for (const r of rows('SELECT week, team, spread, implied_points FROM game_lines WHERE season = ?', season)) {
    lines.set(`${r.week}|${r.team}`, { spread: num(r.spread), implied: num(r.implied_points) });
  }
  const injuries = new Map();
  for (const r of rows(`SELECT week, gsis_id, report_status FROM nfl_injuries WHERE season = ? AND report_status IN ('Out','Doubtful')`, season)) {
    injuries.set(`${r.week}|${r.gsis_id}`, r.report_status);
  }
  const data = { season, players, snaps, xfp, depth, lines, injuries };
  seasonCache.set(season, data);
  return data;
}

export function clearSeasonCache() { seasonCache.clear(); }

/**
 * One row per player at cutoff t (weeks 1..t known), strictly prior. The target
 * (`next5_ppg`, PPR per game played in weeks t+1..t+5) is attached when those
 * weeks exist, and is never read to build a feature.
 */
export function buildRows(season, t, { minGames = 1, data = loadSeason(season) } = {}) {
  const out = [];
  // Team usage by position so far, for the vacated-teammate feature.
  const shareOf = new Map();
  for (const p of data.players.values()) {
    const g = [...p.weeks].filter(([w]) => w <= t);
    if (!g.length) continue;
    const team = g[g.length - 1][1].team;
    const use = g.reduce((s, [, v]) => s + v.targets + v.carries, 0) / g.length;
    shareOf.set(p.id, { team, use });
  }
  const teamPosUse = new Map();
  const vacated = new Map();
  for (const p of data.players.values()) {
    const s = shareOf.get(p.id);
    if (!s) continue;
    const k = `${s.team}|${p.position}`;
    teamPosUse.set(k, (teamPosUse.get(k) ?? 0) + s.use);
    if (p.gsis && data.injuries.has(`${t + 1}|${p.gsis}`)) vacated.set(k, (vacated.get(k) ?? 0) + s.use);
  }

  for (const p of data.players.values()) {
    const wk = [...p.weeks].filter(([w]) => w <= t).sort((a, b) => a[0] - b[0]);
    if (wk.length < minGames || !wk.length) continue;
    const vals = wk.map(([, v]) => v);
    const team = vals[vals.length - 1].team;
    const xs = wk.map(([w]) => (p.gsis ? data.xfp.get(`${p.gsis}|${w}`) : null));
    const xv = xs.map(x => x?.x).filter(Number.isFinite);
    const xl3 = lastN(xs, 3).map(x => x?.x).filter(Number.isFinite);
    const sn = wk.map(([w]) => data.snaps.get(`${p.id}|${w}`)).filter(Number.isFinite);
    const dr = (data.depth.get(p.gsis) ?? []).filter(([w]) => w <= t).sort((a, b) => a[0] - b[0]);
    const imp = [];
    for (let w = 1; w <= t; w++) { const l = data.lines.get(`${w}|${team}`); if (Number.isFinite(l?.implied)) imp.push(l.implied); }
    const next = data.lines.get(`${t + 1}|${team}`) ?? {};
    const k = `${team}|${p.position}`;
    const own = shareOf.get(p.id)?.use ?? 0;
    const posUse = (teamPosUse.get(k) ?? 0) - own;
    const vac = (vacated.get(k) ?? 0) - (p.gsis && data.injuries.has(`${t + 1}|${p.gsis}`) ? own : 0);
    const pts = vals.map(v => v.pts);
    const actualTd = vals.reduce((s, v) => s + v.tds, 0);
    const expTd = xs.reduce((s, x) => s + (x?.td ?? 0), 0);
    const xfpPg = xv.length ? mean(xv) : null;

    const after = [...p.weeks].filter(([w]) => w > t && w <= t + HORIZON).map(([, v]) => v.pts);
    out.push({
      season, t, player_id: p.id, gsis: p.gsis, name: p.name, position: p.position, team,
      cluster: p.gsis ?? `pid${p.id}`,
      xfp_pg: xfpPg ?? 0, has_xfp: xv.length > 0,
      xfp_last3: xl3.length ? mean(xl3) : (xfpPg ?? 0),
      exp_td_pg: expTd / wk.length,
      targets_pg: mean(vals.map(v => v.targets)), carries_pg: mean(vals.map(v => v.carries)),
      attempts_pg: mean(vals.map(v => v.attempts)),
      target_share: mean(vals.map(v => v.target_share)), air_yards_share: mean(vals.map(v => v.air_yards_share)),
      wopr: mean(vals.map(v => v.wopr)),
      snap_pct: sn.length ? mean(sn) : 0, snap_last3: sn.length ? mean(lastN(sn, 3)) : 0,
      depth_rank: dr.length ? Math.min(4, dr[dr.length - 1][1] ?? 3) : 3,
      team_implied: imp.length ? mean(imp) : 22,
      next_implied: Number.isFinite(next.implied) ? next.implied : (imp.length ? mean(imp) : 22),
      next_spread: Number.isFinite(next.spread) ? next.spread : 0,
      vacated_same_pos: posUse + own > 0 ? Math.max(0, vac) / (posUse + own) : 0,
      games: wk.length,
      std_ppg: mean(pts), last3_ppg: mean(lastN(pts, 3)),
      // luck (explanation only)
      td_luck_ppg: xv.length ? (6 * (actualTd - expTd)) / wk.length : null,
      next5_ppg: after.length ? mean(after) : null, next5_games: after.length
    });
  }
  return out;
}

/* ---------------------------------------------------------------------- fit */

const vec = (r, names) => names.map(n => (Number.isFinite(r[n]) ? r[n] : 0));

/** Ridge per position on next-5 PPG. Returns plain JSON (the frozen params below are this shape). */
export function fitTrueValue(trainRows, { features, lambda = 10 } = {}) {
  const out = {};
  for (const pos of POSITIONS) {
    const L = trainRows.filter(r => r.position === pos && Number.isFinite(r.next5_ppg));
    if (L.length < 100) return null;
    const m = fitRidge(L.map(r => vec(r, features)), L.map(r => r.next5_ppg), lambda);
    if (!m) return null;
    out[pos] = { weights: m.weights, mu: m.mu, sd: m.sd, intercept: m.intercept, n: L.length };
  }
  return { features: [...features], lambda, byPosition: out };
}

export function predictWith(params, row) {
  const m = params?.byPosition?.[row.position];
  if (!m) return null;
  return Math.max(0, predictRidge(m, vec(row, params.features)));
}

/** The features that moved this player's number most, against the position average. */
export function driversOf(params, row, top = 3) {
  const m = params?.byPosition?.[row.position];
  if (!m) return [];
  const x = vec(row, params.features);
  return params.features.map((f, j) => ({ feature: f, label: DRIVER_LABELS[f] ?? f, value: x[j],
    ppg: m.weights[j] * ((x[j] - m.mu[j]) / m.sd[j]) }))
    .filter(d => Number.isFinite(d.ppg) && d.feature !== 't')
    .sort((a, b) => Math.abs(b.ppg) - Math.abs(a.ppg)).slice(0, top)
    .map(d => ({ ...d, value: +d.value.toFixed(3), ppg: +d.ppg.toFixed(2) }));
}

/**
 * Served params: refit on 2021-2024 by `node scripts/fit-true-value.mjs --serve`
 * (2025 stays closed). null until a fit is pasted in; `trueValueFor` then
 * returns nothing, so no half-built number is served.
 */
export const TRUE_VALUE_PARAMS = null;

/* ------------------------------------------------------------------- serve */

/** '1' on; '0' off and vetoes preview; otherwise preview mode decides. */
export function trueValueFlag(env = process.env) {
  const v = env[TRUE_VALUE_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** Latest regular-season week with usage rows in a season. */
export function latestWeek(season) {
  return rows('SELECT MAX(week) w FROM player_week_usage WHERE season = ? AND week <= 18', season)[0]?.w ?? null;
}

/**
 * The one producer. Map player_id -> { true_ros_ppg, points_ros_ppg, luck_ppg,
 * td_luck_ppg, yardage_luck_ppg, usage_trend, drivers, games, through_week }.
 * Empty when the flag is off or no params are fitted.
 */
export function trueValueFor(season, { throughWeek = latestWeek(season), params = TRUE_VALUE_PARAMS, flag = trueValueFlag() } = {}) {
  const out = new Map();
  if (!flag.on || !params?.opp || !params?.pts || !Number.isInteger(throughWeek) || throughWeek < 1) return out;
  for (const r of buildRows(season, throughWeek, { minGames: 1 })) {
    const trueRos = predictWith(params.opp, r);
    const ptsRos = predictWith(params.pts, r);
    if (!Number.isFinite(trueRos)) continue;
    const luck = r.has_xfp ? r.std_ppg - r.xfp_pg : null;
    out.set(r.player_id, {
      player_id: r.player_id, name: r.name, position: r.position, through_week: throughWeek, games: r.games,
      true_ros_ppg: +trueRos.toFixed(2),
      points_ros_ppg: Number.isFinite(ptsRos) ? +ptsRos.toFixed(2) : null,
      luck_ppg: luck == null ? null : +luck.toFixed(2),
      td_luck_ppg: r.td_luck_ppg == null ? null : +r.td_luck_ppg.toFixed(2),
      yardage_luck_ppg: luck == null || r.td_luck_ppg == null ? null : +(luck - r.td_luck_ppg).toFixed(2),
      luck_note: 'explanation only; zero weight in any verdict (R&D RL-8-1: luck is priced)',
      usage_trend: r.has_xfp ? +(r.xfp_last3 - r.xfp_pg).toFixed(2) : null,
      drivers: driversOf(params.opp, r),
      ...(flag.preview ? { preview: true, preview_reason: TRUE_VALUE_REASON } : {})
    });
  }
  return out;
}
