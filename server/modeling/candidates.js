import { shrink } from '../services/stats-util.js';

/**
 * Feature contract the volume_efficiency candidate expects. Datasets/feature
 * versions are caller-supplied (see POST /registry/features) — this is the
 * canonical definition for that candidate, exposed via GET /registry/candidates
 * so Model Lab can show it verbatim instead of a hand-maintained UI copy.
 *
 * `weather` is listed because Phase 1 of the prediction engine calls for
 * temperature/precipitation/wind as candidate inputs, but no licensed weather
 * provider is wired up yet (server/platform/providers.js defines the adapter
 * contract, not an implementation). It is marked unavailable rather than
 * omitted, so nothing downstream can mistake its absence for "not needed" or
 * silently treat a null as a zero-impact observation.
 */
export const FANTASY_FEATURE_CONTRACT = {
  name: 'fantasy-volume-efficiency-inputs',
  version: '1',
  features: {
    position: {
      type: 'string', enum: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'], required: true,
      description: 'Player position at the time of the observation.'
    },
    expected_opportunities: {
      type: 'number', minimum: 0, required: true,
      description: 'Share-weighted expected touches (targets or carries), computed only from information available before as_of.'
    },
    weather: {
      type: 'object', required: false, available: false, status: 'unavailable',
      unavailable_reason: 'No licensed weather provider is connected (server/platform/providers.js defines the ' +
        'adapter contract, not an implementation). Declared for forward compatibility only — must never be ' +
        'populated with placeholder or estimated values.',
      properties: {
        temperature_f: { type: 'number' },
        precipitation_probability: { type: 'number' },
        wind_mph: { type: 'number' }
      }
    }
  }
};

function meanBaseline() {
  return {
    name: 'mean_baseline', version: '1',
    fit(training) {
      const values = training.map(x => Number(x.outcome)).filter(Number.isFinite);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return { predict: () => ({ prediction: mean }) };
    }
  };
}

/**
 * Position-aware volume x efficiency candidate. Same opportunity-times-conversion
 * shrinkage technique as the live engine in server/services/projections.js — regress
 * per-opportunity efficiency toward a league prior in proportion to sample size — but
 * expressed purely over the generic observation contract (features + outcome) so it
 * runs inside the walk-forward auditor's temporal-isolation guarantees instead of
 * reaching into the live database at an arbitrary cutoff the auditor doesn't control.
 */
function volumeEfficiency() {
  const EFFICIENCY_PRIOR_STRENGTH = 40; // effective opportunities before the position rate dominates the league prior
  return {
    name: 'volume_efficiency', version: '1',
    fit(training) {
      const byPosition = new Map();
      let totalOpportunities = 0, totalOutcome = 0;
      for (const observation of training) {
        const opportunities = Number(observation.features?.expected_opportunities);
        const outcome = Number(observation.outcome);
        if (!Number.isFinite(opportunities) || opportunities <= 0 || !Number.isFinite(outcome)) continue;
        totalOpportunities += opportunities; totalOutcome += outcome;
        const position = String(observation.features?.position ?? 'UNK');
        const bucket = byPosition.get(position) ?? { opportunities: 0, outcome: 0 };
        bucket.opportunities += opportunities; bucket.outcome += outcome;
        byPosition.set(position, bucket);
      }
      const leagueEfficiency = totalOpportunities > 0 ? totalOutcome / totalOpportunities : 0;
      const positionEfficiency = new Map([...byPosition].map(([position, bucket]) => [position,
        shrink(bucket.opportunities > 0 ? bucket.outcome / bucket.opportunities : leagueEfficiency,
          leagueEfficiency, bucket.opportunities, EFFICIENCY_PRIOR_STRENGTH)]));
      return {
        predict(features) {
          const opportunities = Number(features?.expected_opportunities);
          if (!Number.isFinite(opportunities) || opportunities < 0) throw new Error('expected_opportunities feature required');
          const position = String(features?.position ?? 'UNK');
          const efficiency = positionEfficiency.get(position) ?? leagueEfficiency;
          return { prediction: opportunities * efficiency };
        }
      };
    }
  };
}

export const CANDIDATES = { mean_baseline: meanBaseline, volume_efficiency: volumeEfficiency };
