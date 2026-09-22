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

/**
 * Whether one health read outlived the process that answered it.
 *
 * Fly's edge holds a request against a machine that is going down and replays
 * it into the machine that comes up, so a read issued before a restart can be
 * answered after one, with a 200 and no sign of what happened. The tell is in
 * the response itself: if the process reports less uptime than the request
 * spent in flight, it did not exist when the request was sent. That makes a
 * single read prove its own validity, with nothing to compare it against —
 * which matters because the bracket below can only catch a restart BETWEEN two
 * reads, never one inside a single slow one.
 *
 * Both are needed, and they catch different things. Keep both.
 */
export function readCrossedRestart (uptimeS, elapsedMs) {
  if (!Number.isFinite(uptimeS) || !Number.isFinite(elapsedMs)) return false;
  // `uptime_s` is rounded to whole seconds (server/platform/health.js:45), so a
  // read that took 900ms against a process 1s old is not evidence of anything.
  // Only a process strictly younger than the request's own flight time is.
  return uptimeS * 1000 < elapsedMs - 1000;
}

/** Compare two process readings taken at the ends of one capture. */
export function processSpan (before, after) {
  // A crossed read is checked FIRST, and deliberately reports `known: true`.
  // A reading whose own response proves a restart happened during it is not a
  // failed reading — it is a successful detection, and the strongest one this
  // module produces. Ordering it after the `read` check below would file it as
  // "could not tell", which is the opposite of what it established.
  if (before?.crossed_restart === true || after?.crossed_restart === true) {
    return { known: true, same_process: false, crossed_restart: true,
      drift_ms: null, tolerance_ms: RESTART_TOLERANCE_MS };
  }
  if (!before?.read || !after?.read) {
    return { known: false,
      reason: 'the health read failed at one or both ends, so this capture cannot say '
        + 'whether one process answered all of it' };
  }
  const driftMs = Math.abs(Date.parse(after.started_at) - Date.parse(before.started_at));
  return { known: true, same_process: driftMs <= RESTART_TOLERANCE_MS,
    crossed_restart: false, drift_ms: driftMs, tolerance_ms: RESTART_TOLERANCE_MS };
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
  // Before the generic "could not tell", because this one did tell.
  if (span.crossed_restart) {
    return `${label}: a health read was answered by a process younger than the request itself, `
      + 'so the app restarted while that read was in flight';
  }
  if (!span.known) return `${label}: ${span.reason}`;
  if (!span.same_process) {
    return `${label}: the app restarted mid-capture (derived start moved ${Math.round(span.drift_ms / 1000)}s), `
      + 'so its leagues were not all answered by the same process or the same memo state';
  }
  return null;
}
