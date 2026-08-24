// Minimal in-process background-job framework. Not a queue — this app runs as
// a single Node process with a single SQLite file, so a distributed job
// system would be solving a problem this deployment doesn't have. What it
// does provide, honestly: named recurring jobs with status/last-run/last-error
// visibility and clean cancellation, which is what the Dev Hub's "background
// job status" and the draft engine's server-owned clock actually need.
const jobs = new Map();

/**
 * Registers and immediately starts a recurring job. Calling this again with
 * the same name replaces the previous job (stopping it first) rather than
 * running two copies.
 */
export function registerJob(name, { intervalMs, run }) {
  cancelJob(name);
  const state = {
    name, intervalMs, run,
    status: 'running',
    lastRunAt: null,
    lastError: null,
    runCount: 0,
    timer: null,
  };
  const tick = async () => {
    try {
      await run();
      state.lastError = null;
    } catch (e) {
      state.lastError = e.message;
      console.error(`[jobs] "${name}" failed:`, e.message);
    } finally {
      state.lastRunAt = new Date().toISOString();
      state.runCount++;
    }
  };
  state.timer = setInterval(tick, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  jobs.set(name, state);
  return jobStatus(name);
}

export function cancelJob(name) {
  const state = jobs.get(name);
  if (!state) return false;
  clearInterval(state.timer);
  state.status = 'cancelled';
  jobs.delete(name);
  return true;
}

export function jobStatus(name) {
  const state = jobs.get(name);
  if (!state) return null;
  const { timer, run, ...pub } = state;
  return pub;
}

export function listJobs() {
  return [...jobs.keys()].map(jobStatus);
}
