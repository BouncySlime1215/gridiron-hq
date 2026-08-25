/**
 * Prediction engine API.
 *
 * Exposes the projection model, its accuracy, the simulator and the supporting
 * estimates. Results that take real work — projections, correlation fits, season
 * simulations — are memoised per process, because the inputs only change on an
 * explicit sync.
 */
import { Router } from 'express';
import { db, row, rows, run } from '../db/index.js';
import { scoringFor, PPR } from '../services/scoring.js';
import { buildProjections, weeklyDistribution, seasonDistribution } from '../services/projections.js';
import { compare, actuals, gradePoint, gradeDistribution, baselines, weeklyDecisionBacktest } from '../services/backtest.js';
import { simulateSeason, tradeImpact } from '../services/season-sim.js';
import { fitCorrelations, correlationTable, clearCorrelationCache } from '../services/correlation.js';
import { fitGameScript, gameScriptFor, syncHistoricalLines, syncCurrentLines, linesFor, clearGameScriptCache } from '../services/gamescript.js';
import { availability, weeklyAvailability, cascades, handcuffValue } from '../services/contingency.js';
import { syncAll as syncNflverse, usageSeasons, usageFor } from '../services/nflverse.js';
import { clearMatchupCache } from '../services/matchups.js';
import { resolvePlayer, assetUniverse, loadRosters } from '../services/trade-engine.js';
import { deriveFormat } from '../services/format.js';
import { withRandomSeed } from '../services/stats-util.js';
import { requireLeagueId } from '../modeling/league-context.js';
import { assertTimestampedObservation, configurationHash } from '../modeling/contracts.js';
import { CANDIDATES, FANTASY_FEATURE_CONTRACT } from '../modeling/candidates.js';
import { ModelRegistry } from '../modeling/registry.js';
import { SqliteModelStore, recordModelAudit, registrySnapshot } from '../modeling/sqlite-store.js';
import { requireModelPermission } from '../modeling/authz.js';
import { runWalkForward } from '../modeling/walk-forward.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;
const registry = new ModelRegistry(new SqliteModelStore(db));

function featureDefinitions(contract) {
  if (!contract || Array.isArray(contract) || typeof contract !== 'object') throw new Error('feature contract must be an object');
  const definitions = contract.features ?? contract;
  if (!definitions || Array.isArray(definitions) || typeof definitions !== 'object') throw new Error('feature contract features must be an object');
  return definitions;
}

const VALUE_TYPES = new Set(['number', 'integer', 'string', 'boolean', 'object', 'array']);
function validateContractDefinition(definition, path) {
  if (!definition || Array.isArray(definition) || typeof definition !== 'object') throw new Error(`${path} definition must be an object`);
  if (definition.type != null && !VALUE_TYPES.has(definition.type)) throw new Error(`${path} has unsupported type`);
  if (definition.enum != null && (!Array.isArray(definition.enum) || !definition.enum.length)) throw new Error(`${path} enum must be a non-empty array`);
  if (definition.properties != null) {
    if (!definition.properties || Array.isArray(definition.properties) || typeof definition.properties !== 'object') throw new Error(`${path} properties must be an object`);
    for (const [name, child] of Object.entries(definition.properties)) validateContractDefinition(child, `${path}.${name}`);
  }
  if (definition.items != null) validateContractDefinition(definition.items, `${path}[]`);
  if (Array.isArray(definition.required) && definition.required.some(x => typeof x !== 'string')) throw new Error(`${path} required must contain property names`);
}

function featureValueMatches(value, definition) {
  if (definition.enum && !definition.enum.some(x => configurationHash(x) === configurationHash(value))) return false;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (definition.type === 'integer' && !Number.isInteger(value)) return false;
  if (definition.type && definition.type !== 'integer' && type !== definition.type) return false;
  const minimum = definition.minimum ?? definition.min;
  const maximum = definition.maximum ?? definition.max;
  if (minimum != null && (!(typeof value === 'number') || value < minimum)) return false;
  if (maximum != null && (!(typeof value === 'number') || value > maximum)) return false;
  if (definition.properties) {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const required = new Set(Array.isArray(definition.required) ? definition.required : []);
    for (const name of required) if (value[name] == null) return false;
    for (const [name, child] of Object.entries(definition.properties)) {
      if (value[name] != null && !featureValueMatches(value[name], child)) return false;
    }
    if (definition.additionalProperties === false && Object.keys(value).some(name => !Object.hasOwn(definition.properties, name))) return false;
  }
  if (definition.items && (!Array.isArray(value) || value.some(item => !featureValueMatches(item, definition.items)))) return false;
  return true;
}

function validateFeatureSchema(observations, contract) {
  const definitions = featureDefinitions(contract);
  const names = Object.keys(definitions);
  for (const observation of observations) {
    const values = observation.features ?? {};
    if (!values || Array.isArray(values) || typeof values !== 'object') return false;
    for (const name of names) {
      const definition = definitions[name];
      const required = typeof definition === 'object' && definition !== null ? definition.required !== false : true;
      if (required && values[name] == null) return false;
      if (values[name] != null && !featureValueMatches(values[name], definition)) return false;
    }
    if (Object.keys(values).some(name => !Object.hasOwn(definitions, name))) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ cache */
const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
export function clearModelCache() { cache.clear(); }

/* ------------------------------------------------ persisted model registry */

r.get('/registry', requireModelPermission('model:train'), (_req, res, next) => {
  try { res.json(registrySnapshot()); } catch (e) { next(e); }
});

/** What the backtest endpoint below will actually accept, and the feature contract behind it. */
r.get('/registry/candidates', requireModelPermission('model:train'), (_req, res) => {
  res.json({
    candidates: Object.entries(CANDIDATES).map(([name, build]) => { const c = build(); return { name, version: c.version }; }),
    feature_contract: FANTASY_FEATURE_CONTRACT
  });
});

r.post('/registry/datasets', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const x = req.body ?? {};
    if (!x.name || !x.content_hash || !x.cutoff_at || !Number.isInteger(x.row_count) || x.row_count < 0) {
      return res.status(400).json({ error: 'name, content_hash, cutoff_at and non-negative integer row_count required' });
    }
    if (!Array.isArray(x.metadata?.observations) || configurationHash(x.metadata.observations) !== x.content_hash) {
      return res.status(400).json({ error: 'content_hash must match metadata.observations' });
    }
    if (x.row_count !== x.metadata.observations.length) return res.status(400).json({ error: 'row_count must match persisted observations' });
    const cutoff = Date.parse(x.cutoff_at);
    if (!Number.isFinite(cutoff) || x.metadata.observations.some(o => !Number.isFinite(Date.parse(o.as_of)) || Date.parse(o.as_of) > cutoff)) {
      return res.status(400).json({ error: 'cutoff_at must be valid and cover every observation' });
    }
    const id = x.id ?? configurationHash({ name: x.name, content_hash: x.content_hash });
    db.prepare(`INSERT INTO model_dataset_versions
      (id,name,content_hash,source_uri,row_count,cutoff_at,metadata_json,created_at,created_by,created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, x.name, x.content_hash, x.source_uri ?? null, x.row_count, x.cutoff_at,
        JSON.stringify(x.metadata ?? {}), new Date().toISOString(), String(req.modelPrincipal.id), Number(req.modelPrincipal.id));
    recordModelAudit(db, req.modelPrincipal, 'dataset.create', 'dataset', id, { content_hash: x.content_hash });
    res.status(201).json(db.prepare('SELECT * FROM model_dataset_versions WHERE id=?').get(id));
  } catch (e) { next(e); }
});

r.post('/registry/features', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const x = req.body ?? {};
    if (!x.name || !x.version || !x.content_hash || !x.contract) {
      return res.status(400).json({ error: 'name, version, content_hash and contract required' });
    }
    for (const [name, definition] of Object.entries(featureDefinitions(x.contract))) validateContractDefinition(definition, name);
    if (configurationHash(x.contract) !== x.content_hash) {
      return res.status(400).json({ error: 'content_hash must match contract' });
    }
    const id = x.id ?? configurationHash({ name: x.name, version: x.version, content_hash: x.content_hash });
    db.prepare(`INSERT INTO model_feature_versions
      (id,name,version,contract_json,content_hash,created_at,created_by,created_by_user_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, x.name, x.version, JSON.stringify(x.contract), x.content_hash, new Date().toISOString(), String(req.modelPrincipal.id), Number(req.modelPrincipal.id));
    recordModelAudit(db, req.modelPrincipal, 'feature.create', 'feature', id, { version: x.version });
    res.status(201).json(db.prepare('SELECT * FROM model_feature_versions WHERE id=?').get(id));
  } catch (e) { next(e); }
});

r.post('/registry/experiments', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const { spec, dataset_version_id: datasetId, feature_version_id: featureId } = req.body ?? {};
    if (!spec || !datasetId || !featureId) return res.status(400).json({ error: 'spec, dataset_version_id and feature_version_id required' });
    if (spec.min_validation_rows != null && (!Number.isInteger(spec.min_validation_rows) || spec.min_validation_rows < 1)) {
      return res.status(400).json({ error: 'min_validation_rows must be a positive integer' });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const experiment = registry.create(spec, req.modelPrincipal);
      db.prepare(`INSERT INTO model_experiment_inputs (experiment_id,dataset_version_id,feature_version_id) VALUES (?,?,?)`)
        .run(experiment.id, datasetId, featureId);
      recordModelAudit(db, req.modelPrincipal, 'experiment.create', 'experiment', experiment.id, { datasetId, featureId });
      db.exec('COMMIT');
      res.status(201).json(experiment);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (e) { next(e); }
});

r.post('/registry/experiments/:id/result', requireModelPermission('model:train'), (req, res, next) => {
  res.status(410).json({ error: 'caller-supplied results are unsupported; run the persisted backtest endpoint' });
});

r.post('/registry/experiments/:id/backtests', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const experiment = registry.store.get(req.params.id);
    if (!experiment) return res.status(404).json({ error: 'experiment not found' });
    if (experiment.status !== 'queued') return res.status(409).json({ error: 'only queued experiments can be backtested' });
    const input = db.prepare(`SELECT i.*, d.metadata_json, f.contract_json, f.content_hash AS feature_content_hash
      FROM model_experiment_inputs i
      JOIN model_dataset_versions d ON d.id=i.dataset_version_id
      JOIN model_feature_versions f ON f.id=i.feature_version_id WHERE i.experiment_id=?`).get(req.params.id);
    if (!input) return res.status(409).json({ error: 'pinned dataset and feature versions required' });
    const observations = JSON.parse(input.metadata_json).observations;
    if (!Array.isArray(observations)) return res.status(409).json({ error: 'persisted dataset has no observations' });
    const contract = JSON.parse(input.contract_json);
    if (configurationHash(contract) !== input.feature_content_hash) {
      return res.status(409).json({ error: 'pinned feature contract failed content verification' });
    }
    const schemaValid = validateFeatureSchema(observations, contract);
    let leakageValid = true;
    try { observations.forEach(assertTimestampedObservation); } catch { leakageValid = false; }
    const buildCandidate = CANDIDATES[experiment.spec?.candidate];
    if (!buildCandidate) return res.status(400).json({ error: `unsupported candidate; supported: ${Object.keys(CANDIDATES).join(', ')}` });
    const candidate = buildCandidate();
    const audit = runWalkForward(observations, candidate, {
      holdoutSeason: experiment.spec.holdout_season,
      minimumTrainingPeriods: experiment.spec.minimum_training_periods ?? 1,
      datasetVersion: input.dataset_version_id
    });
    const predictions = audit.folds.flatMap(f => f.predictions).filter(p => p.status === 'predicted' && Number.isFinite(p.actual));
    const mae = predictions.length ? predictions.reduce((sum, p) => sum + Math.abs(p.prediction - p.actual), 0) / predictions.length : null;
    const minRows = experiment.spec.min_validation_rows ?? 1;
    // The comparison baseline is fixed and recomputed from the same frozen
    // validation rows; trainers cannot choose or report its score.
    const baselineMae = predictions.length
      ? predictions.reduce((sum, p) => sum + Math.abs(p.actual), 0) / predictions.length
      : null;
    const gates = {
      schema: schemaValid, leakage: leakageValid,
      data_quality: audit.missing_prediction_rate === 0,
      baseline_improvement: Number.isFinite(mae) && Number.isFinite(baselineMae) && mae < baselineMae,
      tests: predictions.length >= minRows
    };
    const result = { verified_by: 'server:walk-forward:v1', run_id: audit.run_id, gates, mae, baseline_mae: baselineMae, sample_size: predictions.length };
    const id = configurationHash({ experiment: req.params.id, protocol: 'walk_forward', run_id: audit.run_id });
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertPrediction = db.prepare(`INSERT INTO model_predictions
        (run_id,player_id,season,week,as_of,status,prediction,lower,upper,active_probability,actual,error,fold_cutoff,is_holdout)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const fold of audit.folds) for (const p of fold.predictions) insertPrediction.run(audit.run_id, String(p.player_id), p.season, p.week,
        p.as_of, p.status, p.prediction ?? null, p.lower ?? null, p.upper ?? null, p.active_probability ?? null, p.actual ?? null, p.error ?? null, fold.cutoff, 0);
      db.prepare(`INSERT INTO model_backtests (id,experiment_id,protocol,started_at,completed_at,status,result_json)
        VALUES (?,?,?,?,?,'completed',?)`).run(id, req.params.id, 'walk_forward', now, now, JSON.stringify(result));
      if (mae != null) db.prepare(`INSERT INTO model_metrics
        (experiment_id,backtest_id,split,metric,value,sample_size,recorded_at) VALUES (?,?, 'validation','mae',?,?,?)`)
        .run(req.params.id, id, mae, predictions.length, now);
      registry.transition(req.params.id, 'completed', { result });
      recordModelAudit(db, req.modelPrincipal, 'backtest.complete', 'backtest', id, result);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ ...db.prepare('SELECT * FROM model_backtests WHERE id=?').get(id), result });
  } catch (e) { next(e); }
});

r.post('/registry/experiments/:id/promote', requireModelPermission('model:promote'), (req, res, next) => {
  try {
    const inputs = db.prepare('SELECT 1 FROM model_experiment_inputs WHERE experiment_id=?').get(req.params.id);
    const backtest = db.prepare(`SELECT 1 FROM model_backtests
      WHERE experiment_id=? AND protocol='walk_forward' AND status='completed'
      AND json_extract(result_json, '$.verified_by')='server:walk-forward:v1'`).get(req.params.id);
    if (!inputs || !backtest) return res.status(409).json({ error: 'promotion requires pinned dataset/features and a completed persisted walk-forward backtest' });
    const out = registry.promote(req.params.id, req.modelPrincipal);
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/registry/experiments/:id/rollback', requireModelPermission('model:promote'), (req, res, next) => {
  try {
    const eligible = db.prepare(`SELECT 1 FROM model_experiment_inputs i JOIN model_backtests b ON b.experiment_id=i.experiment_id
      WHERE i.experiment_id=? AND b.protocol='walk_forward' AND b.status='completed'
      AND json_extract(b.result_json, '$.verified_by')='server:walk-forward:v1'`).get(req.params.id);
    if (!eligible) return res.status(409).json({ error: 'rollback target lacks verified persisted evidence' });
    const out = registry.rollback(req.params.id, req.modelPrincipal);
    res.json(out);
  } catch (e) { next(e); }
});

// Never default to "the first league in the database" — an unresolved league
// context must surface as an explicit error, not a silently wrong scoring/roster
// context (see server/modeling/ARCHITECTURE.md's confirmed active-league defect).
const league = (req, res) => {
  let id;
  try { id = requireLeagueId(req); }
  catch (e) { res.status(e.status ?? 400).json({ error: e.message }); return null; }
  const lg = row('SELECT * FROM leagues WHERE id = ?', id);
  if (!lg) { res.status(404).json({ error: 'no league found for the active league id' }); return null; }
  return lg;
};

const respondError = (res, next, e) => (e.status ? res.status(e.status).json({ error: e.message }) : next(e));

/* ------------------------------------------------------------ projections */

r.get('/projections', (req, res, next) => {
  try {
    const leagueId = requireLeagueId(req);
    const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
    if (!lg) return res.status(404).json({ error: 'no league found for the active league id' });
    const scoring = scoringFor(lg);
    const through = Number(req.query.through) || SEASON - 1;
    const proj = memo(`proj:${through}:${JSON.stringify(scoring)}`, () => buildProjections({ through, scoring }));

    const pos = req.query.position;
    let list = [...proj.values()];
    if (pos) list = list.filter(p => p.position === String(pos).toUpperCase());
    list.sort((a, b) => b.points - a.points);
    res.json({
      through, season: SEASON, count: list.length,
      players: list.slice(0, Number(req.query.limit) || 300)
    });
  } catch (e) { respondError(res, next, e); }
});

/** Full distribution for one player — the percentiles behind a start/sit call. */
r.get('/projections/:playerId', (req, res, next) => {
  try {
    const leagueId = requireLeagueId(req);
    const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
    if (!lg) return res.status(404).json({ error: 'no league found for the active league id' });
    const scoring = scoringFor(lg);
    const through = SEASON - 1;
    const proj = memo(`proj:${through}:${JSON.stringify(scoring)}`, () => buildProjections({ through, scoring }));

    let p = proj.get(Number(req.params.playerId));
    // Fall through the duplicate-row problem the same way the trade engine does.
    if (!p && lg?.payload) {
      const { formatKey } = deriveFormat(lg);
      const assets = assetUniverse(lg, formatKey);
      const resolved = resolvePlayer(req.params.playerId, assets, loadRosters(lg, assets));
      if (resolved) p = proj.get(resolved.id);
    }
    if (!p) return res.status(404).json({ error: 'no projection for this player — he has no usage history' });

    // The season-long distribution stays neutral (mult=1) on purpose — it averages
    // across a whole slate of different opponents, so no single week's Vegas line
    // belongs in it. The *weekly* number is a specific start/sit call for a specific
    // upcoming opponent, which is exactly what game script is for.
    const week = Number(req.query.week) || 1;
    const gs = p.team ? gameScriptFor(p.team, SEASON, week) : null;
    const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
    const weeklyAvail = weeklyAvailability(SEASON, week).get(p.player_id) ?? null;

    const seed = req.query.seed ?? null;
    res.json(withRandomSeed(seed, () => ({
      ...p,
      week,
      seed: seed == null ? null : Number(seed),
      game_script: gs,
      weekly: weeklyDistribution(p, {
        runs: 4000, scoring, mult,
        activeProbability: weeklyAvail?.active_probability ?? 1
      }),
      weekly_availability: weeklyAvail,
      season: (() => { const s = seasonDistribution(p, { runs: 800, scoring }); delete s.samples; return s; })(),
      availability: availability().get(p.player_id) ?? null,
      usage_history: usageFor(p.player_id).slice(0, 20)
    })));
  } catch (e) { respondError(res, next, e); }
});

/* -------------------------------------------------------------- accuracy */

/**
 * How good the model actually is, against the baselines it has to beat.
 * Backtests are run on held-out seasons, with the model rebuilt using only data
 * available before the season it is predicting.
 */
r.get('/accuracy', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON - 1;
    const out = memo(`acc:${season}`, () => {
      const truth = actuals(season);
      if (!truth.size) return { error: `no weekly usage data for ${season} — sync nflverse first` };
      const proj = buildProjections({ through: season - 1 });
      if (!proj.size) return { error: `no usage data before ${season} to build a projection from` };

      // Grade every source on the same player set, or the comparison is meaningless.
      const prior = actuals(season - 1);
      const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
      const t = new Map(ids.map(id => [id, truth.get(id)]));
      const mk = f => new Map(ids.map(id => [id, f(id)]));
      const sources = {
        'Gridiron model': mk(id => proj.get(id).points),
        'Last season points': mk(id => prior.get(id).points),
        'Last season ppg x 17': mk(id => prior.get(id).ppg * 17),
        'Blend (60/40)': mk(id => 0.6 * proj.get(id).points + 0.4 * prior.get(id).points)
      };
      const table = Object.entries(sources)
        .map(([source, preds]) => ({ source, ...gradePoint(preds, t) }))
        .filter(x => !x.error)
        .sort((a, b) => (b.spearman ?? -1) - (a.spearman ?? -1));

      // Distributional accuracy for the model only — the baselines are point estimates.
      const samples = new Map();
      for (const id of ids.slice(0, 150)) {
        const s = seasonDistribution(proj.get(id), { runs: 300 });
        samples.set(id, s.samples);
      }
      return {
        season, players_graded: ids.length, table,
        distribution: gradeDistribution(samples, t),
        weekly_decisions: weeklyDecisionBacktest(proj, truth),
        note: 'Every source is graded on the same players. The model is rebuilt using only seasons before the one it predicts.'
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- simulator */

r.get('/:leagueId/simulate', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!lg.payload) return res.status(400).json({ error: 'league not synced yet' });
    const runs = Math.min(6000, Number(req.query.runs) || 2000);
    const key = `sim:${lg.id}:${runs}:${req.query.from_week ?? 1}`;
    const seed = req.query.seed ?? null;
    res.json(withRandomSeed(seed, () => memo(`${key}:seed:${seed ?? 'random'}`, () => simulateSeason(lg, {
      runs, fromWeek: Number(req.query.from_week) || 1, scoring: scoringFor(lg)
    }))));
  } catch (e) { next(e); }
});

/** Title-odds impact of a specific trade. */
r.post('/:leagueId/trade-impact', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!lg.payload) return res.status(400).json({ error: 'league not synced yet' });
    const { my_team_id, their_team_id, i_give = [], i_get = [] } = req.body ?? {};
    if (!their_team_id) return res.status(400).json({ error: 'their_team_id required' });
    res.json(tradeImpact(lg, {
      myTeamId: my_team_id ?? lg.my_team_id,
      theirTeamId: their_team_id,
      iGive: i_give, iGet: i_get,
      runs: Math.min(3000, Number(req.body?.runs) || 1200),
      fromWeek: Number(req.body?.from_week) || 1,
      seed: req.body?.seed ?? null,
      scoring: scoringFor(lg)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------------- supporting estimates */

r.get('/correlations', (req, res) => res.json(correlationTable()));

r.get('/gamescript', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = req.query.week ? Number(req.query.week) : null;
    const model = rows('SELECT * FROM gamescript_model');
    const lines = linesFor(season, week).map(l => ({
      ...l, ...gameScriptFor(l.team, l.season, l.week)
    }));
    res.json({ season, week, model, lines });
  } catch (e) { next(e); }
});

r.get('/handcuffs', (req, res, next) => {
  try { res.json(memo('handcuffs', () => handcuffValue()).slice(0, Number(req.query.limit) || 60)); }
  catch (e) { next(e); }
});

r.get('/cascade/:playerId', (req, res, next) => {
  try {
    const c = memo('cascades', () => cascades());
    res.json(c.get(Number(req.params.playerId)) ?? { error: 'no measured cascade for this player' });
  } catch (e) { next(e); }
});

r.get('/availability', (req, res, next) => {
  try {
    if (req.query.week) {
      const season = Number(req.query.season) || SEASON;
      const week = Number(req.query.week);
      const a = weeklyAvailability(season, week);
      return res.json({ season, week, players: [...a.values()]
        .sort((x, y) => x.active_probability - y.active_probability).slice(0, 200) });
    }
    const a = memo('avail', () => availability());
    const names = new Map(rows('SELECT id, name, position FROM players').map(p => [p.id, p]));
    res.json([...a.values()].map(x => ({ ...x, name: names.get(x.player_id)?.name }))
      .filter(x => x.name).sort((a, b) => a.available - b.available).slice(0, 120));
  } catch (e) { next(e); }
});

r.get('/status', (req, res) => {
  res.json({
    usage_seasons: usageSeasons(),
    correlations_fitted: row('SELECT COUNT(*) AS n FROM correlation_estimates')?.n ?? 0,
    gamescript_fitted: row('SELECT COUNT(*) AS n FROM gamescript_model')?.n ?? 0,
    lines: rows('SELECT season, COUNT(*) AS n FROM game_lines GROUP BY season ORDER BY season DESC'),
    players_with_gsis: row('SELECT COUNT(*) AS n FROM players WHERE gsis_id IS NOT NULL')?.n ?? 0
  });
});

/* ------------------------------------------------------------------ sync */

/** Pull everything the engine needs and refit every model. */
r.post('/sync', requireModelPermission('model:train'), async (req, res, next) => {
  try {
    const seasons = (req.query.seasons ? String(req.query.seasons).split(',').map(Number)
      : [SEASON - 4, SEASON - 3, SEASON - 2, SEASON - 1]).filter(Boolean);
    const out = { seasons };
    out.nflverse = await syncNflverse(seasons);
    out.historical_lines = await syncHistoricalLines().catch(e => ({ error: e.message }));
    out.current_lines = await syncCurrentLines(SEASON).catch(e => ({ error: e.message }));
    out.gamescript = fitGameScript();
    out.correlations = fitCorrelations().length;
    clearModelCache(); clearMatchupCache(); clearCorrelationCache(); clearGameScriptCache();
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

export default r;
