/**
 * Passing-yards error attribution.
 *
 * Passing yards is attempts x yards per attempt. A single headline MAE cannot
 * tell us which half is limiting the model, and searching another collection
 * of full-output heads would repeat a candidate family already rejected under
 * Holm correction. This diagnostic asks the component questions separately.
 *
 * Every baseline is walk-forward. A target week's result is appended only
 * after that target week has been scored. The oracle views use the target
 * result only to attribute error; they are explicitly barred from promotion.
 */
import { pairedBootstrapDiff } from './backtest-significance.js';
import { propReplayRows } from './nfl-props.js';

const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const r3 = value => Number.isFinite(value) ? +value.toFixed(3) : null;

export function decomposePassingError({ predictedAttempts, predictedYpa,
  actualAttempts, actualYpa } = {}) {
  const volume = (predictedAttempts - actualAttempts) * predictedYpa;
  const efficiency = actualAttempts * (predictedYpa - actualYpa);
  return {
    volume,
    efficiency,
    total: volume + efficiency,
    exact: Math.abs((volume + efficiency)
      - (predictedAttempts * predictedYpa - actualAttempts * actualYpa)) < 1e-9
  };
}

function score(rows, key) {
  const errors = rows.map(row => Math.abs(row[key] - row.actualYards));
  return { n: errors.length, mae: r3(mean(errors)), errors };
}

function comparison(rows, key) {
  const champion = score(rows, 'modelYards');
  const candidate = score(rows, key);
  return {
    n: rows.length,
    model_mae: champion.mae,
    candidate_mae: candidate.mae,
    delta_mae: r3(candidate.mae - champion.mae),
    bootstrap: pairedBootstrapDiff(champion.errors, candidate.errors,
      { iterations: 2000, seed: 20260827 }),
    production_authority: 0
  };
}

function summarize(rows) {
  const model = score(rows, 'modelYards');
  const baseline = score(rows, 'seasonYards');
  const decompositionRows = rows.filter(row => row.actualAttempts > 0);
  const parts = decompositionRows.map(row => decomposePassingError({
    predictedAttempts: row.modelAttempts,
    predictedYpa: row.modelYpa,
    actualAttempts: row.actualAttempts,
    actualYpa: row.actualYpa
  }));
  const volumeSq = mean(parts.map(part => part.volume ** 2));
  const efficiencySq = mean(parts.map(part => part.efficiency ** 2));
  const covariance = mean(parts.map(part => 2 * part.volume * part.efficiency));
  const totalSq = (volumeSq ?? 0) + (efficiencySq ?? 0) + (covariance ?? 0);

  return {
    n: rows.length,
    model_mae: model.mae,
    season_to_date_yards_mae: baseline.mae,
    component_candidates: {
      replace_attempts_only: comparison(rows, 'priorAttemptsModelYpa'),
      replace_efficiency_only: comparison(rows, 'modelAttemptsPriorYpa'),
      replace_both: comparison(rows, 'priorAttemptsPriorYpa')
    },
    oracle_attribution: {
      n: decompositionRows.length,
      actual_attempts_x_model_ypa_mae: score(decompositionRows, 'actualAttemptsModelYpa').mae,
      model_attempts_x_actual_ypa_mae: score(decompositionRows, 'modelAttemptsActualYpa').mae,
      squared_error_components: {
        volume: r3(volumeSq), efficiency: r3(efficiencySq), covariance: r3(covariance),
        volume_share_before_covariance: r3(volumeSq / Math.max(1e-9, (volumeSq ?? 0) + (efficiencySq ?? 0))),
        efficiency_share_before_covariance: r3(efficiencySq / Math.max(1e-9, (volumeSq ?? 0) + (efficiencySq ?? 0))),
        reconstructed_total: r3(totalSq)
      },
      warning: 'Oracle rows diagnose where misses originate. They use the target outcome and can never be a forecast or promotion candidate.'
    }
  };
}

/**
 * Grade independent passing-volume and passing-efficiency questions on the
 * same pregame-eligible QB weeks used by the production prop gate.
 */
export function passingComponentDiagnostic(seasons = [2022, 2023, 2024, 2025],
  { useCache = true } = {}) {
  const replay = propReplayRows(seasons, { useCache });
  const histories = new Map();
  const gradeable = [];

  for (const row of replay.rows) {
    if (!row.eligibility?.markets?.player_pass_yds) continue;
    const key = `${row.season}|${row.player_id}`;
    const history = histories.get(key) ?? [];
    const modelAttempts = row.broad.pass_attempts;
    const modelYards = row.broad.pass_yds;
    const modelYpa = modelAttempts > 0 ? modelYards / modelAttempts : null;
    const actualAttempts = row.actual.pass_attempts;
    const actualYards = row.actual.pass_yds;
    const actualYpa = actualAttempts > 0 ? actualYards / actualAttempts : null;

    if (history.length >= 2 && Number.isFinite(modelYpa)) {
      const priorAttempts = mean(history.map(game => game.attempts));
      const priorTotalAttempts = history.reduce((sum, game) => sum + game.attempts, 0);
      const priorYpa = priorTotalAttempts > 0
        ? history.reduce((sum, game) => sum + game.yards, 0) / priorTotalAttempts : null;
      const seasonYards = mean(history.map(game => game.yards));
      if ([priorAttempts, priorYpa, seasonYards].every(Number.isFinite)) {
        gradeable.push({
          season: row.season, week: row.week, playerId: row.player_id,
          modelAttempts, modelYpa, modelYards, actualAttempts, actualYpa, actualYards,
          seasonYards,
          priorAttemptsModelYpa: priorAttempts * modelYpa,
          modelAttemptsPriorYpa: modelAttempts * priorYpa,
          priorAttemptsPriorYpa: priorAttempts * priorYpa,
          actualAttemptsModelYpa: actualAttempts * modelYpa,
          modelAttemptsActualYpa: Number.isFinite(actualYpa) ? modelAttempts * actualYpa : null
        });
      }
    }

    // Match the existing baseline: only games with real starting-QB volume
    // become evidence for later weeks. The current game is appended last.
    if (actualAttempts > 10) {
      history.push({ attempts: actualAttempts, yards: actualYards });
      histories.set(key, history);
    }
  }

  const seasonsSeen = [...new Set(gradeable.map(row => row.season))].sort();
  return {
    generated_at: new Date().toISOString(),
    seasons: seasonsSeen,
    pooled: summarize(gradeable),
    by_season: Object.fromEntries(seasonsSeen.map(season =>
      [season, summarize(gradeable.filter(row => row.season === season))])),
    decision_rule: 'Diagnostic only. A component replacement would still need chronological discovery, multiplicity correction, sealed validation, and full-pipeline ablation before gaining authority.',
    next_question: 'Whichever component owns more error must be improved with component-specific pregame evidence; do not add another full-output recency head.'
  };
}

