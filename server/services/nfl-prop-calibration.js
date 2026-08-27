/**
 * Chronological calibration registry for NFL prop probabilities.
 *
 * Calibration is a model competition, not a cosmetic rescale. Every candidate
 * is fitted on completed earlier seasons, selected on a later discovery season,
 * and must repeat on validation before it can become active. The registry keeps
 * many plausible heads in shadow while redundancy and multiplicity controls
 * stop a large search library from manufacturing confidence.
 */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { random, withRandomSeed } from './stats-util.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_prop_calibration_fits (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, market TEXT NOT NULL,
  spec_hash TEXT NOT NULL, candidate_id TEXT NOT NULL, train_through INTEGER NOT NULL,
  params_json TEXT NOT NULL, audit_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0
)`);

const clamp = p => Math.max(0.001, Math.min(0.999, Number(p)));
const logit = p => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

const GLOBAL = [
  ['intercept-r1', 'intercept', 1], ['intercept-r10', 'intercept', 10],
  ['platt-r1', 'platt', 1], ['platt-r10', 'platt', 10],
  ['beta-r1', 'beta', 1], ['beta-r10', 'beta', 10],
  ['isotonic-25', 'isotonic', 25], ['isotonic-50', 'isotonic', 50],
  ['hist-5', 'histogram', 5], ['hist-10', 'histogram', 10],
  ['hist-15', 'histogram', 15], ['hist-20', 'histogram', 20]
];
const POSITION = [
  ['pos-intercept-r2', 'intercept', 2], ['pos-intercept-r10', 'intercept', 10],
  ['pos-platt-r2', 'platt', 2], ['pos-platt-r10', 'platt', 10],
  ['pos-beta-r2', 'beta', 2], ['pos-beta-r10', 'beta', 10],
  ['pos-isotonic-25', 'isotonic', 25], ['pos-isotonic-50', 'isotonic', 50],
  ['pos-hist-5', 'histogram', 5], ['pos-hist-10', 'histogram', 10]
];

export const TD_CALIBRATION_VERSION = 'td-calibration-v1.0.0-chronological';
export const TD_CALIBRATION_HEADS = Object.freeze([
  { id: 'identity', family: 'identity', scope: 'global', complexity: 0 },
  ...GLOBAL.map(([id, family, tuning]) => ({ id, family, tuning, scope: 'global', complexity: family === 'beta' ? 3 : family === 'platt' ? 2 : 1 })),
  ...POSITION.map(([id, family, tuning]) => ({ id, family, tuning, scope: 'position', complexity: family === 'beta' ? 12 : family === 'platt' ? 8 : 4 })),
  { id: 'global-base-shrink-50', family: 'base_shrink', tuning: 50, scope: 'global', complexity: 1 },
  { id: 'ensemble-hist-iso-beta', family: 'ensemble', scope: 'diverse', complexity: 7,
    members: ['hist-15', 'isotonic-25', 'beta-r1'] },
  { id: 'ensemble-global-robust', family: 'ensemble', scope: 'diverse', complexity: 8,
    members: ['hist-10', 'hist-20', 'isotonic-50', 'beta-r10'] },
  { id: 'ensemble-position-diverse', family: 'ensemble', scope: 'diverse', complexity: 16,
    members: ['pos-hist-10', 'pos-isotonic-50', 'pos-beta-r2'] },
  { id: 'ensemble-global-position', family: 'ensemble', scope: 'diverse', complexity: 12,
    members: ['hist-15', 'pos-isotonic-25', 'beta-r1'] }
].map(x => Object.freeze({ ...x, status: 'candidate', cutoff_rule: 'fit rows must precede evaluation season' })));

function features(family, p) {
  if (family === 'intercept') return [1];
  if (family === 'platt') return [logit(p), 1];
  if (family === 'beta') return [Math.log(clamp(p)), Math.log(1 - clamp(p)), 1];
  return [];
}

function solve(a, b) {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-10) return null;
    const d = m[col][col];
    for (let j = col; j <= n; j++) m[col][j] /= d;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = m[r][col];
      for (let j = col; j <= n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map(row => row[n]);
}

function fitLogistic(data, family, ridge = 1) {
  const d = features(family, 0.5).length;
  let beta = family === 'platt' ? [1, 0] : family === 'beta' ? [1, -1, 0] : [0];
  for (let iter = 0; iter < 60; iter++) {
    const grad = Array(d).fill(0), h = Array.from({ length: d }, () => Array(d).fill(0));
    for (const r of data) {
      const x = features(family, r.p), pred = sigmoid(x.reduce((s, v, i) => s + v * beta[i], 0));
      const w = Math.max(1e-5, pred * (1 - pred));
      for (let i = 0; i < d; i++) {
        grad[i] += x[i] * (r.y - pred);
        for (let j = 0; j < d; j++) h[i][j] += x[i] * x[j] * w;
      }
    }
    for (let i = 0; i < d; i++) {
      // Do not penalize intercepts. Slopes shrink toward the identity mapping.
      const isIntercept = (family === 'intercept') || i === d - 1;
      if (!isIntercept) {
        const target = family === 'beta' ? (i === 0 ? 1 : i === 1 ? -1 : 0) : (i === 0 ? 1 : 0);
        grad[i] -= ridge * (beta[i] - target); h[i][i] += ridge;
      }
    }
    const step = solve(h, grad);
    if (!step) break;
    beta = beta.map((v, i) => v + Math.max(-1, Math.min(1, step[i])));
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return { type: family, beta };
}

function fitHistogram(data, bins) {
  const counts = Array.from({ length: bins }, () => ({ n: 0, y: 0 }));
  for (const r of data) {
    const i = Math.min(bins - 1, Math.floor(clamp(r.p) * bins));
    counts[i].n++; counts[i].y += r.y;
  }
  const base = mean(data.map(r => r.y)) ?? 0.2;
  return { type: 'histogram', bins, values: counts.map(x => (x.y + base * 20) / (x.n + 20)) };
}

function fitIsotonic(data, minBin) {
  const sorted = [...data].sort((a, b) => a.p - b.p);
  const initial = [];
  for (let i = 0; i < sorted.length; i += minBin) {
    const chunk = sorted.slice(i, i + minBin);
    initial.push({ lo: chunk[0].p, hi: chunk.at(-1).p, n: chunk.length, y: chunk.reduce((s, x) => s + x.y, 0) });
  }
  const blocks = [];
  for (const block of initial) {
    blocks.push(block);
    while (blocks.length >= 2) {
      const b = blocks.at(-1), a = blocks.at(-2);
      if (a.y / a.n <= b.y / b.n) break;
      blocks.splice(-2, 2, { lo: a.lo, hi: b.hi, n: a.n + b.n, y: a.y + b.y });
    }
  }
  return { type: 'isotonic', blocks: blocks.map(x => ({ ...x, value: (x.y + 1) / (x.n + 2) })) };
}

function fitOne(data, spec) {
  if (spec.family === 'identity') return { type: 'identity' };
  if (spec.family === 'base_shrink') return { type: 'base_shrink', base: mean(data.map(r => r.y)), k: spec.tuning };
  if (spec.family === 'histogram') return fitHistogram(data, spec.tuning);
  if (spec.family === 'isotonic') return fitIsotonic(data, spec.tuning);
  return fitLogistic(data, spec.family, spec.tuning);
}

function fitHead(data, spec) {
  if (spec.family === 'ensemble') {
    const members = spec.members.map(id => {
      const member = TD_CALIBRATION_HEADS.find(x => x.id === id);
      if (!member || member.family === 'ensemble') throw new Error(`invalid calibration ensemble member ${id}`);
      return fitHead(data, member);
    });
    return { spec, ensemble: members };
  }
  const global = fitOne(data, { ...spec, scope: 'global' });
  if (spec.scope !== 'position') return { spec, global, groups: {} };
  const groups = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const subset = data.filter(r => r.position === pos);
    if (subset.length >= 200) groups[pos] = fitOne(subset, { ...spec, scope: 'global' });
  }
  return { spec, global, groups };
}

function applyOne(model, p) {
  if (!model || model.type === 'identity') return clamp(p);
  if (model.type === 'base_shrink') return clamp((p + model.k * model.base) / (1 + model.k));
  if (model.type === 'histogram') return clamp(model.values[Math.min(model.bins - 1, Math.floor(clamp(p) * model.bins))]);
  if (model.type === 'isotonic') {
    const block = model.blocks.find(x => p <= x.hi) ?? model.blocks.at(-1);
    return clamp(block?.value ?? p);
  }
  const x = features(model.type, p);
  return clamp(sigmoid(x.reduce((s, v, i) => s + v * model.beta[i], 0)));
}

export function applyTdCalibrator(model, p, context = {}) {
  if (model?.ensemble?.length) {
    return clamp(mean(model.ensemble.map(member => applyTdCalibrator(member, p, context))));
  }
  return applyOne(model?.groups?.[context.position] ?? model?.global ?? { type: 'identity' }, p);
}

function calibrationMetrics(data, model) {
  if (!data.length) return { n: 0, brier: null, log_loss: null, ece: null };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  let brier = 0, logLoss = 0;
  for (const r of data) {
    const p = applyTdCalibrator(model, r.p, r);
    brier += (p - r.y) ** 2;
    logLoss += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
    const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += r.y;
  }
  const ece = bins.reduce((s, b) => s + (b.n ? b.n / data.length * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  return { n: data.length, brier: +(brier / data.length).toFixed(5),
    log_loss: +(logLoss / data.length).toFixed(5), ece: +ece.toFixed(5) };
}

function correlation(a, b) {
  if (a.length < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

function pairedP(data, candidate, trials = 2000) {
  const deltas = data.map(r => {
    const raw = (r.p - r.y) ** 2;
    const calibrated = (applyTdCalibrator(candidate, r.p, r) - r.y) ** 2;
    return calibrated - raw;
  });
  const observed = mean(deltas);
  let extreme = 0;
  withRandomSeed(20260827, () => {
    for (let t = 0; t < trials; t++) {
      const x = mean(deltas.map(d => random() < 0.5 ? d : -d));
      if (x <= observed) extreme++;
    }
  });
  return { brier_delta: +observed.toFixed(6), p_value: +((extreme + 1) / (trials + 1)).toFixed(6), trials };
}

function tdRows(replayRows) {
  return replayRows.filter(r => r.eligibility?.markets?.player_anytime_td)
    .map(r => ({ p: r.market.anytime_td, y: r.actual.anytime_td,
      position: r.position, season: r.season, week: r.week }));
}

export function auditTdCalibration({ trainRows, discoveryRows, validationRows = null, persist = true } = {}) {
  const train = tdRows(trainRows), discovery = tdRows(discoveryRows), validation = validationRows ? tdRows(validationRows) : null;
  const fitted = TD_CALIBRATION_HEADS.map(spec => ({ spec, model: fitHead(train, spec) }));
  const predictions = new Map(fitted.map(x => [x.spec.id,
    discovery.map(r => applyTdCalibrator(x.model, r.p, r))]));
  const ordered = fitted.map(x => ({ ...x, discovery: calibrationMetrics(discovery, x.model) }))
    .sort((a, b) => a.discovery.brier - b.discovery.brier);
  const kept = [], redundant = [];
  for (const candidate of ordered) {
    const duplicate = kept.find(x => Math.abs(correlation(predictions.get(candidate.spec.id), predictions.get(x.spec.id))) >= 0.9995);
    if (duplicate && candidate.spec.id !== 'identity') redundant.push({ id: candidate.spec.id, duplicate_of: duplicate.spec.id });
    else kept.push(candidate);
  }
  const raw = ordered.find(x => x.spec.id === 'identity');
  const tested = kept.filter(x => x.spec.id !== 'identity').map(x => ({
    ...x, significance: pairedP(discovery, x.model),
    brier_ok: x.discovery.brier < raw.discovery.brier,
    logloss_ok: x.discovery.log_loss <= raw.discovery.log_loss,
    calibration_ok: x.discovery.ece < raw.discovery.ece
  })).sort((a, b) => a.significance.p_value - b.significance.p_value);
  let holmOpen = true;
  for (let i = 0; i < tested.length; i++) {
    const threshold = 0.05 / (tested.length - i);
    tested[i].holm = { rank: i + 1, threshold: +threshold.toFixed(6), passed: holmOpen && tested[i].significance.p_value <= threshold };
    if (!tested[i].holm.passed) holmOpen = false;
  }
  const survivors = tested.filter(x => x.brier_ok && x.logloss_ok && x.calibration_ok && x.holm.passed);
  const selected = survivors.sort((a, b) => a.discovery.brier - b.discovery.brier || a.spec.complexity - b.spec.complexity)[0] ?? null;
  const validationResult = validation && selected ? {
    raw: calibrationMetrics(validation, raw.model), candidate: calibrationMetrics(validation, selected.model),
    significance: pairedP(validation, selected.model)
  } : null;
  const validationPassed = !!(validationResult
    && validationResult.candidate.brier < validationResult.raw.brier
    && validationResult.candidate.log_loss <= validationResult.raw.log_loss
    && validationResult.candidate.ece < validationResult.raw.ece
    && validationResult.significance.p_value <= 0.05);
  const finalModel = selected && validationPassed
    ? fitHead([...train, ...discovery, ...validation], selected.spec) : null;
  const spec = { version: TD_CALIBRATION_VERSION, heads: TD_CALIBRATION_HEADS.map(x => x.id),
    train_seasons: [...new Set(train.map(x => x.season))], discovery_seasons: [...new Set(discovery.map(x => x.season))],
    validation_seasons: validation ? [...new Set(validation.map(x => x.season))] : [] };
  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const audit = {
    version: TD_CALIBRATION_VERSION, spec_hash: specHash, candidates: TD_CALIBRATION_HEADS.length,
    redundant, tested: tested.map(x => ({ id: x.spec.id, family: x.spec.family, scope: x.spec.scope,
      discovery: x.discovery, significance: x.significance, holm: x.holm,
      passed: x.brier_ok && x.logloss_ok && x.calibration_ok && x.holm.passed })),
    raw_discovery: raw.discovery, survivors: survivors.map(x => x.spec.id), selected: selected?.spec.id ?? null,
    validation: validationResult, validation_passed: validationPassed,
    active: validationPassed ? selected.spec.id : 'identity',
    note: 'Selection is chronological, redundancy-pruned and multiplicity-corrected. A discovery win without a repeated validation win has zero authority.'
  };
  if (persist && finalModel) {
    const id = `${specHash.slice(0, 16)}-${selected.spec.id}`;
    db.exec('BEGIN');
    try {
      run(`UPDATE nfl_prop_calibration_fits SET active=0 WHERE market='player_anytime_td'`);
      run(`INSERT INTO nfl_prop_calibration_fits
        (id,created_at,market,spec_hash,candidate_id,train_through,params_json,audit_json,active)
        VALUES (?,datetime('now'),'player_anytime_td',?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET params_json=excluded.params_json,audit_json=excluded.audit_json,active=1`,
      id, specHash, selected.spec.id, Math.max(...[...train, ...discovery, ...validation].map(x => x.season)),
      JSON.stringify(finalModel), JSON.stringify(audit));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return audit;
}

export function activeTdCalibration() {
  const fit = rows(`SELECT * FROM nfl_prop_calibration_fits
                    WHERE market='player_anytime_td' AND active=1 ORDER BY created_at DESC LIMIT 1`)[0];
  return fit ? { id: fit.id, candidate_id: fit.candidate_id, train_through: fit.train_through,
    model: JSON.parse(fit.params_json), audit: JSON.parse(fit.audit_json) } : null;
}

export function calibrateAnytimeTd(p, context = {}) {
  const active = activeTdCalibration();
  return active ? applyTdCalibrator(active.model, p, context) : clamp(p);
}

export function tdCalibrationCatalog() {
  const active = activeTdCalibration();
  return { version: TD_CALIBRATION_VERSION, count: TD_CALIBRATION_HEADS.length,
    heads: TD_CALIBRATION_HEADS, active: active ? { id: active.id, candidate_id: active.candidate_id,
      train_through: active.train_through, audit: active.audit } : null };
}
