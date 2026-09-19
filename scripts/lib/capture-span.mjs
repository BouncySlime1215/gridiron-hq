/**
 * Whether one capture was answered by one process.
 *
 * Split out of capture-availability-baseline.mjs so it can be tested. That
 * script is a top-level-await module that runs its capture on import and exits
 * when no token is set, so nothing inside it could be exercised without going
 * to the network — which is how it came to have no test at all.
 *
 * The fact these predicates encode: the memos in routes/model.js and
 * draft-assist.js carry no fit id and no seed, so the only thing that busts
 * them is a restart. A capture that spans one mixes answers from two different
 * cache states, and compared against a baseline that reads as the fit having
 * moved something. The restart would be reported as the finding.
 */

/**
 * Tolerance, not equality. Each health read costs a round trip whose latency
 * lands inside the derived start time, and `uptime_s` is whole seconds, so two
 * readings of the SAME process routinely disagree by a few seconds. A real
 * restart moves the derived start by roughly the length of the capture, which
 * is minutes. A minute separates the two cases with room to spare.
 */
export const RESTART_TOLERANCE_MS = 60000;

/** Compare two process readings taken at the ends of one capture. */
export function processSpan (before, after) {
  if (!before?.read || !after?.read) {
    return { known: false,
      reason: 'the health read failed at one or both ends, so this capture cannot say '
        + 'whether one process answered all of it' };
  }
  const driftMs = Math.abs(Date.parse(after.started_at) - Date.parse(before.started_at));
  return { known: true, same_process: driftMs <= RESTART_TOLERANCE_MS,
    drift_ms: driftMs, tolerance_ms: RESTART_TOLERANCE_MS };
}

/**
 * A one-line verdict, or null when the span is clean.
 *
 * A capture taken before this guard existed has no span at all, and that is a
 * third state rather than a pass: it is not known to be comparable, and saying
 * nothing about it would be the same overstatement the guard exists to remove.
 */
export function spanWarning (span, label) {
  if (!span) return `${label}: no process reading was taken, so its comparability is unestablished`;
  if (!span.known) return `${label}: ${span.reason}`;
  if (!span.same_process) {
    return `${label}: the app restarted mid-capture (derived start moved ${Math.round(span.drift_ms / 1000)}s), `
      + 'so its leagues were not all answered by the same process or the same memo state';
  }
  return null;
}
