/**
 * Chronological, multiplicity-aware validation for the player-head registry,
 * applied to prop stats (passing/rushing/receiving yards, receptions) instead
 * of fantasy points.
 *
 * `player-head-validation.js` already built and proved out this exact
 * pipeline — discovery/redundancy pruning/paired sign-flip test/Holm
 * correction/sealed validation — for fantasy points. Reusing its primitives
 * here rather than writing a second copy: they only assume rows shaped
 * `{ candidate_heads: {id: value}, actual }`, which is not fantasy-specific.
 *
 * There is no frozen ensemble "champion" for props the way there is for
 * fantasy points (`weeklyEnsemblePrediction`) — the current production model
 * for every prop stat is just the structural player-week estimate. So
 * `active_champion` here is the `structural` head itself: a candidate only
 * earns anything by beating what actually ships today, not an easier straw
 * baseline.
 */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { playerWeeks } from './nfl-pbp.js';
import { gameScriptFor } from './gamescript.js';
import { buildPlayerWeekEngine, playerWeekProjection, playerWeekEventExpectation } from './player-week-engine.js';
import { candidatePlayerHeads, PLAYER_HEADS, PLAYER_HEAD_REGISTRY_VERSION } from './player-head-registry.js';
import { metrics, correlation, signFlipP, holmDecisions } from './player-head-validation.js';

db.exec(`CREATE TABLE IF NOT EXISTS prop_head_audits (
  spec_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, registry_version TEXT NOT NULL, metric TEXT NOT NULL,
  development_season INTEGER NOT NULL, discovery_season INTEGER NOT NULL,
  validation_season INTEGER, validation_opened INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
)`);

/** Every metric graded here must have real prior-week history to blend against — a volume threshold, not a market gate. */
export const PROP_METRIC_CONFIG = Object.freeze({
  pass_yds: { actualField: 'passing_yards', eventKey: 'passYd', eligible: p => p.volume.attempts > 2 },
  rush_yds: { actualField: 'rushing_yards', eventKey: 'rushYd', eligible: p => p.volume.carries > 0.5 },
  rec_yds: { actualField: 'receiving_yards', eventKey: 'recYd', eligible: p => p.volume.targets > 0.5 },
  receptions: { actualField: 'receptions', eventKey: 'rec', eligible: p => p.volume.targets > 0.5 }
});

function propHeadReplay(metricKey, season) {
  const cfg = PROP_METRIC_CONFIG[metricKey];
  if (!cfg) throw new Error(`unknown prop metric for head validation: ${metricKey}`);
  const history = new Map(); // player_id -> prior actual values this season, chronological
  const out = [];
  const actualWeeks = playerWeeks(season).filter(p => p.week >= 2);
  for (const week of [...new Set(actualWeeks.map(p => p.week))].sort((a, b) => a - b)) {
    const engine = buildPlayerWeekEngine({ season, week });
    for (const actual of actualWeeks.filter(p => p.week === week)) {
      const projection = playerWeekProjection(engine, actual.player_id);
      if (!projection) continue;
      const gs = gameScriptFor(actual.team, season, week);
      const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
      const p = playerWeekEventExpectation(projection, { mult });
      const eligible = cfg.eligible(p);
      const actualValue = actual.features[cfg.actualField] ?? 0;
      const hist = history.get(actual.player_id) ?? [];

      if (eligible && hist.length > 0) {
        const structural = p.events[cfg.eventKey];
        const candidateHeads = candidatePlayerHeads({ structural, priorWeeks: hist, evidenceGames: hist.length });
        candidateHeads.active_champion = structural;
        out.push({ season, week, player_id: actual.player_id, position: projection.position,
          candidate_heads: candidateHeads, actual: actualValue });
      }
      if (eligible) { hist.push(actualValue); history.set(actual.player_id, hist); }
    }
  }
  return out;
}

/**
 * Validation is closed by default, same discipline as `auditPlayerHeads`:
 * opening it is explicit and persisted against a spec hash so the same
 * architecture cannot quietly reopen 2025 after every tweak.
 */
export function auditPropHeads(metricKey, {
  developmentSeason = 2023, discoverySeason = 2024, validationSeason = 2025,
  openValidation = false, redundancy = 0.985, minN = 250, alpha = 0.05,
  persist = true
} = {}) {
  if (!PROP_METRIC_CONFIG[metricKey]) throw new Error(`unknown prop metric for head validation: ${metricKey}`);
  const spec = { registry: PLAYER_HEAD_REGISTRY_VERSION, metric: metricKey, developmentSeason, discoverySeason,
    validationSeason, redundancy, minN, alpha, baseline: 'active_champion', heads: PLAYER_HEADS.map(x => x.id) };
  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const prior = rows('SELECT * FROM prop_head_audits WHERE spec_hash=?', specHash)[0];
  if (prior && (!openValidation || prior.validation_opened)) return JSON.parse(prior.result_json);

  const development = propHeadReplay(metricKey, developmentSeason);
  const discovery = propHeadReplay(metricKey, discoverySeason);
  const candidates = PLAYER_HEADS.map(head => ({ head, development: metrics(development, head.id),
    discovery: metrics(discovery, head.id) }));
  const champion = {
    head: { id: 'active_champion', name: 'Current production model (structural estimate)' },
    development: metrics(development, 'active_champion'),
    discovery: metrics(discovery, 'active_champion')
  };

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
    const holdout = propHeadReplay(metricKey, validationSeason);
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
    spec_hash: specHash, spec, metric: metricKey, validation_opened: openValidation,
    baseline: { id: 'active_champion', development: champion.development, discovery: champion.discovery },
    candidates_tested: tested.length, candidates_redundant: redundant.length,
    redundant, discovery: tested, survivors: survivors.map(x => x.head.id), validation,
    production_eligible: false,
    note: 'Historical validation can establish forecast quality, not betting profitability. Production requires real priced forward shadow decisions and positive CLV.'
  };
  if (persist) run(`INSERT INTO prop_head_audits
    (spec_hash,created_at,registry_version,metric,development_season,discovery_season,validation_season,validation_opened,result_json)
    VALUES (?,datetime('now'),?,?,?,?,?,?,?)
    ON CONFLICT(spec_hash) DO UPDATE SET validation_opened=MAX(validation_opened,excluded.validation_opened),result_json=excluded.result_json`,
  specHash, PLAYER_HEAD_REGISTRY_VERSION, metricKey, developmentSeason, discoverySeason,
  validationSeason, openValidation ? 1 : 0, JSON.stringify(result));
  return result;
}

export function propHeadAuditHistory(metricKey = null) {
  const where = metricKey ? 'WHERE metric=?' : '';
  const args = metricKey ? [metricKey] : [];
  return rows(`SELECT spec_hash,created_at,registry_version,metric,development_season,discovery_season,
                      validation_season,validation_opened,result_json
               FROM prop_head_audits ${where} ORDER BY created_at DESC`, ...args)
    .map(x => ({ ...x, result: JSON.parse(x.result_json), result_json: undefined }));
}
