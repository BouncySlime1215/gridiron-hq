/** Chronological, price-aware calibration for each MLB market. */
import { db, rows, run } from '../db/index.js';

db.exec(`CREATE TABLE IF NOT EXISTS mlb_probability_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, model_version TEXT NOT NULL,
  trained_through TEXT NOT NULL, created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL, model_slope REAL, market_slope REAL, metrics_json TEXT NOT NULL,
  UNIQUE(market,model_version,trained_through)
)`);

const MARKETS = new Set(['nrfi', 'pitcher_strikeouts', 'batter_total_bases']);
const VERSION = 'mlb-price-logit-v1';
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit = p => Math.log(Math.max(1e-5, Math.min(1 - 1e-5, p)) / Math.max(1e-5, 1 - Math.min(1 - 1e-5, p)));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r4 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(4);

function samplesFor(market, throughDate) {
  const picks = rows(`SELECT * FROM mlb_first_party_picks
    WHERE market=? AND pick_date<? AND tracking_mode='forward' AND american_price IS NOT NULL
      AND pregame_snapshot_at IS NOT NULL AND model_probability IS NOT NULL AND implied_probability IS NOT NULL
    ORDER BY pick_date,rank`, market, throughDate);
  const out = [];
  for (const p of picks) {
    let actual = null;
    if (market === 'nrfi') {
      const g = rows('SELECT yrfi FROM mlb_games WHERE game_pk=?', p.game_pk)[0];
      if (g?.yrfi != null) actual = p.side === 'NRFI' ? (g.yrfi === 0 ? 1 : 0) : (g.yrfi === 1 ? 1 : 0);
    } else if (market === 'pitcher_strikeouts') {
      const g = rows('SELECT strikeouts value FROM mlb_pitcher_games WHERE player_id=? AND date=?', p.player_id, p.pick_date)[0];
      if (g) actual = p.side === 'Over' ? +(g.value > p.line) : +(g.value < p.line);
    } else {
      const g = rows('SELECT total_bases value FROM mlb_batter_games WHERE player_id=? AND date=?', p.player_id, p.pick_date)[0];
      if (g) actual = p.side === 'Over' ? +(g.value > p.line) : +(g.value < p.line);
    }
    if (actual != null) out.push({ date: p.pick_date, model: p.model_probability, market: p.implied_probability, actual });
  }
  return out;
}

function fit(samples) {
  let b0 = 0, b1 = 0, b2 = 1;
  const ridge = 2;
  for (let iter = 0; iter < 60; iter++) {
    const grad = [-ridge * b0, -ridge * b1, -ridge * (b2 - 1)];
    const h = [[ridge, 0, 0], [0, ridge, 0], [0, 0, ridge]];
    for (const s of samples) {
      const x = [1, logit(s.model), logit(s.market)];
      const p = sigmoid(b0 + b1 * x[1] + b2 * x[2]);
      const w = Math.max(1e-6, p * (1 - p));
      for (let i = 0; i < 3; i++) {
        grad[i] += x[i] * (s.actual - p);
        for (let j = 0; j < 3; j++) h[i][j] += w * x[i] * x[j];
      }
    }
    const delta = solve3(h, grad);
    if (!delta) break;
    b0 += delta[0]; b1 += delta[1]; b2 += delta[2];
    if (delta.reduce((s, x) => s + Math.abs(x), 0) < 1e-7) break;
  }
  return { intercept: b0, modelSlope: b1, marketSlope: b2 };
}

function solve3(a, b) {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c]; for (let k = c; k < 4; k++) m[c][k] /= d;
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
  }
  return m.map(r => r[3]);
}

function probability(s, f) { return sigmoid(f.intercept + f.modelSlope * logit(s.model) + f.marketSlope * logit(s.market)); }
function score(samples, fitted) {
  const ps = samples.map(x => ({ ...x, calibrated: probability(x, fitted) }));
  return { n: ps.length, calibrated_brier: r4(mean(ps.map(x => (x.calibrated - x.actual) ** 2))),
    market_brier: r4(mean(ps.map(x => (x.market - x.actual) ** 2))),
    raw_model_brier: r4(mean(ps.map(x => (x.model - x.actual) ** 2))) };
}

export function buildMlbCalibration(market, throughDate) {
  if (!MARKETS.has(market)) throw new Error('unsupported MLB market');
  const samples = samplesFor(market, throughDate);
  if (samples.length < 100) return { market, model_version: VERSION, trained_through: throughDate,
    sample_size: samples.length, status: 'insufficient', gate_passed: false,
    note: 'At least 100 settled, forward, real-price predictions are required to fit calibration.' };
  const months = [...new Set(samples.map(x => x.date.slice(0, 7)))];
  const forward = [];
  for (const month of months) {
    const train = samples.filter(x => x.date.slice(0, 7) < month);
    const test = samples.filter(x => x.date.slice(0, 7) === month);
    if (train.length < 100) continue;
    const f = fit(train); forward.push(...test.map(x => ({ ...x, calibrated: probability(x, f) })));
  }
  const fitted = fit(samples);
  const metrics = { training: score(samples, fitted), walk_forward: forward.length ? {
    n: forward.length,
    calibrated_brier: r4(mean(forward.map(x => (x.calibrated - x.actual) ** 2))),
    market_brier: r4(mean(forward.map(x => (x.market - x.actual) ** 2)))
  } : { n: 0, calibrated_brier: null, market_brier: null } };
  metrics.gate_passed = metrics.walk_forward.n >= 150 && metrics.walk_forward.calibrated_brier < metrics.walk_forward.market_brier;
  run(`INSERT INTO mlb_probability_calibrations
    (market,model_version,trained_through,created_at,sample_size,intercept,model_slope,market_slope,metrics_json)
    VALUES (?,?,?,datetime('now'),?,?,?,?,?)
    ON CONFLICT(market,model_version,trained_through) DO UPDATE SET created_at=excluded.created_at,
      sample_size=excluded.sample_size,intercept=excluded.intercept,model_slope=excluded.model_slope,
      market_slope=excluded.market_slope,metrics_json=excluded.metrics_json`, market, VERSION, throughDate,
    samples.length, fitted.intercept, fitted.modelSlope, fitted.marketSlope, JSON.stringify(metrics));
  return latestMlbCalibration(market, throughDate);
}

export function latestMlbCalibration(market, beforeDate = '9999-12-31') {
  const x = rows(`SELECT * FROM mlb_probability_calibrations WHERE market=? AND trained_through<=?
    ORDER BY trained_through DESC,id DESC LIMIT 1`, market, beforeDate)[0];
  return x && { ...x, metrics: JSON.parse(x.metrics_json), metrics_json: undefined,
    gate_passed: JSON.parse(x.metrics_json).gate_passed === true };
}

export function mlbCalibrations(beforeDate = '9999-12-31') {
  return [...MARKETS].map(market => latestMlbCalibration(market, beforeDate) ?? {
    market, model_version: VERSION, trained_through: null, sample_size: 0, gate_passed: false, status: 'not_fitted'
  });
}
