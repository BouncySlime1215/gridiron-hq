/**
 * Summarize the opener-CLV measurement (passes 1 and 2) into one honest
 * table. Reads docs/evidence/2026-09-16/opener-clv/games-*.jsonl and
 * games-pass2-*.jsonl, grades EVERY forecaster from its raw margin with one
 * shared grader, and writes summary.json + summary.md beside them.
 *
 * WHAT IS REPORTED PER FORECASTER, per season and pooled 2022-2025 (2021 is
 * reported but never pooled -- its openers are not trustworthy, see pass 1):
 *
 *   clv_points        mean closing-line value in points, from the backed
 *                     side's perspective (clv-core's convention: + means the
 *                     close moved TOWARD our side, we got the better number).
 *                     This is THE target. It is continuous, so it resolves in
 *                     hundreds of games where win/loss needs thousands.
 *   se_clustered      standard error with games clustered by (season, week):
 *                     a Sunday slate shares one injury cycle and one market
 *                     state, so 14 games are closer to one observation than
 *                     fourteen. The naive SE is also shown, and the gap
 *                     between them is how much dependence the naive number
 *                     was spending as evidence.
 *   clv_direction     share of games where the line moved the way we leaned
 *                     (moves under half a point excluded: nothing to be right
 *                     about).
 *   ats_open          cover rate against the OPENING number -- what a bettor
 *                     actually faces. Break-even at -110 is 52.38%.
 *   by_abs_lean       the same three numbers in bins of |our lean| --
 *                     [0,1) [1,2) [2,3) [3,5) [5,inf). This is the selective-
 *                     bet question: a model with no average edge can still be
 *                     right when it disagrees hard, and a model that looks
 *                     good on average can be worthless exactly where you would
 *                     bet it.
 *
 * MULTIPLICITY. ~40 forecasters are graded. That is ~40 tests of "mean CLV
 * > 0", and one or two WILL clear p<0.05 by luck. Holm across the declared
 * family (every forecaster graded, pooled 2022-2025) is applied via
 * stats-util.js's `holm` -- the same correction FINAL ORDER #4 put on the
 * residual gate -- and both raw and corrected p are shown. Anything cited
 * from this table must cite the corrected column.
 *
 * CONTAMINATED forecasters are graded but flagged and EXCLUDED from the
 * corrected family: python_correction and the ensemble component
 * market_correction_research are handed the closing spread and the
 * opener-to-close move as inputs, so their "CLV" is the answer key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { signedClvPoints } from '../server/services/clv-core.js';
import { holm } from '../server/services/stats-util.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dir = arg('--dir', 'docs/evidence/2026-09-16/opener-clv');
const POOL = [2022, 2023, 2024, 2025];
const SEPARATE = [2021];
const CONTAMINATED = new Set(['python_correction', 'component:market_correction_research']);
const BINS = [[0, 1], [1, 2], [2, 3], [3, 5], [5, Infinity]];

const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);
const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Same grader as pass 1, applied uniformly to every forecaster's raw margin. */
function grade({ pred, openSpread, closeSpread, actualMargin }) {
  if (!Number.isFinite(pred)) return null;
  const openMargin = -openSpread, closeMargin = -closeSpread;
  const lean = pred - openMargin;
  if (Math.abs(lean) < 1e-9) return null;
  const backHome = lean > 0;
  const ourLine = backHome ? openSpread : -openSpread;
  const closeLine = backHome ? closeSpread : -closeSpread;
  const lineMove = closeMargin - openMargin;
  const push = actualMargin + openSpread === 0;
  return {
    abs_lean: Math.abs(lean),
    clv_points: signedClvPoints({ market: 'spread', ourLine, closeLine }),
    clv_direction: Math.abs(lineMove) < 0.5 ? null : (Math.sign(lean) === Math.sign(lineMove)),
    ats_open: push ? null : (backHome === (actualMargin + openSpread > 0))
  };
}

// ---- load and merge -----------------------------------------------------
const allSeasons = [...POOL, ...SEPARATE];
// forecaster id -> [{season, week, ...graded}]
const graded = new Map();
const add = (id, season, week, g) => {
  if (!g) return;
  if (!graded.has(id)) graded.set(id, []);
  graded.get(id).push({ season, week, ...g });
};
const coverage = {};
for (const season of allSeasons) {
  const p1 = readJsonl(path.join(dir, `games-${season}.jsonl`));
  const p2 = readJsonl(path.join(dir, `games-pass2-${season}.jsonl`));
  coverage[season] = { pass1_games: p1.length, pass2_games: p2.length };
  for (const row of p1) {
    const base = { openSpread: row.open_spread, closeSpread: row.close_spread, actualMargin: row.actual_margin };
    add('ensemble_raw_blend', season, row.week, grade({ pred: row.ensemble?.pred, ...base }));
    add('drive_sim', season, row.week, grade({ pred: row.sim?.pred, ...base }));
    for (const c of row.components ?? []) {
      add(`component:${c.id}`, season, row.week, grade({ pred: c.pred, ...base }));
    }
  }
  for (const row of p2) {
    const base = { openSpread: row.open_spread, closeSpread: row.close_spread, actualMargin: row.actual_margin };
    for (const [id, pred] of Object.entries(row.models ?? {})) add(id, season, row.week, grade({ pred, ...base }));
  }
}

// ---- statistics ----------------------------------------------------------
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = xs => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const normalSf2 = z => { // two-sided p from |z|
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * p);
};
const rate = (list, key) => {
  const g = list.filter(r => r[key] != null);
  const w = g.filter(r => r[key]).length;
  return g.length ? { n: g.length, rate: r4(w / g.length), se: r4(Math.sqrt(0.25 / g.length)) } : { n: 0, rate: null, se: null };
};

function stats(list) {
  const pts = list.map(r => r.clv_points).filter(Number.isFinite);
  const m = mean(pts), s = sd(pts);
  const seNaive = s != null ? s / Math.sqrt(pts.length) : null;
  // week-clustered: one observation per (season, week)
  const clusters = new Map();
  for (const r of list) {
    if (!Number.isFinite(r.clv_points)) continue;
    const k = `${r.season}|${r.week}`;
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(r.clv_points);
  }
  const cm = [...clusters.values()].map(mean);
  const seCl = cm.length > 1 ? sd(cm) / Math.sqrt(cm.length) : null;
  const zCl = seCl ? m / seCl : null;
  return {
    n: pts.length, weeks: cm.length,
    clv_points: { mean: r3(m), se_naive: r3(seNaive), se_clustered: r3(seCl),
      z_clustered: r2(zCl), p_clustered: zCl == null ? null : r4(normalSf2(zCl)) },
    clv_direction: rate(list, 'clv_direction'),
    ats_open: rate(list, 'ats_open')
  };
}

function byBins(list) {
  return BINS.map(([lo, hi]) => {
    const sub = list.filter(r => r.abs_lean >= lo && r.abs_lean < hi);
    return { bin: `[${lo},${hi === Infinity ? 'inf' : hi})`, ...stats(sub) };
  });
}

const forecasters = [...graded.keys()].sort();
const summary = { generated_for: dir, coverage, pooled_seasons: POOL, separate_seasons: SEPARATE,
  contaminated: [...CONTAMINATED], forecasters: {} };
for (const id of forecasters) {
  const all = graded.get(id);
  const pooled = all.filter(r => POOL.includes(r.season));
  summary.forecasters[id] = {
    contaminated: CONTAMINATED.has(id),
    pooled_2022_2025: { ...stats(pooled), by_abs_lean: byBins(pooled) },
    by_season: Object.fromEntries(allSeasons.map(s => [s, stats(all.filter(r => r.season === s))]))
  };
}

// ---- multiplicity across the honest family ------------------------------
const family = forecasters.filter(id => !CONTAMINATED.has(id)
  && summary.forecasters[id].pooled_2022_2025.clv_points.p_clustered != null);
const rawP = family.map(id => summary.forecasters[id].pooled_2022_2025.clv_points.p_clustered);
const adj = holm(rawP);
family.forEach((id, i) => { summary.forecasters[id].pooled_2022_2025.clv_points.p_holm = r4(adj[i]); });
summary.multiplicity = { method: 'holm', family_size: family.length,
  raw_passes_p05: rawP.filter(p => p < 0.05).length,
  holm_passes_p05: adj.filter(p => p < 0.05).length,
  positive_mean_and_holm_p05: family.filter((id, i) => adj[i] < 0.05
    && summary.forecasters[id].pooled_2022_2025.clv_points.mean > 0) };

fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));

// ---- markdown -------------------------------------------------------------
const rowsMd = forecasters.map(id => {
  const p = summary.forecasters[id].pooled_2022_2025;
  const c = p.clv_points;
  return `| ${summary.forecasters[id].contaminated ? '~~' + id + '~~ (contaminated)' : id} | ${p.n} | ${c.mean ?? ''} | ${c.se_clustered ?? ''} | ${c.z_clustered ?? ''} | ${c.p_clustered ?? ''} | ${c.p_holm ?? '—'} | ${p.clv_direction.rate ?? ''} | ${p.ats_open.rate ?? ''} |`;
}).sort((a, b) => {
  const za = parseFloat(a.split('|')[5]) || -99, zb = parseFloat(b.split('|')[5]) || -99;
  return zb - za;
});
const md = [
  `# Opener CLV — every forecaster, pooled 2022-2025`,
  '', `Generated from ${dir}. 2021 is excluded from pooling (untrustworthy openers) and reported per-season in summary.json.`,
  '', `Honest family for Holm: ${summary.multiplicity.family_size} forecasters. Raw p<0.05: ${summary.multiplicity.raw_passes_p05}. Holm p<0.05: ${summary.multiplicity.holm_passes_p05}. Positive mean AND Holm p<0.05: ${JSON.stringify(summary.multiplicity.positive_mean_and_holm_p05)}.`,
  '', `Break-even ATS at -110 is 0.5238. Sorted by week-clustered z on mean CLV points.`,
  '', `| forecaster | n | mean CLV pts | SE (wk-clustered) | z | p | p (Holm) | CLV direction | ATS vs open |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...rowsMd, ''
].join('\n');
fs.writeFileSync(path.join(dir, 'summary.md'), md);
console.log(md);
console.log(JSON.stringify(summary.multiplicity, null, 1));
console.log('coverage', JSON.stringify(coverage));
