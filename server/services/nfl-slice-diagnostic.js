/**
 * Accuracy and calibration by slice.
 *
 * One aggregate hit rate hides where a model is actually right. The plan
 * (Priority 1) asks for the council's record cut by season, week, matchup
 * type, market, specialist, confidence bucket and data-coverage bucket, with
 * 2021 quarantined: its expert rows were captured with missing fields and
 * cannot be read as evidence until those are genuinely repaired.
 *
 * Source: the immutable weekly expert rows the historical diagnostic wrote
 * (`nfl_weekly_expert_examples`), joined to game_lines for the matchup facts.
 * Every slice reports its sample next to its rate, and a slice below the read
 * floor is marked so a small-sample number cannot become a sentence.
 */
import { rows } from '../db/index.js';
import { NFL_EXPERTS } from './nfl-expert-council.js';

export const QUARANTINED_SEASONS = Object.freeze([2021]);
export const MIN_SLICE_SAMPLE = 30;

const r3 = value => (Number.isFinite(value) ? +value.toFixed(3) : null);
const r4 = value => (Number.isFinite(value) ? +value.toFixed(4) : null);

/** Normal CDF, for the probability a forecast residual implies for its own direction. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function matchupType(game) {
  if (!game) return 'unknown';
  const spread = Math.abs(Number(game.spread ?? 0));
  const size = spread <= 3 ? 'pickem_to_3' : spread <= 7 ? 'mid_3.5_to_7' : 'big_over_7';
  return `${game.div_game ? 'divisional' : 'non_divisional'}·${size}`;
}

function roofType(game) {
  if (!game?.roof) return 'unknown_roof';
  return /dome|closed/i.test(game.roof) ? 'indoor' : 'outdoor';
}

function confidenceBucket(row) {
  const forecast = Math.abs(Number(row.forecast_residual));
  if (!Number.isFinite(forecast)) return 'no_forecast';
  if (Number.isFinite(row.uncertainty) && row.uncertainty > 0) {
    const z = forecast / row.uncertainty;
    return z < 0.25 ? 'z_under_0.25' : z < 0.5 ? 'z_0.25_to_0.5' : z < 1 ? 'z_0.5_to_1' : 'z_over_1';
  }
  return forecast < 1 ? 'pts_under_1' : forecast < 3 ? 'pts_1_to_3' : 'pts_over_3';
}

function coverageBucket(observedCount) {
  return observedCount <= 7 ? 'coverage_7_or_fewer' : observedCount <= 9 ? 'coverage_8_to_9' : 'coverage_10_plus';
}

function summarize(list) {
  const directional = list.filter(row => row.directional_correct != null);
  const correct = directional.filter(row => Number(row.directional_correct) === 1).length;
  const errors = list.map(row => row.squared_error).filter(Number.isFinite);
  const observed = list.filter(row => Number(row.observed) === 1).length;
  return { rows: list.length, observed, coverage: list.length ? r4(observed / list.length) : null,
    directional_calls: directional.length,
    directional_rate: directional.length ? r4(correct / directional.length) : null,
    rmse: errors.length ? r3(Math.sqrt(errors.reduce((sum, value) => sum + value, 0) / errors.length)) : null,
    readable: directional.length >= MIN_SLICE_SAMPLE };
}

function groupBy(list, keyFn) {
  const groups = new Map();
  for (const row of list) {
    const key = keyFn(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row); groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, ...summarize(items) }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
}

/**
 * Calibration: bucket each observed forecast by the probability it implies for
 * its own direction, P = Φ(|forecast| / uncertainty), and compare with how
 * often that direction was right. A calibrated specialist's 60% bucket is right
 * about 60% of the time.
 */
function calibration(list) {
  const priced = list.filter(row => Number(row.observed) === 1 && row.directional_correct != null
    && Number.isFinite(row.forecast_residual) && Number.isFinite(row.uncertainty) && row.uncertainty > 0);
  const buckets = new Map();
  for (const row of priced) {
    const p = normalCdf(Math.abs(row.forecast_residual) / row.uncertainty);
    const key = p < 0.55 ? '50-55%' : p < 0.6 ? '55-60%' : p < 0.7 ? '60-70%' : p < 0.8 ? '70-80%' : '80%+';
    const bucket = buckets.get(key) ?? { key, n: 0, implied_sum: 0, correct: 0 };
    bucket.n++; bucket.implied_sum += p; bucket.correct += Number(row.directional_correct) === 1 ? 1 : 0;
    buckets.set(key, bucket);
  }
  const out = [...buckets.values()].map(bucket => ({ bucket: bucket.key, n: bucket.n,
    implied: r4(bucket.implied_sum / bucket.n), empirical: r4(bucket.correct / bucket.n),
    gap: r4(bucket.correct / bucket.n - bucket.implied_sum / bucket.n), readable: bucket.n >= MIN_SLICE_SAMPLE }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  const weighted = out.reduce((sum, bucket) => sum + Math.abs(bucket.gap ?? 0) * bucket.n, 0);
  return { buckets: out, expected_calibration_error: priced.length ? r4(weighted / priced.length) : null, n: priced.length };
}

export function sliceDiagnostic({ auditRunId = null, includeQuarantined = false } = {}) {
  const runId = auditRunId ?? rows('SELECT MAX(audit_run_id) id FROM nfl_weekly_expert_examples')[0]?.id ?? null;
  if (runId == null) return { available: false, reason: 'no historical diagnostic rows recorded yet' };
  const all = rows(`SELECT e.season,e.week,e.home,e.away,e.expert_id,e.observed,e.forecast_residual,e.uncertainty,
      e.actual_residual,e.directional_correct,e.squared_error,
      g.spread,g.div_game,g.roof,g.neutral_site
    FROM nfl_weekly_expert_examples e
    LEFT JOIN game_lines g ON g.season=e.season AND g.week=e.week AND g.team=e.home AND g.home=1
    WHERE e.audit_run_id=?`, runId);
  const quarantined = all.filter(row => QUARANTINED_SEASONS.includes(Number(row.season)));
  const usable = includeQuarantined ? all : all.filter(row => !QUARANTINED_SEASONS.includes(Number(row.season)));
  const observedPerGame = new Map();
  for (const row of usable) {
    if (row.expert_id === 'coordinator' || row.expert_id === 'combined_decision') continue;
    const key = `${row.season}|${row.week}|${row.home}`;
    observedPerGame.set(key, (observedPerGame.get(key) ?? 0) + (Number(row.observed) === 1 ? 1 : 0));
  }
  const specialists = usable.filter(row => NFL_EXPERTS.some(expert => expert.id === row.expert_id));
  const coordinator = usable.filter(row => row.expert_id === 'coordinator');
  const withGame = row => ({ ...row, coverage_bucket: coverageBucket(observedPerGame.get(`${row.season}|${row.week}|${row.home}`) ?? 0) });
  const spec = specialists.map(withGame), coord = coordinator.map(withGame);
  const games = new Set(usable.map(row => `${row.season}|${row.week}|${row.home}`)).size;
  return {
    available: true, audit_run_id: runId, games, rows: usable.length,
    quarantine: { seasons: QUARANTINED_SEASONS, rows_excluded: includeQuarantined ? 0 : quarantined.length,
      reason: '2021 expert rows were captured with missing fields; they are not evidence until repaired.' },
    market: { spread: summarize(coord), totals: { rows: 0, note: 'the council forecasts the spread residual only; totals are graded in the replay ledger, not here' } },
    by_season: groupBy(coord, row => row.season),
    by_week: groupBy(coord, row => row.week),
    by_matchup_type: groupBy(coord, row => matchupType(row)),
    by_roof: groupBy(coord, row => roofType(row)),
    by_specialist: NFL_EXPERTS.map(expert => ({ id: expert.id, name: expert.name, lifecycle: expert.lifecycle,
      ...summarize(spec.filter(row => row.expert_id === expert.id)),
      by_season: groupBy(spec.filter(row => row.expert_id === expert.id), row => row.season),
      calibration: calibration(spec.filter(row => row.expert_id === expert.id)) })),
    by_confidence_bucket: groupBy(coord.filter(row => Number(row.observed) === 1), row => confidenceBucket(row)),
    by_coverage_bucket: groupBy(coord, row => row.coverage_bucket),
    coordinator_calibration: calibration(coord),
    read_floor: MIN_SLICE_SAMPLE,
    rule: 'Every slice shows its sample; `readable` is false under the floor and such a rate must not be quoted. ' +
      'Coordinator rows are the combined decision; specialist rows are raw opinions. Nothing here promotes a policy.'
  };
}
