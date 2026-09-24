/**
 * REPRO-01: the campaign producer's one run clock.
 *
 * Every "what time is it" question the producer asks about the WORLD (which offers
 * count as this week's, how many days are left in the week, when a "not now" skip
 * fades, when to send, whether a --tick is due, which timing rows are old enough to
 * read) is answered by one clock fixed at the start of the run. `--as-of <ISO>`
 * pins it; without it the clock is the wall clock read ONCE at start, so a run
 * behaves as before and records the moment it planned for (`_run.inputs.run.as_of`).
 *
 * Elapsed time (runtime_ms, phases_ms, log seconds) is not a world question: it is
 * measured with `stopwatch` (performance.now, monotonic) and is excluded from any
 * reproducibility comparison.
 *
 * Pure except for the one wall-clock read in runClock() when no as-of is given.
 */
import { performance } from 'node:perf_hooks';

/** Parse an --as-of value: an ISO date or date-time. Throws on anything else. */
export function parseAsOf(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
    throw new Error(`--as-of: expected an ISO date or date-time, got "${s}"`);
  }
  const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) || s.length === 10;
  const ms = Date.parse(zoned ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) throw new Error(`--as-of: "${s}" is not a real date`);
  return ms;
}

/**
 * The run clock. asOf: ISO string or null (null = the wall clock, read once, now).
 * Returns { ms, iso, explicit, now() }: now() always returns the same instant.
 */
export function runClock(asOf = null, wallMs = null) {
  const explicit = asOf != null;
  // The one wall-clock read: only when no --as-of was given (default behaviour).
  const ms = explicit ? parseAsOf(asOf) : (wallMs ?? Date.now());
  const iso = new Date(ms).toISOString();
  return Object.freeze({ ms, iso, explicit, now: () => ms });
}

/** Elapsed-time clock (ms, monotonic). For timing fields and logs only, never for the world. */
export const stopwatch = () => performance.now();
