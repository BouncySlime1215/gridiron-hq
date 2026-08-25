import { createHash } from 'node:crypto';

export const PIPELINE_VERSION = 'gridiron-fantasy-walk-forward@1.0.0';
export const FEATURE_SET_VERSION = 'fantasy-components-asof@1.0.0';

export const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const configurationHash = value => createHash('sha256').update(stableJson(value)).digest('hex');

export function observationKey(row) {
  return `${row.player_id}|${row.season}|${row.week}`;
}

export function assertTimestampedObservation(row) {
  for (const field of ['player_id', 'season', 'week', 'as_of']) {
    if (row[field] == null || row[field] === '') throw new Error(`observation missing ${field}`);
  }
  const asOf = Date.parse(row.as_of);
  if (!Number.isFinite(asOf)) throw new Error('observation as_of must be an ISO timestamp');
  if (row.available_at != null) {
    const availableAt = Date.parse(row.available_at);
    if (!Number.isFinite(availableAt)) throw new Error(`observation available_at is not a valid timestamp for ${observationKey(row)}`);
    if (availableAt > asOf) throw new Error(`future-data leakage: ${observationKey(row)} available after prediction cutoff`);
  }
  for (const [name, feature] of Object.entries(row.features ?? {})) {
    if (feature && typeof feature === 'object' && feature.available_at != null) {
      const featureAt = Date.parse(feature.available_at);
      if (!Number.isFinite(featureAt)) throw new Error(`feature ${name} has an invalid available_at timestamp for ${observationKey(row)}`);
      if (featureAt > asOf) throw new Error(`future-data leakage: feature available after cutoff for ${observationKey(row)}`);
    }
  }
  if (row.outcome != null) {
    // Allow historical datasets to include realized outcomes without an explicit
    // outcome_available_at timestamp (the value is known after the fact). If a
    // timestamp is present, validate it to prevent target leakage (it must be
    // strictly after the prediction cutoff as_of).
    if (row.outcome_available_at != null) {
      const outcomeAt = Date.parse(row.outcome_available_at);
      if (!Number.isFinite(outcomeAt)) throw new Error(`outcome_available_at is not a valid timestamp for ${observationKey(row)}`);
      if (outcomeAt <= asOf) throw new Error(`target leakage: outcome was attached at prediction time for ${observationKey(row)}`);
    }
  }
  return row;
}

export function assertUniqueObservations(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = observationKey(row);
    if (seen.has(key)) throw new Error(`duplicate observation: ${key}`);
    seen.add(key);
  }
  return rows;
}

