/**
 * AI-01 v3 true value: fit, grade and (on --serve) print the served params.
 *
 *   GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 nice -n 10 node scripts/fit-true-value.mjs [--baseline] [--grade] [--ros] [--control] [--coverage] [--serve]
 *
 * Read-only on the database. Study + fit code; the server imports nothing from here.
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
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const TV = await import('../server/services/true-value.js');

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
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
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
  const tv = TV.trueValueFor(lg.season, { params, flag: { on: true, preview: false } });
  const covered = espnIds.filter(e => tv.has(idOf.get(e)));
  print('coverage_league4', { rostered_skill: espnIds.length, mapped: espnIds.filter(e => idOf.has(e)).length, covered: covered.length,
    share: r4(covered.length / espnIds.length), through_week: TV.latestWeek(lg.season), params: TV.TRUE_VALUE_PARAMS ? 'served' : 'fresh 2021-2024 fit' });
}
