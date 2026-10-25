/**
 * AI-01 v3 true value: fit, grade and (on --serve) print the served params.
 *
 *   GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 nice -n 10 node scripts/fit-true-value.mjs [--baseline] [--grade] [--ros] [--control] [--coverage] [--serve]
 *
 * Read-only on the database. Study code only; the server imports nothing from here.
 *
 * ============================== PRE-REGISTRATION ==============================
 * Written 2026-09-24 on origin/main b14a137d, before any number from this test
 * was computed; this block is committed before the results commit and does not
 * move after the run.
 *
 * Prior art: AI-01 v1 (#181, docs/tdd/2026-09-23-true-value-opportunity.tdd.md)
 * tested RAW season-to-date xFP/game against raw season-to-date PPG on 2021-2024
 * and declined (the 2021-2024 gate failed; served ros_ppg beat both). This v3
 * test is different: both arms are FITTED (ridge, per position) on 2021-2023 and
 * graded on 2024 only, and the opportunity arm uses many usage features, not xFP
 * alone. The 2024 rows were already looked at by v1 in its pooled 2021-2024 gate
 * (reported here as a limit, not a reason to move the split).
 *
 * Hypothesis: a per-position ridge on usage only (OPP_FEATURES in
 * server/services/true-value.js: xFP/game and last-3, expected TDs/game,
 * targets/carries/attempts per game, target/air-yard share, WOPR, snap share and
 * last-3, depth rank, team implied points to date and next week, next spread,
 * vacated same-position usage, games, week) predicts next-5-weeks PPR PPG better
 * than the same ridge on points only (PTS_FEATURES: season-to-date PPG, last-3 PPG,
 * games, week) — "season-to-date PPG shrunk", with the shrinkage fitted.
 *
 * Data: local copy of the app DB. PPR points from player_week_usage via
 * scoring.js#scoreLine (the app's PPR, same as backtest.js#actuals). QB/RB/WR/TE,
 * regular season (week <= 18).
 * Fit: seasons 2021-2023, cutoffs t = 2..10, rows with >= 1 game in weeks 1..t and
 * >= 1 game in t+1..t+5; lambda 10 (fixed, not tuned). Graded: 2024. 2025 is not
 * opened (holdout rule). 2026 has 2 weeks: no forward check possible -> a pass
 * ships default-off, "unconfirmed forward".
 * Graded population at (2024, t), t in {3, 5, 8}: >= 2 games in 1..t, >= 1 game in
 * t+1..t+5, and in the position top-N (QB 24, RB 48, WR 60, TE 24) by EITHER arm.
 * Target: mean PPR points per game played in t+1..t+5.
 *
 * Metrics (sign: opportunity minus points; MAE negative favours opportunity):
 *  M1 MAE diff per checkpoint, pairedBootstrapDiff (player-clustered, 2000 draws,
 *     seed 20260924), 90% CI.
 *  M2 rank correlation: mean over positions of within-position Spearman vs target,
 *     diff with a player-cluster bootstrap 90% CI (1000 draws, same seed). Reported.
 *  M3 decision grade (rule 6): same-position pairs where the arms order two players
 *     differently, share the opportunity arm gets right. Reported.
 *  Reported, not gated: the served ros-projection.js (walk-forward: selectRosStructure
 *  fitted on 2023, graded 2024; configuration B: WEEKLY_ROLE_RECENCY, no kOverride,
 *  stop if activeKVectorFor is null or a share k == 6), and a combined ridge (usage +
 *  points features). ESPN's ROS: graded only where stored for 2024 (checked by query).
 *  Control (known-nonzero): 2024, Spearman of season-to-date target share at t vs
 *  targets in week t+1, WR/TE, t in {3, 5, 8}; must be > 0 with CI lower > 0,
 *  otherwise the rig is broken and nothing is claimed.
 *  Coverage: share of league-4 rostered QB/RB/WR/TE (ESPN payload, local copy) that
 *  get a true_ros_ppg from true-value.js#trueValueFor at the latest 2026 week.
 *
 * Ship rule: opportunity beats points on 2024 MAE (90% CI upper < 0) at >= 2 of 3
 * checkpoints AND the control holds AND coverage >= 95% -> serve via the adapter
 * behind GRIDIRON_TRUE_VALUE (default off; preview on), params refit on 2021-2024.
 * Otherwise: decline, incumbent kept, TRUE_VALUE_PARAMS stays null, MDE reported.
 * Power guess (rule 4): MAE diff half-width ~0.12 PPG per checkpoint -> MDE80 ~0.18.
 * =============================================================================
 *
 * RESULTS (2026-09-24, prereg commit 0825b38d, local copy, not production;
 * run: --baseline --grade --control --coverage --ros). Verdict: DECLINED.
 *  Baseline, points ridge, 2024 MAE next-5 PPG: t3 3.975 | t5 3.853 | t8 3.856
 *  (raw season-to-date PPG: 4.223 | 3.981 | 4.037). Rows 178 / 175 / 171.
 *  M1 opportunity - points MAE (90% CI, MDE80):
 *    t3 -0.400 [-0.651, -0.146] 0.382  WIN
 *    t5 -0.070 [-0.317, +0.184] 0.379  CI covers 0
 *    t8 -0.121 [-0.319, +0.080] 0.301  CI covers 0
 *    -> 1 of 3 checkpoints; the gate needs 2. Point estimates favour opportunity at all 3.
 *  M2 Spearman diff: t3 +0.146 [+0.027, +0.264]; t5 +0.103 [-0.018, +0.216]; t8 +0.117 [-0.016, +0.247]
 *  M3 disagreement pairs, opportunity right: 53.8% / 52.1% / 53.3% (n 1213 / 1103 / 860)
 *  Reported: served ros-projection.js (walk-forward, fit 2023) MAE 3.404 / 3.619 / 3.680;
 *    opportunity - served +0.169 [-0.062, +0.404] / +0.167 [-0.054, +0.387] / +0.055 [-0.159, +0.284]:
 *    the served ros_ppg is still the best single number (not significantly).
 *  Combined (usage + points) - points: -0.382 [-0.572, -0.188] / -0.099 [-0.275, +0.082] / -0.170 [-0.322, -0.022].
 *  ESPN ROS stored for 2024: 0 rows (not graded). Control holds: target share -> next-week
 *    targets Spearman 0.69 / 0.67 / 0.64, CI lower > 0.55. Coverage league 4: 146 / 152 = 96.1%.
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { fitRidge, predictRidge } = await import('../server/services/opportunity-model.js');
const { PPR, scoreLine } = await import('../server/services/scoring.js');

/* ===================================================================== model
 * Study code only (AI-01 declined, so nothing is served): the row builder and
 * per-position ridge. Features are strictly prior to week t+1. */
const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);
const HORIZON = 5;

/** Usage only: nothing here is an actual fantasy point. */
const OPP_FEATURES = Object.freeze([
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
const PTS_FEATURES = Object.freeze(['std_ppg', 'last3_ppg', 'games', 't']);

const DRIVER_LABELS = Object.freeze({
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
function loadSeason(season) {
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

function clearSeasonCache() { seasonCache.clear(); }

/**
 * One row per player at cutoff t (weeks 1..t known), strictly prior. The target
 * (`next5_ppg`, PPR per game played in weeks t+1..t+5) is attached when those
 * weeks exist, and is never read to build a feature.
 */
function buildRows(season, t, { minGames = 1, data = loadSeason(season) } = {}) {
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
function fitTrueValue(trainRows, { features, lambda = 10 } = {}) {
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

function predictWith(params, row) {
  const m = params?.byPosition?.[row.position];
  if (!m) return null;
  return Math.max(0, predictRidge(m, vec(row, params.features)));
}

/** The features that moved this player's number most, against the position average. */
function driversOf(params, row, top = 3) {
  const m = params?.byPosition?.[row.position];
  if (!m) return [];
  const x = vec(row, params.features);
  return params.features.map((f, j) => ({ feature: f, label: DRIVER_LABELS[f] ?? f, value: x[j],
    ppg: m.weights[j] * ((x[j] - m.mu[j]) / m.sd[j]) }))
    .filter(d => Number.isFinite(d.ppg) && d.feature !== 't')
    .sort((a, b) => Math.abs(b.ppg) - Math.abs(a.ppg)).slice(0, top)
    .map(d => ({ ...d, value: +d.value.toFixed(3), ppg: +d.ppg.toFixed(2) }));
}

/** Study-only: the values the module would serve at the latest week, for the coverage check. */
function trueValueFor(season, { params }) {
  const throughWeek = latestWeek(season);
  const out = new Map();
  for (const r of buildRows(season, throughWeek, { minGames: 1 })) {
    const v = predictWith(params.opp, r);
    if (Number.isFinite(v)) out.set(r.player_id, { true_ros_ppg: v, points_ros_ppg: predictWith(params.pts, r),
      luck_ppg: r.has_xfp ? r.std_ppg - r.xfp_pg : null, usage_trend: r.has_xfp ? r.xfp_last3 - r.xfp_pg : null, drivers: driversOf(params.opp, r) });
  }
  return out;
}
function latestWeek(season) {
  return rows('SELECT MAX(week) w FROM player_week_usage WHERE season = ? AND week <= 18', season)[0]?.w ?? null;
}
const TV = { POSITIONS, OPP_FEATURES, PTS_FEATURES, buildRows, loadSeason, fitTrueValue, predictWith, TRUE_VALUE_PARAMS: null };

const args = process.argv.slice(2);
const has = f => args.includes(f);
const SEED = 20260924;
const FIT_SEASONS = [2021, 2022, 2023];
const GRADE = 2024;
const FIT_CUTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const CHECKS = [3, 5, 8];
const TOPN = { QB: 24, RB: 48, WR: 60, TE: 24 };
const LAMBDA = 10;
const COMBINED = [...TV.OPP_FEATURES, 'std_ppg', 'last3_ppg'];
const r4 = x => (Number.isFinite(x) ? +x.toFixed(4) : null);
const out = { tree: process.env.STUDY_TREE ?? null };
const print = (k, v) => { out[k] = v; console.log(`\n## ${k}\n${JSON.stringify(v)}`); };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function spearman(a, b) {
  const rank = v => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : NaN;
}
/** Mean within-position Spearman of key vs target; rows may repeat (bootstrap multiplicity). */
function posSpearman(L, key, target = 'next5_ppg') {
  const vals = [];
  for (const pos of TV.POSITIONS) { const P = L.filter(r => r.position === pos); if (P.length > 5) vals.push(spearman(P.map(r => r[key]), P.map(r => r[target]))); }
  return mean(vals);
}
function clusterBoot(L, stat, B = 1000) {
  const by = new Map(); for (const r of L) { if (!by.has(r.cluster)) by.set(r.cluster, []); by.get(r.cluster).push(r); }
  const groups = [...by.values()]; const rand = rng(SEED); const ds = [];
  for (let b = 0; b < B; b++) { const S = []; for (let i = 0; i < groups.length; i++) S.push(...groups[Math.floor(rand() * groups.length)]); ds.push(stat(S)); }
  ds.sort((x, y) => x - y);
  return [r4(ds[Math.floor(0.05 * B)]), r4(ds[Math.floor(0.95 * B)])];
}
function maeBlock(L, cand, inc) {
  const ec = L.map(r => Math.abs(r[cand] - r.next5_ppg)), ei = L.map(r => Math.abs(r[inc] - r.next5_ppg));
  const b = pairedBootstrapDiff(ei, ec, { seed: SEED, iterations: 2000, groups: L.map(r => r.cluster) });
  return { mae_cand: r4(mean(ec)), mae_inc: r4(mean(ei)), diff: r4(b.mean_diff), ci90: b.ci90.map(r4),
    mde80: r4(1.512 * (b.ci90[1] - b.ci90[0]) / 2), n: L.length, players: new Set(L.map(r => r.cluster)).size };
}
function disagreement(L, a, b) {
  let n = 0, right = 0;
  for (const pos of TV.POSITIONS) { const P = L.filter(r => r.position === pos);
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const x = P[i], y = P[j];
      if (x.next5_ppg === y.next5_ppg || x[a] === y[a] || x[b] === y[b]) continue;
      if ((x[a] > y[a]) !== (x[b] > y[b])) { n++; if ((x[a] > y[a]) === (x.next5_ppg > y.next5_ppg)) right++; } } }
  return { n, cand_right: r4(right / n) };
}
function population(L, keys) {
  const keep = [];
  for (const pos of TV.POSITIONS) {
    const P = L.filter(r => r.position === pos);
    const ids = new Set(keys.flatMap(k => [...P].sort((a, b) => b[k] - a[k]).slice(0, TOPN[pos]).map(r => r.player_id)));
    keep.push(...P.filter(r => ids.has(r.player_id)));
  }
  return keep;
}

/* ------------------------------------------------------------------- fits */
const trainRows = seasons => seasons.flatMap(s => FIT_CUTS.flatMap(t => TV.buildRows(s, t, { minGames: 1 }))).filter(r => Number.isFinite(r.next5_ppg));
const fits = {};
function fitAll(seasons) {
  const tr = trainRows(seasons);
  return { n: tr.length, opp: TV.fitTrueValue(tr, { features: TV.OPP_FEATURES, lambda: LAMBDA }),
    pts: TV.fitTrueValue(tr, { features: TV.PTS_FEATURES, lambda: LAMBDA }),
    comb: TV.fitTrueValue(tr, { features: COMBINED, lambda: LAMBDA }) };
}
function graded(f, season = GRADE) {
  const res = {};
  for (const t of CHECKS) {
    const L = TV.buildRows(season, t, { minGames: 2 }).filter(r => Number.isFinite(r.next5_ppg))
      .map(r => ({ ...r, opp: TV.predictWith(f.opp, r), pts: TV.predictWith(f.pts, r), comb: TV.predictWith(f.comb, r) }));
    res[t] = population(L, ['opp', 'pts']);
  }
  return res;
}

if (has('--baseline') || has('--grade')) {
  fits.f = fitAll(FIT_SEASONS);
  print('fit_rows_2021_2023', fits.f.n);
  const G = graded(fits.f);
  if (has('--baseline')) {
    // Incumbent only, recorded before the candidate is scored.
    print('baseline_points_ros_2024', Object.fromEntries(CHECKS.map(t => [t, {
      rows: G[t].length, mae: r4(mean(G[t].map(r => Math.abs(r.pts - r.next5_ppg)))),
      mae_raw_std_ppg: r4(mean(G[t].map(r => Math.abs(r.std_ppg - r.next5_ppg)))), spearman: r4(posSpearman(G[t], 'pts')) }])));
  }
  if (has('--grade')) {
    const per = {}; let wins = 0;
    for (const t of CHECKS) {
      const L = G[t];
      const m = maeBlock(L, 'opp', 'pts');
      if (m.ci90[1] < 0) wins++;
      per[t] = { mae: m,
        spearman: { opp: r4(posSpearman(L, 'opp')), pts: r4(posSpearman(L, 'pts')),
          diff: r4(posSpearman(L, 'opp') - posSpearman(L, 'pts')), ci90: clusterBoot(L, S => posSpearman(S, 'opp') - posSpearman(S, 'pts')) },
        decision_disagreement: disagreement(L, 'opp', 'pts'),
        reported_combined_vs_pts: maeBlock(L, 'comb', 'pts'),
        reported_raw_std_ppg_mae: r4(mean(L.map(r => Math.abs(r.std_ppg - r.next5_ppg)))) };
    }
    print('grade_2024', per);
    print('gate_mae_checkpoints_won', `${wins} of ${CHECKS.length}`);
  }
}

/* --------------------------------------------------- reported: served ROS */
if (has('--ros')) {
  const { buildProjections } = await import('../server/services/projections.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
  const { activeKVectorFor } = await import('../server/services/shrinkage-fit.js');
  const { ROS_POSITIONS, rosPriorMap, predictRow, selectRosStructure } = await import('../server/services/ros-projection.js');
  for (const s of [2023, 2024]) {
    const v = activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: s });
    if (!v) { console.error(`STOP: activeKVectorFor(${s}) null`); process.exit(2); }
    if (Object.entries(v).some(([m, byPos]) => /share/.test(m) && Object.values(byPos).some(k => k === 6))) { console.error(`STOP: share k = 6 for ${s}`); process.exit(2); }
  }
  const dataset = (season, ws) => {
    const truth = actuals(season); const priors = rosPriorMap(season); const res = [];
    for (const w of ws) {
      const proj = buildProjections({ through: season, throughWeek: w, roleRecency: WEEKLY_ROLE_RECENCY });
      for (const [pid, p] of proj) {
        if (!ROS_POSITIONS.includes(p.position)) continue;
        const tr = truth.get(pid); if (!tr) continue;
        const bw = [...tr.weeks.keys()].filter(k => k <= w); if (!bw.length) continue;
        const after = [...tr.weeks].filter(([k]) => k > w && k <= 18).map(([, v]) => v);
        const pr = priors.get(pid) ?? {};
        res.push({ w, player_id: pid, position: p.position, structural: p.ppg, std: mean(bw.map(k => tr.weeks.get(k))), n: bw.length,
          c_mkt: pr.c_mkt ?? null, c_struct: pr.c_struct ?? null, actual: after.length ? mean(after) : null });
      }
    }
    return res;
  };
  const sel = selectRosStructure(dataset(2023, [1, 2, 3, 4, 6, 8, 10]).filter(r => r.actual != null));
  const ros = new Map();
  for (const r of dataset(2024, CHECKS)) { const v = predictRow(r, sel.params); if (Number.isFinite(v)) ros.set(`${r.w}|${r.player_id}`, v); }
  fits.f ??= fitAll(FIT_SEASONS);
  const G = graded(fits.f);
  const per = {};
  for (const t of CHECKS) {
    const L = G[t].map(r => ({ ...r, ros: ros.get(`${t}|${r.player_id}`) })).filter(r => Number.isFinite(r.ros));
    per[t] = { rows: L.length, of: G[t].length, opp_minus_ros: maeBlock(L, 'opp', 'ros'), pts_minus_ros: maeBlock(L, 'pts', 'ros'),
      spearman_ros: r4(posSpearman(L, 'ros')) };
  }
  print('reported_vs_served_ros_2024', { params_fit_2023: sel.params, per });
  const espn = rows(`SELECT COUNT(*) n FROM espn_player_market_weekly WHERE season = ?`, GRADE)[0].n;
  print('espn_ros_2024_rows', espn);
}

/* ------------------------------------------------------------- control */
if (has('--control')) {
  const per = {};
  for (const t of CHECKS) {
    const d = TV.loadSeason(GRADE);
    const L = TV.buildRows(GRADE, t, { minGames: 2 }).filter(r => ['WR', 'TE'].includes(r.position))
      .map(r => ({ ...r, next_tg: d.players.get(r.player_id).weeks.get(t + 1)?.targets })).filter(r => Number.isFinite(r.next_tg));
    const st = S => spearman(S.map(r => r.target_share), S.map(r => r.next_tg));
    per[t] = { n: L.length, spearman: r4(st(L)), ci90: clusterBoot(L, st) };
  }
  print('control_target_share_to_next_week_targets_2024', per);
}

/* ------------------------------------------------------------- serve fit */
if (has('--serve')) {
  const f = fitAll([2021, 2022, 2023, 2024]);
  const round = p => ({ ...p, byPosition: Object.fromEntries(Object.entries(p.byPosition).map(([k, m]) => [k,
    { ...m, weights: m.weights.map(r4), mu: m.mu.map(r4), sd: m.sd.map(r4), intercept: r4(m.intercept) }])) });
  print('serve_params_2021_2024', { opp: round(f.opp), pts: round(f.pts), fit_seasons: [2021, 2022, 2023, 2024], lambda: LAMBDA });
}

/* ------------------------------------------------------------- coverage */
if (has('--coverage')) {
  const lg = rows('SELECT season, payload FROM leagues WHERE id = 4')[0];
  const pay = JSON.parse(lg.payload);
  const POSID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE' };
  const espnIds = pay.teams.flatMap(t => t.roster?.entries ?? []).filter(e => POSID[e.playerPoolEntry?.player?.defaultPositionId]).map(e => String(e.playerId));
  const idOf = new Map(rows('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL').map(r => [String(r.espn_id), r.id]));
  let params = TV.TRUE_VALUE_PARAMS;
  if (!params) { const f = fitAll([2021, 2022, 2023, 2024]); params = { opp: f.opp, pts: f.pts }; }
  const tv = trueValueFor(lg.season, { params });
  const covered = espnIds.filter(e => tv.has(idOf.get(e)));
  print('coverage_league4', { rostered_skill: espnIds.length, mapped: espnIds.filter(e => idOf.has(e)).length, covered: covered.length,
    share: r4(covered.length / espnIds.length), through_week: latestWeek(lg.season), params: TV.TRUE_VALUE_PARAMS ? 'served' : 'fresh 2021-2024 fit' });
}
