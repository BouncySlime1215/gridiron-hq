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


/* ------------------------------------------------------------------------
 * FINAL ORDER #3 (2026-09-16, RUNBOOK §10.3): point-in-time admission for the
 * NFL betting path.
 *
 * `assertTimestampedObservation` above is the FANTASY walk-forward guard: it
 * keys on `player_id|season|week` and assumes the caller already attached
 * `as_of`/`available_at`. The NFL betting path consumes five raw tables that
 * carry no such envelope, and a map of them on 2026-09-16 found that four of
 * the five have no publication clock of any kind:
 *
 *   nfl_injuries            modified_at   (nflverse publication time)
 *   nfl_depth               captured      (our own receipt clock)
 *   nfl_team_week_features  -- none --
 *   nfl_snaps               -- none --
 *   nfl_pfr_adv             -- none --
 *
 * MEASURED, same day, and the reason this guard exists: `nfl_injuries.modified_at`
 * is populated for 100% of 2021-2022 rows, 97.4% of 2023, 95.8% of 2024, and
 * **0% of 2025 (5,783 rows) and 2026 (182 rows)** -- nflverse stopped
 * publishing it. A path that silently treats a missing clock as "fine" is
 * therefore not doing point-in-time reconstruction for the current season at
 * all; it is reading today's injury table and pretending it is last week's.
 *
 * The admission regimes mirror `research/betting/nfl/injury_admission.py`
 * exactly, so the JS and Python sides cannot drift:
 *   - `observed`          a row we received before the cutoff by our own
 *                         receipt clock (nfl_depth.captured).
 *   - `unmodified_since`  a current-state row last modified before the cutoff.
 *                         Admissible, but NOT an archived version: nothing
 *                         proves what it said before that modification, only
 *                         that nothing has changed it since. Silent the moment
 *                         the source stops maintaining the column -- which is
 *                         precisely what nflverse did in 2025.
 *   - `none`              no clock exists. Admissible only for cutoffs before
 *                         STRICT_CLOCK_FROM, and refused after it.
 * ---------------------------------------------------------------------- */

/** Tables the NFL betting path reads, and the clock each one actually has. */
export const NFL_OBSERVATION_CLOCKS = {
  nfl_injuries: { column: 'modified_at', regime: 'unmodified_since' },
  nfl_depth: { column: 'captured', regime: 'observed' },
  nfl_team_week_features: { column: null, regime: 'none' },
  nfl_snaps: { column: null, regime: 'none' },
  nfl_pfr_adv: { column: null, regime: 'none' }
};

/**
 * Cutoffs at or after this date must have a real clock. Before it, the
 * clockless tables are grandfathered: the historical research in this
 * repository was built on them and re-deriving it is a separate project, but
 * nothing NEW may claim point-in-time discipline it cannot support.
 */
export const STRICT_CLOCK_FROM = '2025-01-01';

/**
 * STRICT on purpose. `Date.parse` is not usable here: it reads `'week 4'` as
 * 2001-04-01 and `'4'` as 2001-04-01 too, so a garbage clock value would be
 * silently admitted as a very OLD timestamp -- i.e. as maximally trustworthy,
 * the worst possible failure for a leakage guard. It also reads
 * `'2023-09-28 12:00:00'` as LOCAL time, which can move a row across a cutoff
 * by hours depending on where the process runs.
 *
 * So: an explicit ISO-8601 instant with an explicit timezone, or nothing.
 * This mirrors `injury_admission.timestamp()` on the Python side, which
 * likewise returns None when `tzinfo` is absent. Both production columns
 * (`nfl_injuries.modified_at`, `nfl_depth.captured`) are already written in
 * exactly this shape, verified against the real database 2026-09-16.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const parseClock = value => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return NaN;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : NaN;   // NaN distinguishes "malformed" from "absent"
};

/**
 * Decide whether one raw row may be used to predict something as of `cutoffAt`.
 * Returns `{ admitted: true, regime, knownAt }` or
 * `{ admitted: false, reason }` -- it does NOT throw, because the callers that
 * matter need to COUNT refusals across a replay rather than die on the first
 * one. `assertPointInTimeRow` below is the throwing wrapper for paths (the
 * blind-audit freeze) where a single leaked row should stop the run.
 */
export function admitPointInTimeRow(row, { table, cutoffAt, strictFrom = STRICT_CLOCK_FROM } = {}) {
  const spec = NFL_OBSERVATION_CLOCKS[table];
  if (!spec) return { admitted: false, reason: `unknown table '${table}' -- add it to NFL_OBSERVATION_CLOCKS` };
  const cutoff = parseClock(cutoffAt);
  if (cutoff == null || Number.isNaN(cutoff)) {
    return { admitted: false, reason: 'a parseable cutoff timestamp is required' };
  }
  const strict = Date.parse(strictFrom);

  if (spec.regime === 'none') {
    if (cutoff >= strict) {
      return { admitted: false, reason: `${table} has no publication clock; refused for cutoffs at or after ${strictFrom}` };
    }
    return { admitted: true, regime: 'none_grandfathered', knownAt: null };
  }

  const clock = parseClock(row?.[spec.column]);
  if (clock == null) {
    if (cutoff >= strict) {
      return { admitted: false, reason: `${table}.${spec.column} is missing; refused for cutoffs at or after ${strictFrom}` };
    }
    return { admitted: false, reason: `${table}.${spec.column} is missing` };
  }
  if (Number.isNaN(clock)) return { admitted: false, reason: `${table}.${spec.column} is not a parseable timestamp` };
  if (clock > cutoff) return { admitted: false, reason: `${table}.${spec.column} is after the cutoff` };
  return { admitted: true, regime: spec.regime, knownAt: new Date(clock).toISOString() };
}

/** Throwing wrapper, for paths where one leaked row must stop the run. */
export function assertPointInTimeRow(row, options) {
  const verdict = admitPointInTimeRow(row, options);
  if (!verdict.admitted) throw new Error(`point-in-time refusal: ${verdict.reason}`);
  return row;
}

/**
 * Admit a batch and report what was refused and why. The counts are the point:
 * a replay that silently drops rows is indistinguishable from one with no data.
 */
export function admitPointInTimeRows(rows, options) {
  const admitted = [], refusedBy = {};
  for (const row of rows ?? []) {
    const verdict = admitPointInTimeRow(row, options);
    if (verdict.admitted) admitted.push(row);
    else refusedBy[verdict.reason] = (refusedBy[verdict.reason] ?? 0) + 1;
  }
  return { admitted, refused: (rows?.length ?? 0) - admitted.length, refused_by: refusedBy };
}
