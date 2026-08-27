/** Chronological, multiplicity-aware validation for the player-head registry. */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { replaySeasonWeekly } from './weekly-backtest.js';
import { spearman } from './backtest.js';
import { PLAYER_HEADS, PLAYER_HEAD_REGISTRY_VERSION } from './player-head-registry.js';
import { random, withRandomSeed } from './stats-util.js';
import { WEEKLY_ROLE_RECENCY } from './weekly-ensemble.js';

db.exec(`CREATE TABLE IF NOT EXISTS player_head_audits (
  spec_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, registry_version TEXT NOT NULL,
  development_season INTEGER NOT NULL, discovery_season INTEGER NOT NULL,
  validation_season INTEGER, validation_opened INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
)`);

const mean = values => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
const prediction = (row, id) => Number(row.candidate_heads?.[id]);
const usable = (data, id) => data.filter(row => Number.isFinite(prediction(row, id)) && Number.isFinite(row.actual));
/**
 * These primitives (metrics/correlation/signFlipP/holmDecisions) only assume
 * rows of the shape `{ candidate_heads: {id: value}, actual }` — nothing
 * fantasy-points-specific. Exported so other targets (prop stats, anything
 * else scored against the same PLAYER_HEADS registry) reuse the identical,
 * already-tested discovery/redundancy/significance machinery instead of a
 * second copy that can drift out of sync with this one.
 */
export const metrics = (data, id) => {
  const use = usable(data, id);
  const pairs = use.map(row => ({ pred: prediction(row, id), act: row.actual }));
  return {
    n: use.length,
    coverage: data.length ? +(use.length / data.length).toFixed(4) : null,
    mae: use.length ? +mean(use.map(row => Math.abs(prediction(row, id) - row.actual))).toFixed(4) : null,
    rmse: use.length ? +Math.sqrt(mean(use.map(row => (prediction(row, id) - row.actual) ** 2))).toFixed(4) : null,
    spearman: use.length ? spearman(pairs) : null
  };
};

export function correlation(data, a, b) {
  const use = data.filter(row => Number.isFinite(prediction(row, a)) && Number.isFinite(prediction(row, b)));
  if (use.length < 3) return 0;
  const x = use.map(row => prediction(row, a)), y = use.map(row => prediction(row, b));
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

export function signFlipP(data, candidate, baseline = 'active_champion', trials = 1000, seed = 20260901) {
  const use = data.filter(row => Number.isFinite(prediction(row, candidate)) && Number.isFinite(prediction(row, baseline)));
  if (!use.length) return null;
  const d = use.map(row => Math.abs(prediction(row, candidate) - row.actual)
    - Math.abs(prediction(row, baseline) - row.actual));
  const observed = mean(d);
  let extreme = 0;
  withRandomSeed(seed, () => {
    for (let t = 0; t < trials; t++) {
      const value = mean(d.map(x => random() < 0.5 ? x : -x));
      if (value <= observed) extreme++;
    }
  });
  return { observed_mae_delta: +observed.toFixed(5), p_value: +((extreme + 1) / (trials + 1)).toFixed(5), trials };
}

export function holmDecisions(items, alpha = 0.05) {
  const ordered = items.filter(x => x.significance?.p_value != null)
    .sort((a, b) => a.significance.p_value - b.significance.p_value);
  let stillPassing = true;
  for (let i = 0; i < ordered.length; i++) {
    const threshold = alpha / (ordered.length - i);
    const pass = stillPassing && ordered[i].significance.p_value <= threshold;
    ordered[i].holm = { rank: i + 1, threshold: +threshold.toFixed(6), passed: pass };
    if (!pass) stillPassing = false;
  }
}

function replay(season) {
  return replaySeasonWeekly(season, {
    startWeek: 5, endWeek: 18, distributions: false, roleRecency: WEEKLY_ROLE_RECENCY
  })._predictions;
}

/**
 * Validation is closed by default. Opening it is an explicit, persisted action
 * against a spec hash, so the same architecture cannot quietly reopen 2025
 * after every tweak.
 */
export function auditPlayerHeads({
  developmentSeason = 2023, discoverySeason = 2024, validationSeason = 2025,
  openValidation = false, redundancy = 0.985, minN = 250, alpha = 0.05,
  persist = true
} = {}) {
  const spec = { registry: PLAYER_HEAD_REGISTRY_VERSION, developmentSeason, discoverySeason,
    validationSeason, redundancy, minN, alpha, baseline: 'active_champion',
    roleRecency: WEEKLY_ROLE_RECENCY, heads: PLAYER_HEADS.map(x => x.id) };
  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const prior = rows('SELECT * FROM player_head_audits WHERE spec_hash=?', specHash)[0];
  if (prior && (!openValidation || prior.validation_opened)) return JSON.parse(prior.result_json);

  const development = replay(developmentSeason), discovery = replay(discoverySeason);
  const candidates = PLAYER_HEADS.map(head => ({ head, development: metrics(development, head.id),
    discovery: metrics(discovery, head.id) }));
  const champion = {
    head: { id: 'active_champion', name: 'Current frozen champion' },
    development: metrics(development, 'active_champion'),
    discovery: metrics(discovery, 'active_champion')
  };

  // Lower discovery MAE gets first claim on a feature family; near-duplicate
  // predictions are removed before significance testing.
  const ordered = candidates.filter(x => x.discovery.n >= minN && x.discovery.coverage >= 0.8)
    .sort((a, b) => a.discovery.mae - b.discovery.mae);
  const kept = [], redundant = [];
  for (const candidate of ordered) {
    const duplicate = kept.find(other => Math.abs(correlation(discovery, candidate.head.id, other.head.id)) >= redundancy);
    if (duplicate && candidate.head.id !== 'structural') redundant.push({ id: candidate.head.id, duplicate_of: duplicate.head.id,
      correlation: +correlation(discovery, candidate.head.id, duplicate.head.id).toFixed(5) });
    else kept.push(candidate);
  }

  const tested = kept.map(candidate => ({
    ...candidate,
    significance: signFlipP(discovery, candidate.head.id),
    rank_ok: candidate.discovery.spearman >= champion.discovery.spearman - 0.002,
    accuracy_ok: candidate.discovery.mae < champion.discovery.mae
  }));
  holmDecisions(tested, alpha);
  const survivors = tested.filter(x => x.accuracy_ok && x.rank_ok && x.holm?.passed);

  let validation = null;
  if (openValidation) {
    const holdout = replay(validationSeason);
    const baseline = metrics(holdout, 'active_champion');
    validation = {
      season: validationSeason, baseline,
      candidates: survivors.map(x => {
        const m = metrics(holdout, x.head.id), significance = signFlipP(holdout, x.head.id);
        return { id: x.head.id, metrics: m, significance,
          passed: m.n >= minN && m.mae < baseline.mae
            && m.spearman >= baseline.spearman - 0.002 && significance.p_value <= alpha };
      })
    };
  }

  const result = {
    spec_hash: specHash, spec, validation_opened: openValidation,
    baseline: { id: 'active_champion', development: champion.development, discovery: champion.discovery },
    candidates_tested: tested.length, candidates_redundant: redundant.length,
    redundant, discovery: tested, survivors: survivors.map(x => x.head.id), validation,
    production_eligible: false,
    note: 'Historical validation can establish forecast quality, not betting profitability. Production requires real priced forward shadow decisions and positive CLV.'
  };
  if (persist) run(`INSERT INTO player_head_audits
    (spec_hash,created_at,registry_version,development_season,discovery_season,validation_season,validation_opened,result_json)
    VALUES (?,datetime('now'),?,?,?,?,?,?)
    ON CONFLICT(spec_hash) DO UPDATE SET validation_opened=MAX(validation_opened,excluded.validation_opened),result_json=excluded.result_json`,
  specHash, PLAYER_HEAD_REGISTRY_VERSION, developmentSeason, discoverySeason,
  validationSeason, openValidation ? 1 : 0, JSON.stringify(result));
  return result;
}

export function playerHeadAuditHistory() {
  return rows(`SELECT spec_hash,created_at,registry_version,development_season,discovery_season,
                      validation_season,validation_opened,result_json
               FROM player_head_audits ORDER BY created_at DESC`).map(x => ({ ...x, result: JSON.parse(x.result_json), result_json: undefined }));
}
