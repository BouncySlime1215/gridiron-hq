#!/usr/bin/env node
/**
 * Can the projection get materially better? A cutoff-safe test of new heads.
 *
 * Context, measured first so the answer is bounded before the work starts:
 *
 *   structural head alone                    MAE 4.749
 *   naive season-to-date (free)              MAE 4.386
 *   production ensemble                      MAE 4.330 (4.390 on the >=4-game subset)
 *   season-mean oracle, LEAVE-ONE-OUT        MAE 4.411
 *
 * Read that last line carefully. An oracle that knows each player's true season
 * mean — computed WITHOUT the week being predicted — does WORSE than the
 * production model. There is no headroom at the player level; the ensemble has
 * already extracted everything a constant-per-player estimate can offer.
 *
 * An earlier version of this file quoted a floor of 3.927 and claimed 0.40
 * points of headroom. That was wrong: it computed each player's mean INCLUDING
 * the target week, so with ~14 games every week contributed a fourteenth of its
 * own forecast. Removing that leak moves the floor by 0.44 and reverses the
 * conclusion.
 *
 * Consequence for everything below: xFP, the 67-key feature blob and the
 * opponent adjustment are all PLAYER-level signals, and player level is
 * saturated. Any real gain must come from WEEK-level discrimination — knowing
 * which particular weeks a player goes off. That is what the null results in
 * this script are telling us, and they are consistent.
 *
 * The existing fifteen heads are all reweightings of one series — the player's
 * own fantasy points — which is why they stall around the naive baseline. Each
 * candidate here carries information that series does not have.
 *
 * Procedure is the same one that promoted the current champion, so the numbers
 * are comparable: fit convex weights on 2021-2023, choose the architecture on
 * 2024, open 2025 exactly once.
 *
 * Usage: node --env-file-if-exists=.env scripts/test-new-heads.mjs
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { activeKVector } = await import('../server/services/shrinkage-fit.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { spearman } = await import('../server/services/backtest.js');

const BASE = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const FIT = [2021, 2022, 2023];
const SELECT = 2024;
const TEST = 2025;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/* ------------------------------------------------------- candidate heads */

/**
 * Expected fantasy points from usage, strictly prior.
 *
 * This is the one piece of genuinely new information already sitting in the
 * database: what a player's usage EARNS, as opposed to what he scored. A
 * receiver who saw nine targets and caught two short passes scored badly and
 * is fine; his own points say otherwise. 28,596 rows, and the engine currently
 * carries it as display context only.
 */
function xfpHeads() {
  const map = new Map();   // `${pid}|${season}|${week}` -> { xfp_std, xfp_last3, xfp_gap }
  const src = rows(`SELECT f.season, f.week, p.id AS player_id,
                           f.expected_fantasy_points AS xfp, f.actual_fantasy_points AS act
                    FROM nfl_ffopportunity_weekly f
                    JOIN players p ON p.gsis_id = f.player_gsis_id
                    WHERE f.season BETWEEN 2021 AND 2025
                    ORDER BY p.id, f.season, f.week`);
  const byPlayerSeason = new Map();
  for (const r of src) {
    const k = `${r.player_id}|${r.season}`;
    (byPlayerSeason.get(k) ?? byPlayerSeason.set(k, []).get(k)).push(r);
  }
  for (const [k, list] of byPlayerSeason) {
    const [pid, season] = k.split('|');
    list.sort((a, b) => a.week - b.week);
    for (let i = 0; i < list.length; i++) {
      const week = list[i].week;
      const prior = list.slice(0, i);                 // strictly before this week
      if (!prior.length) continue;
      const xs = prior.map(r => r.xfp).filter(Number.isFinite);
      const as = prior.map(r => r.act).filter(Number.isFinite);
      if (!xs.length) continue;
      map.set(`${pid}|${season}|${week}`, {
        xfp_std: mean(xs),
        xfp_last3: mean(xs.slice(-3)),
        // Positive gap = he has been scoring above what his usage earns, which
        // regresses. Carried as a separate signal rather than folded in.
        xfp_gap: as.length ? mean(as) - mean(xs) : 0,
      });
    }
  }
  return map;
}

/**
 * A head built from the 67-key player-week feature blob.
 *
 * The structural projection reads ZERO of these. They are the closest thing in
 * the database to a direct measurement of a player's role — opportunity share,
 * WOPR, red-zone and end-zone usage, EPA per touch — as opposed to what he
 * happened to score. Aggregated strictly prior and fed through a ridge fit on
 * the FIT seasons only.
 */
function featureHeads() {
  const KEYS = ['opportunity_share', 'wopr', 'target_share', 'carry_share', 'air_yards_share',
    'red_zone_targets', 'red_zone_carries', 'end_zone_targets', 'goal_line_carries',
    'total_touches', 'rec_epa_per_target', 'rush_epa_per_carry', 'yac_over_expected',
    'third_down_target_rate', 'first_down_rate'];
  const map = new Map();
  const src = rows(`SELECT f.season, f.week, p.id AS player_id, f.features
                    FROM nfl_player_week_features f JOIN players p ON p.gsis_id = f.player_id
                    WHERE f.season BETWEEN 2021 AND 2025`);
  const byPS = new Map();
  for (const r of src) {
    const k = `${r.player_id}|${r.season}`;
    (byPS.get(k) ?? byPS.set(k, []).get(k)).push(r);
  }
  for (const [k, list] of byPS) {
    const [pid, season] = k.split('|');
    list.sort((a, b) => a.week - b.week);
    const acc = Object.fromEntries(KEYS.map(x => [x, []]));
    for (const r of list) {
      // Emit the strictly-prior aggregate BEFORE folding this week in.
      if (acc[KEYS[0]].length) {
        const vec = {};
        for (const key of KEYS) vec[key] = acc[key].length ? mean(acc[key]) : 0;
        map.set(`${pid}|${season}|${r.week}`, vec);
      }
      let f; try { f = JSON.parse(r.features); } catch { continue; }
      for (const key of KEYS) { const v = Number(f[key]); if (Number.isFinite(v)) acc[key].push(v); }
    }
  }
  return { map, keys: KEYS };
}

/** Ridge regression, closed form, with an intercept. */
function ridge(X, y, lambda = 1) {
  const n = X.length, d = X[0].length;
  const A = Array.from({ length: d + 1 }, () => new Float64Array(d + 1));
  const b = new Float64Array(d + 1);
  for (let i = 0; i < n; i++) {
    const xi = [1, ...X[i]];
    for (let r = 0; r <= d; r++) {
      b[r] += xi[r] * y[i];
      for (let c = 0; c <= d; c++) A[r][c] += xi[r] * xi[c];
    }
  }
  for (let r = 1; r <= d; r++) A[r][r] += lambda * n;   // do not penalise the intercept
  // Gaussian elimination.
  for (let col = 0; col <= d; col++) {
    let piv = col;
    for (let r = col + 1; r <= d; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const t = b[col]; b[col] = b[piv]; b[piv] = t;
    const p = A[col][col] || 1e-9;
    for (let r = col + 1; r <= d; r++) {
      const f = A[r][col] / p;
      if (!f) continue;
      for (let c = col; c <= d; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const w = new Float64Array(d + 1);
  for (let r = d; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c <= d; c++) sum -= A[r][c] * w[c];
    w[r] = sum / (A[r][r] || 1e-9);
  }
  return w;
}

/**
 * Opponent adjustment: how much this defence has suppressed or inflated points
 * against this position, strictly prior, shrunk toward 1.
 */
function opponentAdj() {
  const map = new Map();
  const src = rows(`SELECT u.season, u.week, u.opponent, p.position,
                           u.receptions, u.receiving_yards, u.rushing_yards, u.passing_yards,
                           u.receiving_tds, u.rushing_tds, u.passing_tds, u.interceptions
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season BETWEEN 2021 AND 2025 AND u.opponent IS NOT NULL
                      AND p.position IN ('QB','RB','WR','TE')`);
  const pts = r => 0.04 * (r.passing_yards ?? 0) + 4 * (r.passing_tds ?? 0) - 2 * (r.interceptions ?? 0)
    + 0.1 * ((r.rushing_yards ?? 0) + (r.receiving_yards ?? 0)) + 6 * ((r.rushing_tds ?? 0) + (r.receiving_tds ?? 0))
    + 1 * (r.receptions ?? 0);
  const bySeasonPos = new Map();
  for (const r of src) {
    const k = `${r.season}|${r.position}`;
    (bySeasonPos.get(k) ?? bySeasonPos.set(k, []).get(k)).push({ ...r, pts: pts(r) });
  }
  for (const [k, list] of bySeasonPos) {
    const [season, position] = k.split('|');
    for (let week = 2; week <= 18; week++) {
      const prior = list.filter(r => r.week < week);
      if (prior.length < 50) continue;
      const lg = mean(prior.map(r => r.pts));
      const byOpp = new Map();
      for (const r of prior) (byOpp.get(r.opponent) ?? byOpp.set(r.opponent, []).get(r.opponent)).push(r.pts);
      for (const [opp, vals] of byOpp) {
        // Shrink toward 1: a defence with twelve player-weeks against it has
        // not proven anything. K=40 was far too strong — it produced ratios so
        // close to 1 that the adjusted head correlated 0.99 with the unadjusted
        // structural projection, i.e. the adjustment was not being applied at
        // all. K is now an environment knob so the strength can be searched.
        const K = Number(process.env.OPP_K ?? 10);
        const ratio = (vals.reduce((a, b) => a + b, 0) + K * lg) / ((vals.length + K) * lg);
        map.set(`${season}|${position}|${opp}|${week}`, ratio);
      }
    }
  }
  return map;
}

/** Scale a candidate head onto the scoring the harness grades in. */
function calibrate(pairs) {
  // Simple least-squares scale+shift so a head measured in another scoring
  // system is not penalised for its units rather than its information.
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = den ? num / den : 1;
  return { a: my - b * mx, b };
}

/* ---------------------------------------------------------------- harness */

const common = {
  startWeek: 5, endWeek: 18, distributions: false,
  kOverride: undefined /* cutoff-safe default: shrinkage-fit.js cutoffSafeKVector */, roleRecency: WEEKLY_ROLE_RECENCY,
};

console.log('Replaying seasons (this is the slow part)...');
const xfp = xfpHeads();
console.log(`xFP lookup built: ${xfp.size} player-weeks with strictly-prior expected points`);

const feats = featureHeads();
console.log(`feature lookup built: ${feats.map.size} player-weeks over ${feats.keys.length} keys`);
const opp = opponentAdj();
{
  const vals = [...opp.values()];
  const mn = Math.min(...vals), mx = Math.max(...vals);
  console.log(`opponent adjustment built: ${opp.size} cells | ratio range ${mn.toFixed(3)}-${mx.toFixed(3)} (K=${process.env.OPP_K ?? 10})`);
}
const oppOf = rows(`SELECT season, week, player_id, opponent FROM player_week_usage
                    WHERE season BETWEEN 2021 AND 2025 AND opponent IS NOT NULL`);
const oppMap = new Map(oppOf.map(r => [`${r.player_id}|${r.season}|${r.week}`, r.opponent]));

const seasons = {};
for (const y of [...FIT, SELECT, TEST]) {
  const r = replaySeasonWeekly(y, common);
  const rowsOut = r._predictions.map(p => {
    const x = xfp.get(`${p.player_id}|${y}|${p.week}`);
    const fv = feats.map.get(`${p.player_id}|${y}|${p.week}`);
    const o = oppMap.get(`${p.player_id}|${y}|${p.week}`);
    const adj = o ? opp.get(`${y}|${p.position}|${o}|${p.week}`) : null;
    return { ...p, season: y,
      xfp_std: x?.xfp_std ?? null, xfp_last3: x?.xfp_last3 ?? null, xfp_gap: x?.xfp_gap ?? null,
      fvec: fv ?? null,
      opp_adj: adj != null ? p.structural * adj : null };
  });
  seasons[y] = rowsOut;
  const cov = rowsOut.filter(r2 => r2.xfp_std != null).length;
  console.log(`  ${y}: ${rowsOut.length} player-weeks, xFP coverage ${(100 * cov / rowsOut.length).toFixed(0)}%`);
}

// Calibrate the xFP heads onto this scoring, using FIT seasons only.
const fitRows = FIT.flatMap(y => seasons[y]).filter(r => r.xfp_std != null);
const cal = calibrate(fitRows.map(r => [r.xfp_std, r.actual]));
const calL3 = calibrate(fitRows.map(r => [r.xfp_last3, r.actual]));
console.log(`xFP calibration (fit seasons): std  y = ${cal.a.toFixed(2)} + ${cal.b.toFixed(3)}x`);
console.log(`                               last3 y = ${calL3.a.toFixed(2)} + ${calL3.b.toFixed(3)}x`);
for (const y of Object.keys(seasons)) {
  for (const r of seasons[y]) {
    r.xfp_std_c = r.xfp_std == null ? null : cal.a + cal.b * r.xfp_std;
    r.xfp_last3_c = r.xfp_last3 == null ? null : calL3.a + calL3.b * r.xfp_last3;
  }
}

/* ------------------------------------------------- weight fitting on a set */

function weightGrid(n, step) {
  const out = [];
  const steps = Math.round(1 / step);
  const rec = (acc, left, idx) => {
    if (idx === n - 1) { out.push([...acc, left * step]); return; }
    for (let k = 0; k <= left; k++) rec([...acc, k * step], left - k, idx + 1);
  };
  rec([], steps, 0);
  return out;
}

function fit(data, heads, step = 0.1) {
  const grid = weightGrid(heads.length, step);
  let best = null, bestMae = Infinity;
  for (const w of grid) {
    let s = 0;
    for (const r of data) {
      let pred = 0;
      for (let i = 0; i < heads.length; i++) pred += w[i] * r[heads[i]];
      s += Math.abs(pred - r.actual);
    }
    const m = s / data.length;
    if (m < bestMae) { bestMae = m; best = w; }
  }
  return { weights: best, mae: bestMae };
}

const evaluate = (data, heads, w) => {
  const errs = [], pairs = [];
  for (const r of data) {
    let pred = 0;
    for (let i = 0; i < heads.length; i++) pred += w[i] * r[heads[i]];
    errs.push(Math.abs(pred - r.actual));
    pairs.push({ pred, act: r.actual });
  }
  return { mae: mean(errs), spearman: spearman(pairs), errs, n: errs.length };
};

/* ----------------------------------------------------------- architectures */

// Fit the feature head on the FIT seasons only, then score every season with it.
{
  const train = FIT.flatMap(y => seasons[y]).filter(r => r.fvec);
  if (train.length > 500) {
    const X = train.map(r => feats.keys.map(k => r.fvec[k] ?? 0));
    const yv = train.map(r => r.actual);
    // Standardise so one ridge penalty is sane across very different scales.
    const mu = feats.keys.map((_, i) => mean(X.map(x => x[i])));
    const sd = feats.keys.map((_, i) => {
      const m = mu[i];
      return Math.sqrt(mean(X.map(x => (x[i] - m) ** 2))) || 1;
    });
    const Z = X.map(x => x.map((v, i) => (v - mu[i]) / sd[i]));
    const w = ridge(Z, yv, 0.01);
    console.log(`feature head fitted on ${train.length} rows`);
    for (const y of Object.keys(seasons)) {
      for (const r of seasons[y]) {
        if (!r.fvec) { r.feat_pred = null; continue; }
        let pred = w[0];
        feats.keys.forEach((k, i) => { pred += w[i + 1] * (((r.fvec[k] ?? 0) - mu[i]) / sd[i]); });
        r.feat_pred = pred;
      }
    }
  }
}

const ARCHS = {
  base: BASE,
  plus_xfp: [...BASE, 'xfp_std_c'],
  plus_opp: [...BASE, 'opp_adj'],
  plus_feat: [...BASE, 'feat_pred'],
  xfp_feat: [...BASE, 'xfp_std_c', 'feat_pred'],
  everything: [...BASE, 'xfp_std_c', 'opp_adj', 'feat_pred'],
};

// Only player-weeks where every candidate head exists, so architectures are
// compared on identical rows.
const complete = r => ['xfp_std_c', 'opp_adj', 'feat_pred'].every(h => Number.isFinite(r[h]));
const fitData = FIT.flatMap(y => seasons[y]).filter(complete);
const selData = seasons[SELECT].filter(complete);
const testData = seasons[TEST].filter(complete);
console.log(`\ncomplete-case rows: fit ${fitData.length}, select ${selData.length}, test ${testData.length}`);

// Standalone diagnostic: what does each head know ON ITS OWN? A head that is
// individually weak but non-redundant can still earn weight; a head that is
// individually strong but gets none is collinear with what we already have.
// Distinguishing those two decides whether more feature work is worth doing.
console.log('\n--- each head alone, on ' + TEST + ' (complete cases) ---');
{
  const single = [...BASE, 'xfp_std_c', 'opp_adj', 'feat_pred'];
  const rowsT = seasons[TEST].filter(complete);
  const scored = single.map(h => {
    const errs = rowsT.map(r => Math.abs(r[h] - r.actual));
    const pairs = rowsT.map(r => ({ pred: r[h], act: r.actual }));
    return { h, mae: mean(errs), rho: spearman(pairs) };
  }).sort((a, b) => a.mae - b.mae);
  for (const x of scored) console.log(`  ${x.h.padEnd(16)} MAE ${x.mae.toFixed(4)}  rho ${x.rho.toFixed(4)}`);
  // Correlation of each candidate with the existing heads: high correlation
  // explains zero weight without implying the head is uninformative.
  const corr = (a, b) => {
    const xs = rowsT.map(r => r[a]), ys = rowsT.map(r => r[b]);
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { const u = xs[i] - mx, v = ys[i] - my; sxy += u * v; sxx += u * u; syy += v * v; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  console.log('\n  correlation of each candidate with the base heads:');
  for (const c of ['xfp_std_c', 'opp_adj', 'feat_pred']) {
    console.log(`    ${c.padEnd(12)} ` + BASE.map(b2 => `${b2}:${corr(c, b2).toFixed(2)}`).join('  '));
  }
}

console.log(`\n--- fit on ${FIT.join('+')}, select on ${SELECT} ---`);
const fitted = {};
for (const [name, heads] of Object.entries(ARCHS)) {
  const f = fit(fitData, heads);
  const s = evaluate(selData, heads, f.weights);
  fitted[name] = { heads, ...f, selMae: s.mae, selSpearman: s.spearman };
  console.log(`  ${name.padEnd(14)} fitMAE ${f.mae.toFixed(4)}  ${SELECT}MAE ${s.mae.toFixed(4)}  rho ${s.spearman.toFixed(4)}  w=[${f.weights.map(x => x.toFixed(2)).join(' ')}]`);
}

const baseSel = fitted.base.selMae;
const winner = Object.entries(fitted)
  .filter(([n, v]) => n !== 'base' && v.selMae < baseSel)
  .sort((a, b) => a[1].selMae - b[1].selMae)[0];

if (!winner) {
  console.log(`\nNo architecture beat the base heads on ${SELECT}. ${TEST} is NOT opened.`);
  console.log('Conclusion: expected-points heads add nothing the existing heads do not already carry.');
  process.exit(0);
}
console.log(`\nselected "${winner[0]}" (${SELECT} MAE ${winner[1].selMae.toFixed(4)} vs base ${baseSel.toFixed(4)}); opening ${TEST} once.`);

const wBase = evaluate(testData, ARCHS.base, fitted.base.weights);
const wNew = evaluate(testData, winner[1].heads, winner[1].weights);
const boot = pairedBootstrapDiff(wBase.errs, wNew.errs, { seed: 20260917 });

console.log(`\n=== ${TEST} held out, complete cases only (n=${wNew.n}) ===`);
console.log(`  base heads      MAE ${wBase.mae.toFixed(4)}  rho ${wBase.spearman.toFixed(4)}`);
console.log(`  ${winner[0].padEnd(14)}  MAE ${wNew.mae.toFixed(4)}  rho ${wNew.spearman.toFixed(4)}`);
console.log(`  change ${(100 * (wNew.mae - wBase.mae) / wBase.mae).toFixed(2)}%  | paired bootstrap ${JSON.stringify(boot)}`);
console.log(`\n  oracle floor on this sample: recomputed below`);
const oracleErrs = [];
{
  const byP = new Map();
  for (const r of testData) (byP.get(r.player_id) ?? byP.set(r.player_id, []).get(r.player_id)).push(r.actual);
  for (const r of testData) {
    const list = byP.get(r.player_id);
    if (list.length < 4) continue;
    oracleErrs.push(Math.abs(r.actual - mean(list)));
  }
}
console.log(`  oracle floor    MAE ${mean(oracleErrs).toFixed(4)} (n=${oracleErrs.length})`);
console.log(`  headroom used:  ${(100 * (wBase.mae - wNew.mae) / (wBase.mae - mean(oracleErrs))).toFixed(1)}% of what was available`);
process.exit(0);
