/**
 * Fit and gate the rest-of-season projection (server/services/ros-projection.js).
 *
 *   node scripts/fit-ros-projection.mjs [--smoke] [--out results.json] [--baseline-fit 1]
 *
 * Reads the database only (point GRIDIRON_DB_PATH at a copy for experiments). Prints
 * the per-w table, the gate verdict and, on PASS, the live params to paste into
 * ROS_PARAMS. Exit code 0 = gate passed, 1 = gate failed, 2 = error. --smoke builds
 * and reports 2023 only (trained on 2022) and never touches the validation seasons.
 *
 * ============================== PRE-REGISTERED GATE ==============================
 * Written 2026-09-18 before any candidate was scored; must not move after the run.
 *
 * Forecast point w in {1,2,3,4,6,8,10}: prior seasons + weeks 1..w of season s.
 * Seasons: 2023 reported (not gated); 2024 and 2025 validation, graded once.
 * Population (s, w): QB/RB/WR/TE in buildProjections({through: s, throughWeek: w,
 *   roleRecency: WEEKLY_ROLE_RECENCY}) with >= 1 game in weeks 1..w.
 * PRIMARY target (gated): mean PPR points per game played over weeks w+1..18
 *   (rows with no game in w+1..18 excluded). SECONDARY (reported only): total PPR
 *   points over w+1..18 / his team's games in w+1..18 (did-not-play = 0).
 * Candidates (per game played, no availability term):
 *   (a) current  = weekly blend for week w+1, activeWeeklyWeightSet({season:2026,
 *                  week:3}) weights (what ros_ppg is today) — that call returned fit-1
 *                  when this gate ran; the script now reads fit-1 by id
 *                  (--baseline-fit, default 1) so a re-run grades the same baseline
 *   (b) structural head alone
 *   (c) preseason prior: c_mkt = preseason-model.js market curve -> c_struct -> (b);
 *       c_struct = buildProjections({through: s-1}) -> (b)
 *   (d) alpha*b + (1-alpha)*[n/(n+k)*STD + k/(n+k)*P], P in {c_mkt, c_struct},
 *       alpha in {0..1 by 0.1}, k in ROS_K_GRID, k global or per position.
 *       Fit on seasons < s: 2024 fold trains on 2023, 2025 fold on 2023+2024, the
 *       2023 report on 2022, live 2026 on 2023-2025. Pooled MAE, all w. Structure
 *       (P, global vs per-position k) by player-grouped 2-fold CV inside training.
 * Shipping candidate: (d). Test: pairedBootstrapDiff(err_a, err_d, {seed: 20260918,
 *   iterations: 2000, groups: player_id}); mean_diff = mean(err_d - err_a);
 *   significant = 90% interval excludes 0.
 * PASS iff ALL:
 *   1 each validation season, pooled w 1-4: mean_diff < 0 and significant
 *   2 each validation season, each w 1-4: MAE(d) <= MAE(a)
 *   3 each validation season, pooled w 6/8/10: not (mean_diff > 0 and significant)
 * Spearman, the secondary target and d-vs-b are reported, not gated.
 * FAIL ships nothing to trade-engine.js.
 * =================================================================================
 */
process.env.SCHEDULER_DISABLED = '1';

const fs = await import('node:fs');
const { rows } = await import('../server/db/index.js');
const { buildProjections } = await import('../server/services/projections.js');
const { actuals, spearman } = await import('../server/services/backtest.js');
const { WEEKLY_ROLE_RECENCY, weeklyEnsembleContext, weeklyEnsemblePrediction } =
  await import('../server/services/weekly-ensemble.js');
const { weeklyWeightSetById } = await import('../server/services/weekly-weight-store.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const {
  ROS_POSITIONS, rosPriorMap, priorFor, predictRow, selectRosStructure, evaluateRosGate
} = await import('../server/services/ros-projection.js');

const args = process.argv.slice(2);
const SMOKE = args.includes('--smoke');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;

const WS = [1, 2, 3, 4, 6, 8, 10];
const LAST_WEEK = 18;
const SEED = 20260918;
const TRAIN = { 2023: [2022], 2024: [2023], 2025: [2023, 2024], live: [2023, 2024, 2025] };
const REPORT_SEASONS = SMOKE ? [2023] : [2023, 2024, 2025];
const VALIDATION = [2024, 2025];

// Pinned, not looked up: activeWeeklyWeightSet({2026, week 3}) returned fit-1 when this
// gate was graded and returns fit-2 (structural only in weeks 2-4) today, which would
// turn baseline (a) into (b) for w 1-3 and make the recorded table unreproducible.
const PREREGISTERED_BASELINE_FIT = 1;
const baselineIdx = args.indexOf('--baseline-fit');
const BASELINE_FIT = baselineIdx >= 0 ? Number(args[baselineIdx + 1]) : PREREGISTERED_BASELINE_FIT;
const blendWeights = weeklyWeightSetById(BASELINE_FIT);
if (BASELINE_FIT !== PREREGISTERED_BASELINE_FIT) {
  console.error(`NOTE: baseline (a) is ${blendWeights.id}, not the pre-registered fit-${PREREGISTERED_BASELINE_FIT}; ` +
    'the verdict below is NOT the registered gate and the exit code is 2');
}
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r3 = x => (Number.isFinite(x) ? +x.toFixed(3) : null);

/** Every (w, player) row for one season: inputs known after week w, targets after it. */
function seasonDataset(season) {
  const truth = actuals(season);
  const teamOf = new Map();          // player_id -> Map(week -> team)
  const teamWeeks = new Map();       // team -> Set(week)
  for (const u of rows('SELECT player_id, week, team FROM player_week_usage WHERE season = ?', season)) {
    if (!teamOf.has(u.player_id)) teamOf.set(u.player_id, new Map());
    teamOf.get(u.player_id).set(u.week, u.team);
    if (u.team) {
      if (!teamWeeks.has(u.team)) teamWeeks.set(u.team, new Set());
      teamWeeks.get(u.team).add(u.week);
    }
  }
  const priors = rosPriorMap(season);
  const out = [];
  for (const w of WS) {
    const proj = buildProjections({ through: season, throughWeek: w, roleRecency: WEEKLY_ROLE_RECENCY });
    for (const [pid, p] of proj) {
      if (!ROS_POSITIONS.includes(p.position)) continue;
      const t = truth.get(pid);
      if (!t) continue;
      const before = [];
      for (let wk = 1; wk <= w; wk++) if (t.weeks.has(wk)) before.push(t.weeks.get(wk));
      if (!before.length) continue;
      const after = [];
      for (let wk = w + 1; wk <= LAST_WEEK; wk++) if (t.weeks.has(wk)) after.push(t.weeks.get(wk));
      const ctx = weeklyEnsembleContext({ structural: p.ppg, priorWeeks: before, position: p.position });
      const blend = weeklyEnsemblePrediction(ctx, blendWeights.weights);
      let team = null;
      for (let wk = w; wk >= 1 && !team; wk--) team = teamOf.get(pid)?.get(wk) ?? null;
      let teamGames = 0;
      for (const wk of teamWeeks.get(team) ?? []) if (wk > w && wk <= LAST_WEEK) teamGames++;
      const pr = priors.get(pid) ?? {};
      out.push({
        season, w, player_id: pid, name: p.name, position: p.position,
        structural: p.ppg, blend, std: mean(before), n: before.length,
        c_mkt: pr.c_mkt ?? null, c_struct: pr.c_struct ?? null,
        games_after: after.length,
        actual: after.length ? mean(after) : null,
        actual_dnp: teamGames ? after.reduce((s, x) => s + x, 0) / teamGames : null
      });
    }
  }
  return out;
}

const CANDIDATES = {
  a_current: r => r.blend,
  b_structural: r => r.structural,
  c_mkt: r => priorFor(r, 'c_mkt') ?? r.structural,
  c_struct: r => priorFor(r, 'c_struct') ?? r.structural,
  std: r => r.std
};

function metrics(list, pred, target) {
  const pairs = list.filter(r => Number.isFinite(r[target])).map(r => ({ pred: pred(r), act: r[target] }));
  return { mae: r3(mean(pairs.map(p => Math.abs(p.pred - p.act)))), spearman: spearman(pairs), n: pairs.length };
}

const t0 = Date.now();
const seasonsNeeded = [...new Set([...REPORT_SEASONS, ...REPORT_SEASONS.flatMap(s => TRAIN[s]),
  ...(SMOKE ? [] : TRAIN.live)])].sort();
const data = new Map();
for (const s of seasonsNeeded) {
  data.set(s, seasonDataset(s));
  console.error(`built ${s}: ${data.get(s).length} rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
const primary = s => data.get(s).filter(r => r.actual != null);

const report = { blend_weights: blendWeights.id, blend_weights_data_hash: blendWeights.data_hash,
  preregistered_baseline: BASELINE_FIT === PREREGISTERED_BASELINE_FIT, seasons: {}, gate: null, live: null };
const gateRows = [];
for (const s of REPORT_SEASONS) {
  const train = TRAIN[s].flatMap(primary);
  const sel = selectRosStructure(train);
  const rowsS = data.get(s).map(r => ({ ...r, d: predictRow(r, sel.params) }));
  const cands = { ...CANDIDATES, d_update: r => r.d };
  const byW = {};
  for (const w of WS) {
    const wRows = rowsS.filter(r => r.w === w);
    byW[w] = {
      primary: Object.fromEntries(Object.entries(cands).map(([k, f]) => [k, metrics(wRows, f, 'actual')])),
      secondary_dnp: Object.fromEntries(Object.entries(cands).map(([k, f]) => [k, metrics(wRows, f, 'actual_dnp')]))
    };
  }
  const prim = rowsS.filter(r => r.actual != null);
  const pooled = (ws, candKey) => {
    const list = prim.filter(r => ws.includes(r.w));
    const res = pairedBootstrapDiff(list.map(r => Math.abs(r.blend - r.actual)),
      list.map(r => Math.abs(cands[candKey](r) - r.actual)), { seed: SEED, iterations: 2000, groups: list.map(r => r.player_id) });
    return { vs: 'a_current', cand: candKey, ...res };
  };
  const dVsB = ws => {
    const list = prim.filter(r => ws.includes(r.w));
    return pairedBootstrapDiff(list.map(r => Math.abs(r.structural - r.actual)), list.map(r => Math.abs(r.d - r.actual)),
      { seed: SEED, iterations: 2000, groups: list.map(r => r.player_id) });
  };
  report.seasons[s] = {
    trained_on: TRAIN[s], structure_cv: sel.cv.map(c => ({ ...c, cv_mae: r3(c.cv_mae) })), params: sel.params,
    by_w: byW,
    pooled: {
      early_d_vs_a: pooled([1, 2, 3, 4], 'd_update'), late_d_vs_a: pooled([6, 8, 10], 'd_update'),
      early_b_vs_a: pooled([1, 2, 3, 4], 'b_structural'), early_d_vs_b: dVsB([1, 2, 3, 4]), late_d_vs_b: dVsB([6, 8, 10])
    }
  };
  if (VALIDATION.includes(s)) {
    for (const r of prim) gateRows.push({ season: s, w: r.w, player_id: r.player_id,
      err_a: Math.abs(r.blend - r.actual), err_d: Math.abs(r.d - r.actual) });
  }
}

if (!SMOKE) {
  report.gate = evaluateRosGate(gateRows, { seasons: VALIDATION, seed: SEED });
  const live = selectRosStructure(TRAIN.live.flatMap(primary));
  report.live = { trained_on: TRAIN.live, structure_cv: live.cv.map(c => ({ ...c, cv_mae: r3(c.cv_mae) })), params: live.params };
}

/* ------------------------------------------------------------------ print */
const pad = (x, n) => String(x ?? '-').padStart(n);
for (const s of REPORT_SEASONS) {
  const S = report.seasons[s];
  const p = S.params;
  console.log(`\n=== ${s} (fit on ${S.trained_on.join('+')}): prior=${p.prior} alpha=${p.alpha} k=${JSON.stringify(p.k)}`);
  console.log(`structure CV: ${S.structure_cv.map(c => `${c.prior}/${c.perPosition ? 'pos' : 'global'}=${c.cv_mae}`).join('  ')}`);
  console.log('PRIMARY  MAE (Spearman) by w   [n]');
  console.log(`${'w'.padStart(3)} ${Object.keys(S.by_w[1].primary).map(k => k.padStart(16)).join('')}`);
  for (const w of WS) {
    const m = S.by_w[w].primary;
    console.log(`${pad(w, 3)} ${Object.values(m).map(v => pad(`${v.mae} (${v.spearman?.toFixed(2)})`, 16)).join('')}   [${m.a_current.n}]`);
  }
  console.log('SECONDARY (DNP=0 per team game) MAE (Spearman) by w');
  for (const w of WS) {
    const m = S.by_w[w].secondary_dnp;
    console.log(`${pad(w, 3)} ${Object.values(m).map(v => pad(`${v.mae} (${v.spearman?.toFixed(2)})`, 16)).join('')}   [${m.a_current.n}]`);
  }
  const f = b => `${b.mean_diff} ci90 [${b.ci90?.join(', ')}] ${b.significant ? 'SIG' : 'ns'} n=${b.n}`;
  console.log(`pooled d-a early w1-4: ${f(S.pooled.early_d_vs_a)}`);
  console.log(`pooled d-a late w6-10: ${f(S.pooled.late_d_vs_a)}`);
  console.log(`pooled b-a early w1-4: ${f(S.pooled.early_b_vs_a)}`);
  console.log(`pooled d-b early w1-4: ${f(S.pooled.early_d_vs_b)}   late: ${f(S.pooled.late_d_vs_b)}`);
}
if (report.gate) {
  console.log('\n=== GATE');
  for (const c of report.gate.checks) {
    console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.rule} ${c.season}${c.w ? ` w${c.w}` : ''} ${c.mean_diff != null
      ? `mean_diff ${c.mean_diff} ci90 [${c.ci90?.join(', ')}] n=${c.n}` : `MAE a ${r3(c.mae_a)} d ${r3(c.mae_d)} n=${c.n}`}`);
  }
  console.log(`VERDICT: ${report.gate.pass ? 'PASS' : 'FAIL'}`);
  const L = report.live;
  console.log(`\nlive fit (${L.trained_on.join('+')}): ${JSON.stringify(L.params)}`);
  console.log(`live structure CV: ${L.structure_cv.map(c => `${c.prior}/${c.perPosition ? 'pos' : 'global'}=${c.cv_mae}`).join('  ')}`);
}
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
process.exit(BASELINE_FIT !== PREREGISTERED_BASELINE_FIT ? 2 : SMOKE ? 0 : report.gate?.pass ? 0 : 1);
