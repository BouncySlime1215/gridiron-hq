#!/usr/bin/env node
/**
 * Posture calibration: is the matchup win probability in lineup-posture.js honest?
 *
 * lineupPosture prints P(win) = Phi(edge / sqrt(sA^2 + sB^2)). For that to be an
 * honest probability, sA and sB have to describe the spread of (actual lineup total
 * - projected lineup total), because that is what decides whether a projected edge
 * holds up on Sunday. The spread of raw scores is a different quantity. This script
 * measures the right one, walk-forward, and fits the scale on it.
 *
 * CALIBRATION SET. The weekly harness (weekly-backtest.js#replaySeasonWeekly) with the
 * live ensemble head, 2023-2025 weeks 5-17. Its _decision_rows are the players who
 * were active the week before, graded with a zero when they then did not play: the
 * same set a manager decides on, with the did-not-play risk inside the error. Each
 * row is priced as production prices a starter (trade-engine.js#buildAssetUniverse):
 *   mean   = prediction x active probability (contingency.js#weeklyAvailability)
 *   spread = (p90 - p10) / 2.56 of the player's weekly distribution, sampled with that
 *            active probability (player-week-engine.js#playerWeekDistribution)
 * The one production input the harness cannot reproduce is the matchup multiplier;
 * it is 1 here. Every week, 100 synthetic 10-team leagues are dealt from the
 * plausible starters (top 14 QB, 34 RB, 40 WR, 14 TE by mean), each team starting
 * QB, 2 RB, 2 WR, TE, FLEX, and paired into 5 head-to-head matchups graded on the
 * actual totals.
 *
 * GATE. Pre-registered before any fit (text below, repeated in the run's result
 * file). Fit on 2023+2024 by Bernoulli log-likelihood; select the spread model by
 * leave-one-season-out log loss inside the fit seasons; validate on 2025 once. Ships
 * only if the 2025 log loss AND the 10-bin expected calibration error both beat the
 * current rule (distribution spread x 1.9) and the log-loss gain survives a
 * week-clustered paired bootstrap (90% CI excludes 0).
 *
 * Usage (never against the live file; point GRIDIRON_DB_PATH at a copy):
 *   GRIDIRON_DB_PATH=/path/copy.sqlite node scripts/fit-posture-calibration.mjs \
 *     --dataset /path/posture-dataset.json [--rebuild] [--fit-only] [--out /path/result.json]
 *     [--center-fit 1]
 *
 *   --dataset   where the calibration rows are cached (built on first run, ~1 min)
 *   --rebuild   rebuild the rows even if the cache exists
 *   --center-fit  the weekly ensemble fit the replay is centred on, by id (default 1,
 *               the fit-1 head GATE names). It used to be whatever
 *               activeWeeklyWeightSet({2026, week 3}) returned on the day.
 *
 * The cached dataset records the centre fit and the availability fit it was built with
 * (contingency.js#availabilityFitStamp: rows and fitted_at of both rate tables). A
 * cache built under different ones is refused; pass --rebuild. SPREAD_SCALE absorbs
 * the noise the availability discount adds to the edge (lineup-posture.js), so a
 * refit of availability — the play-chance role layer — needs a re-run of this script.
 *   --fit-only  fit and select on 2023+2024 and stop; 2025 is not read
 *   --out       write the full result (fits, gate, reliability tables) as JSON
 */
process.env.SCHEDULER_DISABLED = '1';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GATE = `
Calibration set: replaySeasonWeekly(season, {startWeek 5, endWeek 17, distributions false,
roleRecency WEEKLY_ROLE_RECENCY, predictionHead = live fit-1 ensemble}), seasons 2023-2025.
Rows = _decision_rows (active last week; 0 if DNP), bye-week rows dropped. mean = prediction x
active probability; spread from sampleWeeks(params, 2000, PPR, 1, a) + ensemble shift, (p90-p10)/2.56.
Pools top 14 QB / 34 RB / 40 WR / 14 TE by mean; 100 seeded 10-team leagues per week, lineup
QB RB RB WR WR TE FLEX, 5 matchups per league; win = actual_A > actual_B, ties dropped.
Models: B0 current = distribution x 1.9; B1 = DEFAULT_CV x 1.9 (reported); C1 distribution x k;
C2 DEFAULT_CV x k; C3 per-position CV (4 params).
Fit by Bernoulli log-likelihood on 2023+2024; choose among C1-C3 by leave-one-season-out log
loss within 2023/2024; refit winner on 2023+2024; round parameters to 2 decimals (what ships).
SHIP only if on 2025 (evaluated once): (1) log loss(winner) < log loss(B0); (2) ECE(10 equal-width
bins) winner < B0; (3) pairedBootstrapDiff(ll_B0, ll_winner, {seed 20260917, iterations 2000,
groups season-week}) 90% CI entirely below 0. Otherwise ship nothing.
Reported, not gated: 2025 reliability tables; 2025 weeks 2-4 diagnostic; implied team-week SD vs
league_week_scores and vs the empirical SD of (actual - projected) lineup totals.`;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

const DATASET = opt('--dataset', path.join(os.tmpdir(), 'posture-calibration-dataset.json'));
const CENTER_FIT = Number(opt('--center-fit', '1'));
const OUT = opt('--out', null);
const FIT_SEASONS = [2023, 2024];
const VALIDATION_SEASON = 2025;
const MAIN_WEEKS = [5, 17];
const EARLY_WEEKS = [2, 4];                  // diagnostic only, validation season only
const POOL = { QB: 14, RB: 34, WR: 40, TE: 14 };
const TEAMS = 10, LEAGUES_PER_WEEK = 100, SEED = 20260917;
const RUNS = 2000;                           // playerWeekDistribution's own default
// The weekly shock B0's distributions were drawn with at HEAD 9a7a809 (projections.js
// WEEKLY_LEVEL then: sigma 0.45, downMult 1, not mean-preserving). Pinned: WEEKLY_LEVEL was
// refit afterwards (2026-09-18, spreads ~12% narrower), and an unpinned --rebuild silently
// turned B0 into a different rule (2025 log loss 0.6712 -> 0.6694 on the verifier's deal).
// The shipped rule (POSITION_CV x SPREAD_SCALE) never reads the distribution.
const HEAD_WEEKLY_LEVEL = { sigma: 0.45, downMult: 1, meanPreserving: false };

// The rule as it stood at HEAD 9a7a809, hard-coded so that re-running this script
// after lineup-posture.js changes still compares against what used to ship.
const BASELINE_SCALE = 1.9;
const DEFAULT_CV = { QB: 0.40, RB: 0.57, WR: 0.63, TE: 0.67 };
const POS = ['QB', 'RB', 'WR', 'TE'];

/* ------------------------------------------------------------------ helpers */

function hashSeed(...parts) {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Standard normal CDF, the same approximation lineup-posture.js uses. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const r4 = x => +x.toFixed(4);

/* ------------------------------------------------------------ calibration rows */

async function buildDataset() {
  const { rows } = await import('../server/db/index.js');
  const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
  const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } = await import('../server/services/weekly-ensemble.js');
  const { weeklyWeightSetById } = await import('../server/services/weekly-weight-store.js');
  const { buildProjections, sampleWeeks } = await import('../server/services/projections.js');
  const { weeklyAvailability } = await import('../server/services/contingency.js');
  const { PPR } = await import('../server/services/scoring.js');
  const { percentiles, withRandomSeed } = await import('../server/services/stats-util.js');

  // The live head. NOTE: fit-1 was trained through 2025 W18, so for 2025 the point
  // predictions are in-sample for the ensemble WEIGHTS (a handful of numbers over
  // 13k rows). That can only make 2025 errors look slightly smaller, i.e. it biases
  // the validation toward a narrower spread, not a wider one.
  // Pinned by id (--center-fit): the replays are weeks 5-17 and 2-4, and a later fit
  // with an early-week block would silently change the centre of the 2-4 diagnostic.
  const ws = weeklyWeightSetById(CENTER_FIT);
  const audit = { weight_set: ws.id, blocks: [] };
  const out = [];

  const block = (season, [startWeek, endWeek], phase) => {
    const t0 = Date.now();
    const r = replaySeasonWeekly(season, {
      startWeek, endWeek, distributions: false, runs: 300,
      roleRecency: WEEKLY_ROLE_RECENCY,
      predictionHead: ctx => weeklyEnsemblePrediction(ctx, ws.weights)
    });
    const structural = new Map(r._predictions.map(p => [`${p.player_id}|${p.week}`, p.structural]));
    const usage = rows('SELECT player_id, week, team FROM player_week_usage WHERE season = ?', season);
    const teamOf = new Map(usage.map(u => [`${u.player_id}|${u.week}`, u.team]));
    const playing = new Map();
    for (const u of usage) {
      if (!u.team) continue;
      if (!playing.has(u.week)) playing.set(u.week, new Set());
      playing.get(u.week).add(u.team);
    }
    const a = { season, phase, weeks: `${startWeek}-${endWeek}`, decision_rows: r._decision_rows.length,
      point_mae: r.point.model.mae, dnp_incl_mae: r.decision_including_dnp.model.mae,
      bye_dropped: 0, bye_dropped_but_played: 0, no_team: 0, pooled: 0, pooled_dnp: 0,
      structural_checked: 0, structural_mismatch: 0, short_pools: [] };

    for (let week = startWeek; week <= endWeek; week++) {
      const avail = weeklyAvailability(season, week, { through: season - 1 });
      const cands = [];
      for (const d of r._decision_rows) {
        if (d.week !== week || !POOL[d.position]) continue;
        const team = teamOf.get(`${d.player_id}|${week - 1}`);
        if (!team) { a.no_team++; continue; }
        if (!playing.get(week)?.has(team)) {       // bye: production projects 0, never starts him
          a.bye_dropped++; if (d.played) a.bye_dropped_but_played++;
          continue;
        }
        const ap = avail.get(d.player_id)?.active_probability ?? 0.92;
        cands.push({ ...d, a: ap, mean: d.prediction * ap });
      }
      const proj = buildProjections({ through: season, throughWeek: week - 1, scoring: PPR,
        roleRecency: WEEKLY_ROLE_RECENCY });
      for (const pos of POS) {
        const pool = cands.filter(c => c.position === pos).sort((x, y) => y.mean - x.mean).slice(0, POOL[pos]);
        if (pool.length < POOL[pos]) a.short_pools.push(`${season}-W${week} ${pos} ${pool.length}`);
        for (const c of pool) {
          const p = proj.get(c.player_id);
          if (!p?.params) throw new Error(`no projection params for ${c.player_id} ${season}-W${week}`);
          const s = structural.get(`${c.player_id}|${week}`);
          if (s != null) {
            if (Math.abs(s - p.ppg) > 1e-9) a.structural_mismatch++; else a.structural_checked++;
          }
          const shift = c.prediction - p.ppg;
          const samples = withRandomSeed(hashSeed(season, week, c.player_id),
            () => sampleWeeks(p.params, RUNS, PPR, 1, c.a, HEAD_WEEKLY_LEVEL)).map(v => Math.max(0, v + shift));
          const pct = percentiles(samples, [0.1, 0.9]);
          out.push({ season, week, phase, pid: c.player_id, pos, pred: +c.prediction.toFixed(4), a: c.a,
            mean: +c.mean.toFixed(4), p10: pct.p10, p90: pct.p90, actual: c.actual, played: c.played ? 1 : 0 });
          a.pooled++; if (!c.played) a.pooled_dnp++;
        }
      }
    }
    a.seconds = Math.round((Date.now() - t0) / 1000);
    audit.blocks.push(a);
    console.log(JSON.stringify(a));
  };

  for (const season of [...FIT_SEASONS, VALIDATION_SEASON]) block(season, MAIN_WEEKS, 'main');
  block(VALIDATION_SEASON, EARLY_WEEKS, 'early');
  return { built_at: new Date().toISOString(), versions: await datasetVersions(), audit, rows: out };
}

/** What a cached dataset was built with; a mismatch means it prices a different model. */
async function datasetVersions() {
  const { weeklyWeightSetById } = await import('../server/services/weekly-weight-store.js');
  const { availabilityFitStamp } = await import('../server/services/contingency.js');
  const ws = weeklyWeightSetById(CENTER_FIT);
  return { weight_set: ws.id, weight_set_data_hash: ws.data_hash, availability: availabilityFitStamp() };
}

/* --------------------------------------------------------- synthetic matchups */

function summarizeLineup(players) {
  let m = 0, act = 0, vDist = 0, fallback = 0;
  const S = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of players) {
    act += p.actual;
    if (!(p.mean > 0)) continue;               // production: zero projection, zero variance
    m += p.mean;
    S[p.pos] += p.mean * p.mean;
    // Production's rule exactly: the distribution spread when it has width, else the
    // positional CV. (The fallback essentially never fires for a plausible starter.)
    if (p.p90 > p.p10) vDist += ((p.p90 - p.p10) / 2.56) ** 2;
    else { vDist += (p.mean * DEFAULT_CV[p.pos]) ** 2; fallback++; }
  }
  return { mean: m, actual: act, vDist, S, fallback };
}

async function synthesize(data) {
  const { random, withRandomSeed } = await import('../server/services/stats-util.js');
  const shuffle = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const byWeek = new Map();
  for (const r of data.rows) {
    const k = `${r.phase}|${r.season}|${r.week}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(r);
  }
  const matchups = [], lineups = [];
  let ties = 0, fallback = 0;
  for (const [key, rs] of byWeek) {
    const [phase, season, week] = key.split('|');
    const pools = Object.fromEntries(POS.map(pos => [pos, rs.filter(r => r.pos === pos)]));
    if (pools.QB.length < TEAMS || pools.TE.length < TEAMS || pools.RB.length < 2 * TEAMS || pools.WR.length < 2 * TEAMS) {
      console.log('skipping thin week', key); continue;
    }
    withRandomSeed(hashSeed(SEED, key), () => {
      for (let L = 0; L < LEAGUES_PER_WEEK; L++) {
        const qb = shuffle(pools.QB), rb = shuffle(pools.RB), wr = shuffle(pools.WR), te = shuffle(pools.TE);
        const flex = shuffle([...rb.slice(2 * TEAMS), ...wr.slice(2 * TEAMS), ...te.slice(TEAMS)]);
        const teams = [];
        for (let t = 0; t < TEAMS; t++) {
          const lu = summarizeLineup([qb[t], rb[2 * t], rb[2 * t + 1], wr[2 * t], wr[2 * t + 1], te[t], flex[t]]);
          fallback += lu.fallback;
          teams.push(lu);
          lineups.push({ phase, season: +season, week: +week, mean: lu.mean, actual: lu.actual, vDist: lu.vDist,
            vCv: POS.reduce((s, pos) => s + DEFAULT_CV[pos] ** 2 * lu.S[pos], 0) });
        }
        for (let m = 0; m < TEAMS / 2; m++) {
          const A = teams[2 * m], B = teams[2 * m + 1];
          if (A.actual === B.actual) { ties++; continue; }
          matchups.push({
            phase, season: +season, week: +week, group: `${season}-${week}`,
            edge: A.mean - B.mean, margin: A.actual - B.actual, y: A.actual > B.actual ? 1 : 0,
            vDist: A.vDist + B.vDist,
            S: POS.map(pos => A.S[pos] + B.S[pos])
          });
        }
      }
    });
  }
  return { matchups, lineups, ties, fallback };
}

/* ------------------------------------------------------------------- models */

const MODELS = {
  // lineup SD = k x sqrt(sum of distribution variances)
  dist: { params: ['k'], sd: (p, m) => p.k * Math.sqrt(m.vDist) },
  // lineup SD = k x sqrt(sum (mean x DEFAULT_CV)^2)
  cv: { params: ['k'], sd: (p, m) => p.k * Math.sqrt(POS.reduce((s, pos, i) => s + DEFAULT_CV[pos] ** 2 * m.S[i], 0)) },
  // lineup SD = sqrt(sum (mean x CV_pos)^2), CV per position fitted
  cvpos: { params: POS, sd: (p, m) => Math.sqrt(POS.reduce((s, pos, i) => s + p[pos] ** 2 * m.S[i], 0)) }
};

const probOf = (model, params, m) => {
  const s = MODELS[model].sd(params, m);
  return s > 0 ? normalCdf(m.edge / s) : (m.edge > 0 ? 1 : m.edge < 0 ? 0 : 0.5);
};
const EPS = 1e-9;
const lossOf = (p, y) => { const q = Math.min(1 - EPS, Math.max(EPS, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };
const logLoss = (model, params, ms) => mean(ms.map(m => lossOf(probOf(model, params, m), m.y)));

/** Golden-section minimisation on log(x) in [lo, hi]. */
function golden(f, lo = Math.log(0.05), hi = Math.log(5), tol = 1e-7) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  while (b - a > tol) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

function fit(model, ms) {
  if (model === 'cvpos') {
    // Coordinate descent in log space, started from DEFAULT_CV x the fitted cv scale.
    const k = Math.exp(golden(x => logLoss('cv', { k: Math.exp(x) }, ms)));
    const p = Object.fromEntries(POS.map(pos => [pos, DEFAULT_CV[pos] * k]));
    let prev = logLoss('cvpos', p, ms);
    for (let sweep = 0; sweep < 40; sweep++) {
      for (const pos of POS) p[pos] = Math.exp(golden(x => logLoss('cvpos', { ...p, [pos]: Math.exp(x) }, ms)));
      const cur = logLoss('cvpos', p, ms);
      if (prev - cur < 1e-10) break;
      prev = cur;
    }
    return p;
  }
  return { k: Math.exp(golden(x => logLoss(model, { k: Math.exp(x) }, ms))) };
}

const round2 = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +v.toFixed(2)]));

/* ------------------------------------------------------------- calibration */

function reliability(model, params, ms) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: 0, pred: 0, won: 0 }));
  for (const m of ms) {
    const p = probOf(model, params, m);
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.pred += p; b.won += m.y;
  }
  let ece = 0;
  const N = ms.length;
  const table = bins.map(b => {
    if (b.n) ece += (b.n / N) * Math.abs(b.pred / b.n - b.won / b.n);
    return { bin: b.bin, n: b.n, mean_predicted: b.n ? +(b.pred / b.n).toFixed(3) : null,
      actual_win_rate: b.n ? +(b.won / b.n).toFixed(3) : null };
  });
  return { ece: r4(ece), table };
}

function evaluate(model, params, ms) {
  const probs = ms.map(m => probOf(model, params, m));
  return {
    model, params,
    log_loss: r4(mean(ms.map((m, i) => lossOf(probs[i], m.y)))),
    brier: r4(mean(ms.map((m, i) => (probs[i] - m.y) ** 2))),
    ...reliability(model, params, ms),
    n: ms.length
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  // Every path opens the database (the rebuild, the code check, the league_week_scores
  // cross-check), and opening it can apply pending migrations. Never the live file.
  if (!process.env.GRIDIRON_DB_PATH) {
    throw new Error('Refusing to open the live database: set GRIDIRON_DB_PATH to a copy.');
  }
  let data;
  if (!flag('--rebuild') && existsSync(DATASET)) {
    data = JSON.parse(readFileSync(DATASET, 'utf8'));
    const now = await datasetVersions();
    if (JSON.stringify(data.versions ?? null) !== JSON.stringify(now)) {
      console.error(`Refusing the cached dataset ${DATASET}: it was built with ${JSON.stringify(data.versions ?? 'no recorded versions')}, ` +
        `this database has ${JSON.stringify(now)}. Re-run with --rebuild.`);
      process.exit(2);
    }
    console.log(`loaded ${data.rows.length} calibration rows from ${DATASET} (built ${data.built_at})`);
  } else {
    data = await buildDataset();
    writeFileSync(DATASET, JSON.stringify(data));
    console.log(`wrote ${data.rows.length} calibration rows to ${DATASET}`);
  }

  const { matchups, lineups, ties, fallback } = await synthesize(data);
  const mainSet = matchups.filter(m => m.phase === 'main');
  const fitSet = mainSet.filter(m => FIT_SEASONS.includes(m.season));
  console.log(`matchups: ${matchups.length} (ties dropped ${ties}; CV fallback player-slots ${fallback}); fit ${fitSet.length}`);

  const result = { gate: GATE, dataset: DATASET, versions: data.versions, audit: data.audit, counts: { ties, fallback }, fit: {} };

  // 1. Baselines and candidates on the fit seasons.
  const B0 = { model: 'dist', params: { k: BASELINE_SCALE } };
  const B1 = { model: 'cv', params: { k: BASELINE_SCALE } };
  result.fit.baselines_in_fit = {
    B0: logLoss('dist', B0.params, fitSet), B1: logLoss('cv', B1.params, fitSet)
  };

  // 2. Selection by leave-one-season-out log loss inside the fit seasons.
  const candidates = { C1: 'dist', C2: 'cv', C3: 'cvpos' };
  const loso = {};
  for (const [name, model] of Object.entries(candidates)) {
    const scores = FIT_SEASONS.map(held => {
      const train = fitSet.filter(m => m.season !== held), test = fitSet.filter(m => m.season === held);
      const p = fit(model, train);
      return { held_out: held, params: round2(p), log_loss_exact: logLoss(model, p, test) };
    });
    const full = fit(model, fitSet);
    // Selection uses the unrounded fold losses: the rule is "lowest wins", and the
    // candidates can sit within 1e-4 of each other, where 4-decimal rounding decides.
    const exact = mean(scores.map(s => s.log_loss_exact));
    loso[name] = { model, folds: scores, loso_log_loss_exact: exact, loso_log_loss: r4(exact),
      fit_2023_2024: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, r4(v)])),
      in_sample_log_loss: r4(logLoss(model, full, fitSet)) };
  }
  result.fit.candidates = loso;
  const winnerName = Object.keys(loso).sort((a, b) => loso[a].loso_log_loss_exact - loso[b].loso_log_loss_exact)[0];
  const winner = { name: winnerName, model: candidates[winnerName], params: fit(candidates[winnerName], fitSet) };
  winner.shipped_params = round2(winner.params);
  result.fit.winner = { name: winnerName, model: winner.model, params: winner.params, shipped_params: winner.shipped_params };
  console.log(JSON.stringify(result.fit, null, 1));

  // Does the code ship what this run selected? Informational: a mismatch means either
  // lineup-posture.js was edited by hand or the data moved and the fit needs re-gating.
  const shipped = await import('../server/services/lineup-posture.js');
  const inCode = { SPREAD_SCALE: shipped.SPREAD_SCALE, POSITION_CV: shipped.POSITION_CV };
  const matches = winner.model === 'cv'
    && inCode.SPREAD_SCALE === winner.shipped_params.k
    && POS.every(pos => inCode.POSITION_CV?.[pos] === DEFAULT_CV[pos]);
  result.fit.code_check = { in_code: inCode, matches_this_fit: matches };
  console.log(`lineup-posture.js ships ${JSON.stringify(inCode)}; matches this fit: ${matches}`);

  // Fit-season diagnostics that do not touch 2025.
  const fitLineups = lineups.filter(l => l.phase === 'main' && FIT_SEASONS.includes(l.season));
  result.fit.lineup_residual = {
    sd_actual_minus_projected: r4(sd(fitLineups.map(l => l.actual - l.mean))),
    mean_actual_minus_projected: r4(mean(fitLineups.map(l => l.actual - l.mean))),
    median_projected: r4(median(fitLineups.map(l => l.mean))),
    median_sd_dist_uninflated: r4(median(fitLineups.map(l => Math.sqrt(l.vDist)))),
    median_sd_cv_uninflated: r4(median(fitLineups.map(l => Math.sqrt(l.vCv))))
  };
  const marginErr = fitSet.map(m => m.margin - m.edge);
  result.fit.margin_residual = {
    sd_margin_error: r4(sd(marginErr)),
    rms_dist_sd: r4(Math.sqrt(mean(fitSet.map(m => m.vDist)))),
    empirical_k_dist: r4(sd(marginErr) / Math.sqrt(mean(fitSet.map(m => m.vDist))))
  };
  if (flag('--fit-only')) {
    if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
    console.log('--fit-only: 2025 not read.');
    return;
  }

  // 3. Validation, once.
  const val = mainSet.filter(m => m.season === VALIDATION_SEASON);
  const evB0 = evaluate(B0.model, B0.params, val);
  const evB1 = evaluate(B1.model, B1.params, val);
  const evWin = evaluate(winner.model, winner.params, val);
  const evShip = evaluate(winner.model, winner.shipped_params, val);
  const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
  const llB0 = val.map(m => lossOf(probOf(B0.model, B0.params, m), m.y));
  const llShip = val.map(m => lossOf(probOf(winner.model, winner.shipped_params, m), m.y));
  const boot = pairedBootstrapDiff(llB0, llShip, { seed: SEED, iterations: 2000, groups: val.map(m => m.group) });
  const { postureGateVerdict } = await import('../server/services/gate-verdicts.js');
  const verdict = postureGateVerdict({ logLoss: evShip.log_loss, baseLogLoss: evB0.log_loss,
    ece: evShip.ece, baseEce: evB0.ece, boot });
  result.validation = {
    season: VALIDATION_SEASON, n: val.length, weeks: new Set(val.map(m => m.group)).size,
    B0_current: evB0, B1_cv_fallback: evB1, winner_unrounded: evWin, winner_shipped: evShip,
    bootstrap_log_loss_winner_minus_B0: boot,
    gate: verdict
  };
  const valLineups = lineups.filter(l => l.phase === 'main' && l.season === VALIDATION_SEASON);
  const k = winner.shipped_params.k ?? null;
  const lineupSdOfWinner = l => (winner.model === 'dist' ? k * Math.sqrt(l.vDist)
    : winner.model === 'cv' ? k * Math.sqrt(l.vCv) : null);
  result.validation.lineup_residual = {
    sd_actual_minus_projected: r4(sd(valLineups.map(l => l.actual - l.mean))),
    median_projected: r4(median(valLineups.map(l => l.mean))),
    median_sd_B0: r4(median(valLineups.map(l => BASELINE_SCALE * Math.sqrt(l.vDist)))),
    median_sd_winner: k != null ? r4(median(valLineups.map(lineupSdOfWinner))) : null,
    mean_actual_minus_projected: r4(mean(valLineups.map(l => l.actual - l.mean))),
    sd_margin_error: r4(sd(val.map(m => m.margin - m.edge)))
  };

  // 4. Early-season diagnostic (not gated).
  const early = matchups.filter(m => m.phase === 'early');
  if (early.length) {
    result.early_2025_weeks_2_4 = {
      B0_current: evaluate(B0.model, B0.params, early),
      winner_shipped: evaluate(winner.model, winner.shipped_params, early)
    };
  }

  // 5. Cross-check against real ESPN team-week scores (includes K and DEF).
  try {
    const { rows } = await import('../server/db/index.js');
    const lws = rows(`SELECT league_id, season, roster_id, points FROM league_week_scores
                      WHERE season BETWEEN 2023 AND 2025 AND is_playoff = 0 AND points > 0`);
    const byTeam = new Map();
    for (const r of lws) {
      const key = `${r.league_id}|${r.season}|${r.roster_id}`;
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(r.points);
    }
    let ss = 0, df = 0, tot = 0, n = 0, teams = 0;
    for (const pts of byTeam.values()) {
      if (pts.length < 8) continue;
      const m = mean(pts);
      ss += pts.reduce((s, x) => s + (x - m) ** 2, 0); df += pts.length - 1; tot += pts.reduce((s, x) => s + x, 0); n += pts.length; teams++;
    }
    result.league_week_scores = { team_seasons: teams, team_weeks: n,
      pooled_within_team_sd: r4(Math.sqrt(ss / df)), mean_score: r4(tot / n), cv: r4(Math.sqrt(ss / df) / (tot / n)) };
  } catch (e) { result.league_week_scores = { error: String(e.message) }; }

  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
  const show = ev => ({ log_loss: ev.log_loss, ece: ev.ece, brier: ev.brier });
  console.log(JSON.stringify({
    validation: { B0: show(evB0), B1: show(evB1), winner: show(evWin), shipped: show(evShip) },
    bootstrap: boot, gate: result.validation.gate,
    lineup_residual_2025: result.validation.lineup_residual,
    league_week_scores: result.league_week_scores
  }, null, 1));
  console.log('\nReliability, 2025 (bin | n | B0 predicted -> won | shipped predicted -> won)');
  for (let i = 0; i < 10; i++) {
    const a = evB0.table[i], b = evShip.table[i];
    console.log(`${a.bin.padEnd(8)} | ${String(a.n).padStart(5)} ${String(a.mean_predicted).padStart(6)} -> ${String(a.actual_win_rate).padStart(6)}` +
      ` | ${String(b.n).padStart(5)} ${String(b.mean_predicted).padStart(6)} -> ${String(b.actual_win_rate).padStart(6)}`);
  }
}

await main();
