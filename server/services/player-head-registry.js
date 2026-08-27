/**
 * Candidate player-week heads.
 *
 * A head is a falsifiable view of the same shared event state, not a new source
 * of truth. All inputs are either the structural pregame estimate or outcomes
 * completed before the target week. The registry intentionally includes heads
 * likely to lose; validation decides what survives, not author preference.
 */

const mean = values => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
const quantile = (values, p) => {
  if (!values.length) return null;
  const x = [...values].sort((a, b) => a - b);
  const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return x[lo] + (x[hi] - x[lo]) * (i - lo);
};
const ewma = (values, alpha) => values.reduce((state, x, i) => i ? alpha * x + (1 - alpha) * state : x, values[0]);
const blend = (a, b, weightA) => weightA * a + (1 - weightA) * b;
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export const PLAYER_HEAD_REGISTRY_VERSION = 'player-heads-v1.0.0';
export const PLAYER_HEADS = Object.freeze([
  ['structural', 'Structural hierarchy', 'structural'],
  ['season_mean', 'Season-to-date mean', 'outcome_level'],
  ['last1', 'Last game', 'short_memory'],
  ['last2', 'Last two games', 'short_memory'],
  ['last3', 'Last three games', 'short_memory'],
  ['last5', 'Last five games', 'medium_memory'],
  ['last8', 'Last eight games', 'medium_memory'],
  ['median', 'Prior-game median', 'robust_level'],
  ['trimmed_mean', 'Trimmed prior mean', 'robust_level'],
  ['winsor_mean', 'Winsorized prior mean', 'robust_level'],
  ['ewma_slow', 'Slow EWMA', 'adaptive_level'],
  ['ewma_medium', 'Medium EWMA', 'adaptive_level'],
  ['ewma_fast', 'Fast EWMA', 'adaptive_level'],
  ['linear_trend', 'Eight-game linear trend', 'trend'],
  ['level_shift', 'Recent level-shift detector', 'changepoint'],
  ['structural_75_season_25', 'Structural / season blend 75/25', 'structural_blend'],
  ['structural_50_season_50', 'Structural / season blend 50/50', 'structural_blend'],
  ['structural_75_last3_25', 'Structural / last-three blend', 'structural_blend'],
  ['structural_75_median_25', 'Structural / median blend', 'structural_blend'],
  ['downside_robust', 'Structural / lower-quartile blend', 'distribution_level'],
  ['upside_robust', 'Structural / upper-quartile blend', 'distribution_level'],
  ['role_changepoint', 'Confirmed role-regime adjustment', 'changepoint'],
  ['low_evidence_anchor', 'Low-evidence structural anchor', 'evidence_weighted'],
  ['robust_consensus', 'Diverse robust consensus', 'stacked_baseline']
].map(([id, name, family]) => Object.freeze({
  id, name, family, status: 'candidate',
  cutoff_rule: 'target season/week outcomes excluded; prior completed weeks only'
})));

export function candidatePlayerHeads({ structural, priorWeeks, evidenceGames = 0, roleChange = null } = {}) {
  if (!Number.isFinite(structural)) throw new Error('candidate heads require a finite structural prediction');
  const prior = (priorWeeks ?? []).map(Number).filter(Number.isFinite);
  if (!prior.length) return Object.fromEntries(PLAYER_HEADS.map(h => [h.id, structural]));
  const season = mean(prior), last = n => mean(prior.slice(-n));
  const sorted = [...prior].sort((a, b) => a - b);
  const trimN = prior.length >= 8 ? Math.max(1, Math.floor(prior.length * 0.1)) : 0;
  const trimmed = mean(trimN ? sorted.slice(trimN, -trimN) : sorted);
  const q10 = quantile(prior, 0.1), q25 = quantile(prior, 0.25), q75 = quantile(prior, 0.75), q90 = quantile(prior, 0.9);
  const winsor = mean(prior.map(x => Math.max(q10, Math.min(q90, x))));
  const recent = prior.slice(-8);
  const mx = (recent.length - 1) / 2;
  const my = mean(recent);
  const den = recent.reduce((sum, _, i) => sum + (i - mx) ** 2, 0);
  const slope = den ? recent.reduce((sum, x, i) => sum + (i - mx) * (x - my), 0) / den : 0;
  const trend = Math.max(0, my + slope * (recent.length + 1 - mx));
  const earlier = prior.slice(0, -2), recent2 = last(2);
  const levelRatio = earlier.length && mean(earlier) > 0 ? recent2 / mean(earlier) : 1;
  const shifted = structural * Math.max(0.65, Math.min(1.45, levelRatio));
  const roleRatio = roleChange?.prior_opportunities > 0
    ? roleChange.recent_opportunities / roleChange.prior_opportunities : 1;
  const roleAdjusted = structural * Math.max(0.65, Math.min(1.45, roleRatio));
  const evidenceWeight = Math.max(0.35, Math.min(0.9, evidenceGames / 16));

  return {
    structural,
    season_mean: season,
    last1: prior.at(-1), last2: last(2), last3: last(3), last5: last(5), last8: last(8),
    median: quantile(prior, 0.5), trimmed_mean: trimmed, winsor_mean: winsor,
    ewma_slow: ewma(prior, 0.15), ewma_medium: ewma(prior, 0.35), ewma_fast: ewma(prior, 0.60),
    linear_trend: trend, level_shift: shifted,
    structural_75_season_25: blend(structural, season, 0.75),
    structural_50_season_50: blend(structural, season, 0.50),
    structural_75_last3_25: blend(structural, last(3), 0.75),
    structural_75_median_25: blend(structural, quantile(prior, 0.5), 0.75),
    downside_robust: blend(structural, q25, 0.75),
    upside_robust: blend(structural, q75, 0.75),
    role_changepoint: finite(roleAdjusted, structural),
    low_evidence_anchor: blend(structural, season, evidenceWeight),
    robust_consensus: mean([structural, season, last(3), quantile(prior, 0.5)])
  };
}

export function playerHeadCatalog() {
  return {
    version: PLAYER_HEAD_REGISTRY_VERSION,
    count: PLAYER_HEADS.length,
    heads: PLAYER_HEADS,
    policy: 'Candidates have zero production authority until chronological validation and forward promotion gates pass.'
  };
}
