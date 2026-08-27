/**
 * Frozen Stage 1.3 weekly ensemble.
 *
 * Weights were fit on 2023 only, architecture selected on 2024, and evaluated
 * once on 2025. They are deliberately convex: no head can be leveraged into an
 * unstable extrapolation, and every prediction remains interpretable.
 */
export const WEEKLY_ROLE_RECENCY = Object.freeze({ seasonDecay: 0.05, weekHalfLife: 5 });
export const WEEKLY_ENSEMBLE_HEADS = Object.freeze([
  'structural', 'season_to_date', 'last3', 'last1', 'median'
]);
export const WEEKLY_ENSEMBLE_WEIGHTS = Object.freeze({
  QB: Object.freeze([0.40, 0.45, 0.00, 0.10, 0.05]),
  RB: Object.freeze([0.50, 0.20, 0.10, 0.15, 0.05]),
  WR: Object.freeze([0.60, 0.00, 0.00, 0.10, 0.30]),
  TE: Object.freeze([0.80, 0.20, 0.00, 0.00, 0.00])
});

export function weeklyEnsemblePrediction(context, weightSet = WEEKLY_ENSEMBLE_WEIGHTS) {
  const weights = weightSet[context.position];
  if (!weights) return context.structural;
  return WEEKLY_ENSEMBLE_HEADS.reduce((sum, head, index) => {
    const value = Number(context[head]);
    return sum + weights[index] * (Number.isFinite(value) ? value : context.structural);
  }, 0);
}

export function weeklyEnsembleContext({ structural, priorWeeks, position }) {
  if (!priorWeeks?.length) return null;
  const ordered = [...priorWeeks].sort((a, b) => a - b);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    structural,
    season_to_date: mean(priorWeeks),
    last3: mean(priorWeeks.slice(-3)),
    last1: priorWeeks.at(-1),
    median: ordered[Math.floor(ordered.length / 2)],
    position
  };
}
