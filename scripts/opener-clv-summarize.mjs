/**
 * Summarize the opener-CLV measurement (passes 1 and 2) into one honest
 * table. RUN WITH A SCRATCH GRIDIRON_DB_PATH (see the guard below); it
 * needs no data from any database. Reads docs/evidence/2026-09-16/opener-clv/games-*.jsonl and
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
// GUARD (added after this script's first run crashed with "no such column:
// spec_hash"): clv-core.js imports server/db/index.js, which OPENS AND
// MIGRATES whatever GRIDIRON_DB_PATH points at -- and when it is unset, that
// is the app's own server/data.sqlite. A summarizer must never touch a
// production database as a side effect of importing a 3-line formula.
// Refuse to run without an explicit path; the README example uses a scratch
// file. (RUNBOOK §0a rule 1 exists for exactly this.)
if (!process.env.GRIDIRON_DB_PATH) {
  console.error('refusing to run: set GRIDIRON_DB_PATH to a scratch path, e.g. '
    + 'GRIDIRON_DB_PATH=$(mktemp -u /tmp/gridiron-summ-XXXXXX).sqlite SCHEDULER_DISABLED=1 node scripts/opener-clv-summarize.mjs');
  process.exit(2);
}
import { signedClvPoints } from '../server/services/clv-core.js';
import { holm } from '../server/services/stats-util.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dir = arg('--dir', 'docs/evidence/2026-09-16/opener-clv');
const POOL = arg('--pool', '2022,2023,2024,2025').split(',').map(Number);   // e.g. --pool 2022,2023,2024 for the conservative table
const SEPARATE = [2021];
const CONTAMINATED = new Set(['python_correction', 'component:market_correction_research']);

/**
 * INPUT TIMING (the amendment to the preregistration, 2026-09-16): what
 * information a forecaster used, relative to the OPENER it is graded against.
 * Classified from each component's inputs (server/services/nfl-ensemble.js
 * MODELS, verified by reading predict()) BEFORE full results were seen.
 *
 *   prior_week      results / team features through week N-1, schedule, rest.
 *                   Knowable when the opener was posted -> opener-CLV here IS
 *                   a claim about mispricing at the open. EDGE-ELIGIBLE.
 *   in_week         injury reports (nfl_injuries), depth charts captured
 *                   during the week (nfl_depth), game-day temp/wind. The
 *                   opener could not know these; the close did. Opener-CLV
 *                   here is "line-move prediction", not edge at the open.
 *   third_party_bulk a retroactive backfill of a third party's history whose
 *                   every row shares ONE fetched_at (nfl_nfelo_games: 1,725
 *                   rows, one timestamp, 2026-09-16; teamrankings likewise).
 *                   The values are nominally pre-game but cannot be proven
 *                   point-in-time by our own clock, and the provider's model
 *                   parameters were fit on the full history. Reported in its
 *                   own tier, never cited as edge without an independent
 *                   as-of source.
 *   opener          the opener itself (market_anchor/market_regression under
 *                   the override). Zero lean by construction; graded for
 *                   completeness only.
 */
const INPUT_TIMING = {
  ensemble_raw_blend: 'mixed', drive_sim: 'prior_week',
  python_football: 'prior_week', python_unified: 'prior_week', python_correction: 'contaminated',
  lineup_roster: 'in_week',
  'component:availability': 'in_week', 'component:roster_strength': 'in_week',
  'component:weather_total': 'in_week',
  'component:nfelo_rating': 'third_party_bulk', 'component:nfelo_qb_adjustment': 'third_party_bulk',
  'component:teamrankings_predictive': 'third_party_bulk',
  'component:market_anchor': 'opener', 'component:market_regression': 'opener',
  'component:market_correction_research': 'contaminated'
};
const timingOf = id => INPUT_TIMING[id] ?? (id.startsWith('baseline:') ? 'baseline' : id.startsWith('component:') ? 'prior_week' : 'unknown');
const EDGE_ELIGIBLE = new Set(['prior_week']);
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
    abs_lean: Math.abs(lean), back_home: backHome,
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

// ---- home drift, adjusted CLV, and zero-information baselines -------------
// MEASURED 2022-2025: the line moves toward the HOME team by ~+0.185 points
// between open and close, so "always back home at the opener" earns CLV with
// zero skill. clv_home_adjusted = CLV minus the drift the backed SIDE would
// have earned anyway (+mu if home, -mu if away) -- the excess over "always
// back this side". Backing the opener favourite/underdog earns ~0, so there
// is no favourite drift to net out. Both are reported as baseline rows.
const pooledGames = [];
for (const season of POOL) for (const row of readJsonl(path.join(dir, `games-${season}.jsonl`))) pooledGames.push({ season, ...row });
const MU_HOME = mean(pooledGames.map(g => (-g.close_spread) - (-g.open_spread))) ?? 0;
for (const list of graded.values()) for (const r of list) {
  if (POOL.includes(r.season) && Number.isFinite(r.clv_points)) r.clv_home_adjusted = r.clv_points - (r.back_home ? MU_HOME : -MU_HOME);
}
const baseline = (id, chooseHome) => {
  for (const g of pooledGames) {
    const bh = chooseHome(g); if (bh == null) continue;
    const pred = bh ? (-g.open_spread) + 1 : (-g.open_spread) - 1;   // a forced 1-point lean to the chosen side
    add(id, g.season, g.week, grade({ pred, openSpread: g.open_spread, closeSpread: g.close_spread, actualMargin: g.actual_margin }));
  }
  for (const r of graded.get(id) ?? []) r.clv_home_adjusted = r.clv_points - (r.back_home ? MU_HOME : -MU_HOME);
};
baseline('baseline:back_home', () => true);
baseline('baseline:back_away', () => false);
baseline('baseline:back_opener_favorite', g => (g.open_spread === 0 ? null : g.open_spread < 0));
baseline('baseline:back_opener_underdog', g => (g.open_spread === 0 ? null : g.open_spread > 0));


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
  const adjClusters = new Map();
  const adjPts = list.map(r => r.clv_home_adjusted).filter(Number.isFinite);
  for (const r of list) {
    if (!Number.isFinite(r.clv_home_adjusted)) continue;
    const k = `${r.season}|${r.week}`;
    if (!adjClusters.has(k)) adjClusters.set(k, []);
    adjClusters.get(k).push(r.clv_home_adjusted);
  }
  const acm = [...adjClusters.values()].map(mean);
  const aSe = acm.length > 1 ? sd(acm) / Math.sqrt(acm.length) : null;
  const aM = mean(adjPts), aZ = aSe ? aM / aSe : null;
  const homeBacked = list.filter(r => r.back_home === true && Number.isFinite(r.clv_points)).map(r => r.clv_points);
  const awayBacked = list.filter(r => r.back_home === false && Number.isFinite(r.clv_points)).map(r => r.clv_points);
  return {
    n: pts.length, weeks: cm.length,
    clv_points: { mean: r3(m), se_naive: r3(seNaive), se_clustered: r3(seCl),
      z_clustered: r2(zCl), p_clustered: zCl == null ? null : r4(normalSf2(zCl)) },
    clv_home_adjusted: { mean: r3(aM), se_clustered: r3(aSe), z_clustered: r2(aZ),
      p_clustered: aZ == null ? null : r4(normalSf2(aZ)) },
    side_split: { home_share: r3(homeBacked.length / Math.max(1, homeBacked.length + awayBacked.length)),
      clv_when_backing_home: r3(mean(homeBacked)), clv_when_backing_away: r3(mean(awayBacked)) },
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
    input_timing: timingOf(id),
    pooled_2022_2025: { ...stats(pooled), by_abs_lean: byBins(pooled) },
    by_season: Object.fromEntries(allSeasons.map(s => [s, stats(all.filter(r => r.season === s))]))
  };
}

// ---- multiplicity across the honest family ------------------------------
// The declared family for the EDGE claim is the edge-eligible tier only
// (prior_week inputs, our own clock). Everything else is reported but is not
// a candidate for "edge at the opener", so it is not in this family.
const family = forecasters.filter(id => !CONTAMINATED.has(id)
  && EDGE_ELIGIBLE.has(timingOf(id))
  && summary.forecasters[id].pooled_2022_2025.clv_points.p_clustered != null);
const rawP = family.map(id => summary.forecasters[id].pooled_2022_2025.clv_home_adjusted.p_clustered);
const adj = holm(rawP);
family.forEach((id, i) => { summary.forecasters[id].pooled_2022_2025.clv_home_adjusted.p_holm = r4(adj[i]); });
summary.home_drift_points_open_to_close = r3(MU_HOME);
summary.multiplicity = { method: 'holm', family_size: family.length,
  raw_passes_p05: rawP.filter(p => p < 0.05).length,
  holm_passes_p05: adj.filter(p => p < 0.05).length,
  positive_mean_and_holm_p05: family.filter((id, i) => adj[i] < 0.05
    && summary.forecasters[id].pooled_2022_2025.clv_home_adjusted.mean > 0),
  note: 'p-values and Holm are on clv_HOME_ADJUSTED (excess over always-back-this-side); baselines excluded from the family' };

const suffix = POOL.join('-') === '2022-2023-2024-2025' ? '' : `-${POOL.join('-')}`;
fs.writeFileSync(path.join(dir, `summary${suffix}.json`), JSON.stringify(summary, null, 1));

// ---- markdown -------------------------------------------------------------
const rowsMd = forecasters.map(id => {
  const p = summary.forecasters[id].pooled_2022_2025;
  const c = p.clv_points;
  const t = summary.forecasters[id].input_timing, a = p.clv_home_adjusted, ss = p.side_split;
  return `| ${summary.forecasters[id].contaminated ? '~~' + id + '~~' : id} | ${t} | ${p.n} | ${c.mean ?? ''} | ${a.mean ?? ''} | ${a.se_clustered ?? ''} | ${a.z_clustered ?? ''} | ${a.p_holm ?? '—'} | ${ss.home_share ?? ''} | ${ss.clv_when_backing_away ?? ''} | ${p.ats_open.rate ?? ''} |`;
}).sort((a, b) => {
  const za = parseFloat(a.split('|')[6]) || -99, zb = parseFloat(b.split('|')[6]) || -99;
  return zb - za;
});
const md = [
  `# Opener CLV — every forecaster, pooled ${POOL.join('-')}`,
  '', `Generated from ${dir}. 2021 is excluded from pooling (untrustworthy openers) and reported per-season in summary.json.`,
  '', `Holm family = EDGE-ELIGIBLE tier only (input_timing = prior_week; see INPUT_TIMING in the script): ${summary.multiplicity.family_size} forecasters. Raw p<0.05: ${summary.multiplicity.raw_passes_p05}. Holm p<0.05: ${summary.multiplicity.holm_passes_p05}. Positive mean AND Holm p<0.05: ${JSON.stringify(summary.multiplicity.positive_mean_and_holm_p05)}.`,
  '', `Break-even ATS at -110 is 0.5238. Sorted by week-clustered z on mean CLV points.`,
  '', `Only prior_week rows may be read as edge at the opener. in_week = line-move prediction (opener could not know it). third_party_bulk = single-timestamp backfill, clock unverifiable. Struck-through = contaminated by the close.`,
  '', `Home drift (mean open->close move toward home) = ${summary.home_drift_points_open_to_close} pts. "adj CLV" nets out what always-backing-that-side would have earned. "away CLV" is the acid test: positive means the model beats a drift that runs against it.`,
  '', `| forecaster | input timing | n | raw CLV | adj CLV | SE | z (adj) | p Holm (adj) | home share | away CLV | ATS vs open |`,
  `|---|---|---|---|---|---|---|---|---|---|---|`,
  ...rowsMd, ''
].join('\n');
fs.writeFileSync(path.join(dir, `summary${suffix}.md`), md);
console.log(md);
console.log(JSON.stringify(summary.multiplicity, null, 1));
console.log('coverage', JSON.stringify(coverage));
