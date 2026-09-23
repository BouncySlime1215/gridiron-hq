/**
 * AI-01 study: does opportunity-based ROS (season-to-date xFP per game) predict the
 * next five weeks' points per game better than points-based ROS (season-to-date PPG)?
 *
 *   GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 node scripts/study-true-value.mjs [--s1] [--s2] [--fc]
 *
 * Pre-registration: docs/tdd/2026-09-23-true-value-opportunity.prereg.md (committed
 * before this script produced any number). Read-only on the database. Study code only:
 * nothing in server/ imports this file.
 */
process.env.SCHEDULER_DISABLED = '1';
const fs = await import('node:fs');
const os = await import('node:os');
const { rows } = await import('../server/db/index.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

const args = process.argv.slice(2);
const ALL = !args.some(a => ['--s1', '--s2', '--fc'].includes(a));
const SEED = 20260923;
const POS = ['QB', 'RB', 'WR', 'TE'];
const TOPN = { QB: 24, RB: 48, WR: 60, TE: 24 };
const CUTS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r4 = x => (Number.isFinite(x) ? +x.toFixed(4) : null);

/* --------------------------------------------------------------- pair accuracy */
// Same-position (or all) pairs within a group; equal target dropped; prediction tie = 0.5.
function pairList(list, key, target, { samePos = true, groupKey = r => `${r.season}|${r.t}` } = {}) {
  const groups = new Map();
  for (const r of list) {
    if (!Number.isFinite(r[target]) || !Number.isFinite(r[key])) continue;
    const g = groupKey(r) + (samePos ? `|${r.position}` : '');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const out = [];
  for (const L of groups.values()) {
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      if (a[target] === b[target]) continue;
      const score = a[key] === b[key] ? 0.5 : ((a[key] > b[key]) === (a[target] > b[target]) ? 1 : 0);
      out.push([a.cluster, b.cluster, score]);
    }
  }
  return out;
}
const acc = p => p.reduce((s, x) => s + x[2], 0) / p.length;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// Player-cluster bootstrap of acc(pc) - acc(pi); each pair weighted by the product of multiplicities.
function pairBootDiff(pc, pi, B = 1000, seed = SEED) {
  const ids = [...new Set([...pc, ...pi].flatMap(p => [p[0], p[1]]))];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const enc = p => p.map(([a, b, s]) => [idx.get(a), idx.get(b), s]);
  const C = enc(pc), I = enc(pi);
  const rand = rng(seed); const cnt = new Float64Array(ids.length); const ds = [];
  for (let it = 0; it < B; it++) {
    cnt.fill(0);
    for (let k = 0; k < ids.length; k++) cnt[Math.floor(rand() * ids.length)]++;
    const f = P => { let num = 0, den = 0; for (const [a, b, s] of P) { const w = cnt[a] * cnt[b]; if (w) { num += w * s; den += w; } } return num / den; };
    ds.push(f(C) - f(I));
  }
  ds.sort((x, y) => x - y);
  const lo = ds[Math.floor(0.05 * B)], hi = ds[Math.floor(0.95 * B)];
  return { diff: r4(acc(pc) - acc(pi)), ci90: [r4(lo), r4(hi)], n_pairs: pc.length, mde80: r4(1.512 * (hi - lo) / 2) };
}
function disagreement(list, target, keyA = 'xfp', keyB = 'std') {
  const groups = new Map();
  for (const r of list) {
    const g = `${r.season}|${r.t}|${r.position}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  let n = 0, right = 0;
  for (const L of groups.values()) for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j];
    if (a[target] === b[target] || a[keyA] === b[keyA] || a[keyB] === b[keyB]) continue;
    if ((a[keyA] > b[keyA]) !== (a[keyB] > b[keyB])) { n++; if ((a[keyA] > b[keyA]) === (a[target] > b[target])) right++; }
  }
  return { n, a_right: r4(right / n) };
}
function maeBlock(list, keyC, keyI, target) {
  const L = list.filter(r => Number.isFinite(r[target]));
  const ei = L.map(r => Math.abs(r[keyI] - r[target])), ec = L.map(r => Math.abs(r[keyC] - r[target]));
  const b = pairedBootstrapDiff(ei, ec, { seed: SEED, iterations: 2000, groups: L.map(r => r.cluster) });
  return { mae_cand: r4(mean(ec)), mae_inc: r4(mean(ei)), diff: b.mean_diff, ci90: b.ci90,
    mde80: r4(1.512 * (b.ci90[1] - b.ci90[0]) / 2), n: L.length };
}

/* ------------------------------------------------------------------- S1 rows */
function s1Rows(season) {
  const byP = new Map();
  for (const r of rows(`SELECT player_gsis_id id, position, week, expected_fantasy_points x, actual_fantasy_points a
      FROM nfl_ffopportunity_weekly WHERE season = ? AND week <= 18`, season)) {
    if (!POS.includes(r.position) || r.x == null || r.a == null) continue;
    if (!byP.has(r.id)) byP.set(r.id, { position: r.position, weeks: new Map() });
    byP.get(r.id).weeks.set(r.week, { x: r.x, a: r.a });
  }
  const out = [];
  for (const t of CUTS) {
    const cand = [];
    for (const [id, p] of byP) {
      const before = [...p.weeks].filter(([w]) => w <= t).map(([, v]) => v);
      if (before.length < 3) continue;
      const after = [...p.weeks].filter(([w]) => w > t && w <= t + 5).map(([, v]) => v);
      if (!after.length) continue;
      cand.push({ season, t, cluster: id, position: p.position, n: before.length,
        xfp: mean(before.map(v => v.x)), std: mean(before.map(v => v.a)),
        next5_ppg: mean(after.map(v => v.a)), next5_total: after.reduce((s, v) => s + v.a, 0) });
    }
    for (const pos of POS) {
      const L = cand.filter(r => r.position === pos);
      const top = k => new Set([...L].sort((a, b) => b[k] - a[k]).slice(0, TOPN[pos]).map(r => r.cluster));
      const keep = new Set([...top('xfp'), ...top('std')]);
      for (const r of L) if (keep.has(r.cluster)) out.push({ ...r, luck: r.std - r.xfp });
    }
  }
  return out;
}

function s1Report(list, label) {
  const pc = pairList(list, 'xfp', 'next5_ppg'), pi = pairList(list, 'std', 'next5_ppg');
  const pcA = pairList(list, 'xfp', 'next5_ppg', { samePos: false }), piA = pairList(list, 'std', 'next5_ppg', { samePos: false });
  return {
    label, rows: list.length, players: new Set(list.map(r => r.cluster)).size,
    mae_next5_ppg: maeBlock(list, 'xfp', 'std', 'next5_ppg'),
    pair_same_pos: { cand: r4(acc(pc)), inc: r4(acc(pi)), ...pairBootDiff(pc, pi) },
    pair_all: { cand: r4(acc(pcA)), inc: r4(acc(piA)) },
    secondary_total: { pair_same_pos_cand: r4(acc(pairList(list, 'xfp', 'next5_total'))), pair_same_pos_inc: r4(acc(pairList(list, 'std', 'next5_total'))) },
    decision_disagreement: disagreement(list, 'next5_ppg')
  };
}

const out = { tree: process.env.STUDY_TREE ?? null, db: process.env.GRIDIRON_DB_PATH ?? null };
const print = (k, v) => { out[k] = v; console.log(`\n## ${k}\n${JSON.stringify(v)}`); };

if (ALL || args.includes('--s1')) {
  const gated = [2021, 2022, 2023, 2024].flatMap(s1Rows);
  print('S1_pooled_2021_2024', s1Report(gated, 'gated'));
  const perSeason = {};
  for (const s of [2021, 2022, 2023, 2024]) {
    const L = gated.filter(r => r.season === s);
    const m = maeBlock(L, 'xfp', 'std', 'next5_ppg');
    perSeason[s] = { rows: L.length, mae_cand: m.mae_cand, mae_inc: m.mae_inc, diff: m.diff, ci90: m.ci90,
      pair_cand: r4(acc(pairList(L, 'xfp', 'next5_ppg'))), pair_inc: r4(acc(pairList(L, 'std', 'next5_ppg'))) };
  }
  print('S1_per_season', perSeason);
  const perCut = {};
  for (const t of CUTS) {
    const L = gated.filter(r => r.t === t);
    perCut[t] = { rows: L.length, mae_cand: r4(mean(L.map(r => Math.abs(r.xfp - r.next5_ppg)))), mae_inc: r4(mean(L.map(r => Math.abs(r.std - r.next5_ppg)))),
      pair_cand: r4(acc(pairList(L, 'xfp', 'next5_ppg'))), pair_inc: r4(acc(pairList(L, 'std', 'next5_ppg'))) };
  }
  print('S1_per_cutoff', perCut);
  const perPos = {};
  for (const pos of POS) {
    const L = gated.filter(r => r.position === pos);
    perPos[pos] = { rows: L.length, mae_cand: r4(mean(L.map(r => Math.abs(r.xfp - r.next5_ppg)))), mae_inc: r4(mean(L.map(r => Math.abs(r.std - r.next5_ppg)))),
      pair_cand: r4(acc(pairList(L, 'xfp', 'next5_ppg'))), pair_inc: r4(acc(pairList(L, 'std', 'next5_ppg'))) };
  }
  print('S1_per_position', perPos);
  // Luck (reported): does season-to-date luck (std - xfp) carry into the next five weeks?
  // Slope of (next5_ppg - xfp) on luck: 1 = fully persistent (efficiency is skill), 0 = pure noise.
  const luckBy = {};
  for (const pos of POS) {
    const L = gated.filter(r => r.position === pos);
    const mx = mean(L.map(r => r.luck)), my = mean(L.map(r => r.next5_ppg - r.xfp));
    let sxy = 0, sxx = 0; for (const r of L) { sxy += (r.luck - mx) * (r.next5_ppg - r.xfp - my); sxx += (r.luck - mx) ** 2; }
    luckBy[pos] = { rows: L.length, mean_luck: r4(mx), mean_abs_luck: r4(mean(L.map(r => Math.abs(r.luck)))), carry_slope: r4(sxy / sxx) };
  }
  print('S1_luck_carry', luckBy);
  // Holdout look (ledger): 2025, reported, not gated.
  print('S1_2025_reported', s1Report(s1Rows(2025), '2025 holdout look'));
  // Forward rule 5: any 2026 cutoff with t >= 3 and five later weeks?
  const wk = rows(`SELECT season, COUNT(DISTINCT week) weeks, MAX(week) max_week, COUNT(*) n FROM nfl_ffopportunity_weekly
      WHERE season IN (2025, 2026) AND week <= 18 GROUP BY season`);
  const usage = rows(`SELECT season, COUNT(DISTINCT week) weeks, COUNT(*) n FROM player_week_usage WHERE season IN (2025, 2026) GROUP BY season`);
  const fwdRows = s1Rows(2026);
  print('forward_2026', { ffopportunity_weeks: wk, usage_weeks: usage, s1_rows_2026: fwdRows.length,
    control_s1_rows_2025: out.S1_2025_reported.rows });
}

/* ---------------------------------------------------------------------- S2 */
if (ALL || args.includes('--s2')) {
  const { buildProjections } = await import('../server/services/projections.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
  const { activeKVectorFor } = await import('../server/services/shrinkage-fit.js');
  const { ROS_POSITIONS, rosPriorMap, predictRow, selectRosStructure } = await import('../server/services/ros-projection.js');
  const WS = [1, 2, 3, 4, 6, 8, 10];
  const kControl = {};
  for (const s of [2022, 2023, 2024]) {
    const v = activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: s });
    if (!v) { console.error(`STOP: activeKVectorFor(${s}) returned null (fitted k withheld)`); process.exit(2); }
    const shareKs = Object.entries(v).filter(([m]) => /share/.test(m)).flatMap(([m, byPos]) => Object.entries(byPos).map(([p, k]) => `${m}.${p}=${r4(k)}`));
    if (Object.entries(v).some(([m, byPos]) => /share/.test(m) && Object.values(byPos).some(k => k === 6))) {
      console.error(`STOP: share k = 6 for ${s}`); process.exit(2);
    }
    kControl[s] = shareKs;
  }
  print('S2_k_control', kControl);
  const gsisOf = new Map(rows('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL').map(r => [r.id, r.gsis_id]));
  const xfpBy = new Map();
  for (const r of rows(`SELECT season, week, player_gsis_id id, expected_fantasy_points x FROM nfl_ffopportunity_weekly
      WHERE season BETWEEN 2022 AND 2024 AND week <= 18 AND expected_fantasy_points IS NOT NULL`)) {
    xfpBy.set(`${r.season}|${r.id}|${r.week}`, r.x);
  }
  function dataset(season, ws) {
    const truth = actuals(season); const priors = rosPriorMap(season); const res = [];
    for (const w of ws) {
      const proj = buildProjections({ through: season, throughWeek: w, roleRecency: WEEKLY_ROLE_RECENCY });
      for (const [pid, p] of proj) {
        if (!ROS_POSITIONS.includes(p.position)) continue;
        const t = truth.get(pid); if (!t) continue;
        const beforeW = [...t.weeks.keys()].filter(k => k <= w);
        if (!beforeW.length) continue;
        const after = [...t.weeks].filter(([k]) => k > w && k <= 18).map(([, v]) => v);
        const next5 = [...t.weeks].filter(([k]) => k > w && k <= w + 5).map(([, v]) => v);
        const g = gsisOf.get(pid);
        const xs = g ? beforeW.map(k => xfpBy.get(`${season}|${g}|${k}`)).filter(Number.isFinite) : [];
        const pr = priors.get(pid) ?? {};
        res.push({ season, w, t: w, player_id: pid, cluster: g ?? `pid${pid}`, position: p.position,
          structural: p.ppg, std: mean(beforeW.map(k => t.weeks.get(k))), n: beforeW.length,
          c_mkt: pr.c_mkt ?? null, c_struct: pr.c_struct ?? null,
          actual: after.length ? mean(after) : null, next5_ppg: next5.length ? mean(next5) : null,
          xfp: xs.length === beforeW.length ? mean(xs) : null });
      }
    }
    return res;
  }
  const t0 = Date.now();
  const data = {};
  for (const s of [2022, 2023, 2024]) { data[s] = dataset(s, WS); console.error(`built ${s} ${data[s].length} rows ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
  const graded = [];
  const params = {};
  for (const [s, train] of [[2023, 2022], [2024, 2023]]) {
    const sel = selectRosStructure(data[train].filter(r => r.actual != null));
    params[s] = sel.params;
    for (const r of data[s]) {
      if (![4, 6, 8, 10].includes(r.w) || r.n < 3 || r.next5_ppg == null || !Number.isFinite(r.xfp)) continue;
      const ros = predictRow(r, sel.params);
      const rosX = predictRow({ ...r, std: r.xfp }, sel.params);
      if (!Number.isFinite(ros)) continue;
      graded.push({ ...r, ros, ros_xfp: rosX });
    }
  }
  print('S2_params_walk_forward', params);
  // Same union top-N population rule as S1, by either arm (xfp or served ros).
  const pop = [];
  for (const s of [2023, 2024]) for (const w of [4, 6, 8, 10]) for (const pos of POS) {
    const L = graded.filter(r => r.season === s && r.w === w && r.position === pos);
    const top = k => new Set([...L].sort((a, b) => b[k] - a[k]).slice(0, TOPN[pos]).map(r => r.player_id));
    const keep = new Set([...top('xfp'), ...top('ros')]);
    for (const r of L) if (keep.has(r.player_id)) pop.push(r);
  }
  const pc = pairList(pop, 'xfp', 'next5_ppg'), pi = pairList(pop, 'ros', 'next5_ppg');
  const pX = pairList(pop, 'ros_xfp', 'next5_ppg'), pS = pairList(pop, 'std', 'next5_ppg');
  print('S2_xfp_vs_served_ros', {
    rows: pop.length, mae_next5_ppg: maeBlock(pop, 'xfp', 'ros', 'next5_ppg'),
    pair_same_pos: { cand: r4(acc(pc)), inc: r4(acc(pi)), ...pairBootDiff(pc, pi) },
    reported_ros_with_xfp_vs_ros: { mae: maeBlock(pop, 'ros_xfp', 'ros', 'next5_ppg'), pair: { cand: r4(acc(pX)), inc: r4(acc(pi)), ...pairBootDiff(pX, pi) } },
    reported_std_on_same_rows: { mae: r4(mean(pop.map(r => Math.abs(r.std - r.next5_ppg)))), pair: r4(acc(pS)) },
    decision_disagreement_xfp_vs_ros: disagreement(pop, 'next5_ppg', 'xfp', 'ros')
  });
}

/* ------------------------------------------------------------ FantasyCalc */
if (ALL || args.includes('--fc')) {
  const { actuals } = await import('../server/services/backtest.js');
  const DIR = `${os.homedir()}/gridiron-local/rnd/loop/data/r3x_fc_wayback/`;
  const SNAPS = [['fc_20231004163214.json', 2023, 4, 5], ['fc_20231010180643.json', 2023, 5, 6],
    ['fc_20231022043707.json', 2023, 6, 8], ['fc_20231107215321.json', 2023, 9, 10],
    ['fc_20231203152230.json', 2023, 12, 14], ['fc_20240918081004.json', 2024, 2, 3]];
  const byEspn = new Map(rows('SELECT id, espn_id, gsis_id FROM players WHERE espn_id IS NOT NULL').map(r => [String(r.espn_id), r]));
  const truth = { 2023: actuals(2023), 2024: actuals(2024) };
  const xfp = new Map(rows(`SELECT season, week, player_gsis_id id, expected_fantasy_points x FROM nfl_ffopportunity_weekly
      WHERE season IN (2023, 2024) AND week <= 18`).map(r => [`${r.season}|${r.id}|${r.week}`, r.x]));
  const list = [];
  for (const [f, season, t, r0] of SNAPS) {
    const d = JSON.parse(fs.readFileSync(DIR + f, 'utf8'));
    for (const it of d) {
      const pl = it.player; if (!['RB', 'WR', 'TE'].includes(pl.position)) continue;
      const p = byEspn.get(String(pl.espnId)); if (!p || !p.gsis_id) continue;
      const wk = truth[season].get(p.id)?.weeks; if (!wk) continue;
      const bw = [...wk.keys()].filter(w => w <= t); if (!bw.length) continue;
      const xs = bw.map(w => xfp.get(`${season}|${p.gsis_id}|${w}`)).filter(Number.isFinite);
      if (xs.length !== bw.length) continue;
      let ros = 0; for (let w = r0; w <= 17; w++) ros += wk.get(w) ?? 0;
      list.push({ season, t: f.slice(3, 11), cluster: p.gsis_id, position: pl.position, fc: it.value,
        std: mean(bw.map(w => wk.get(w))), xfp: mean(xs), ros });
    }
  }
  const P = k => pairList(list, k, 'ros', { groupKey: r => r.t });
  const pf = P('fc'), px = P('xfp'), ps = P('std');
  print('FC_wayback_ros_total', { player_snapshots: list.length, pair_fc: r4(acc(pf)), pair_xfp: r4(acc(px)), pair_std: r4(acc(ps)),
    xfp_minus_fc: pairBootDiff(px, pf), xfp_minus_std: pairBootDiff(px, ps), fc_minus_std_control: pairBootDiff(pf, ps) });
}

if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(out, null, 2));
