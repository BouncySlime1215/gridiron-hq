/**
 * HEALTH-01a, folded into the spine (ENGINE-ARCHITECTURE.md §2.4, D15).
 *
 * A field declares invariant check ids; `writeState` runs them on every row. A failed
 * row is written (kept for the audit) with health.status = 'failed' and is never served:
 * `getState` skips it and the reader serves the last good row or the fallback field.
 *
 * Check ids:
 *   no_nan               no NaN / Infinity anywhere in the value (always run)
 *   prob_unit            every probability is in [0, 1] (the value, or every number in it)
 *   probs_sum_1          the numbers of an object/array (or value.probs) sum to 1 (+-1e-6)
 *   quantiles_ordered    an array (or value.v of a dist) is non-decreasing
 *   sum_to:<target>      the numbers (or value.probs) sum to <target> (+-1e-6)
 *   in_range:<lo>:<hi>   every number is in [lo, hi]
 * Unknown check ids throw at registration, never silently pass.
 */
const EPS = 1e-6;

function numbersIn(value) {
  if (typeof value === 'number') return [value];
  if (value == null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(numbersIn);
}
const topNumbers = v => {
  const src = v && typeof v === 'object' && !Array.isArray(v) && v.probs && typeof v.probs === 'object' ? v.probs : v;
  if (Array.isArray(src)) return src.filter(x => typeof x === 'number');
  if (src && typeof src === 'object') return Object.values(src).filter(x => typeof x === 'number');
  return typeof src === 'number' ? [src] : [];
};
const sum = xs => xs.reduce((a, b) => a + b, 0);

const CHECKS = {
  no_nan: v => {
    const bad = numbersIn(v).find(x => !Number.isFinite(x));
    return bad === undefined ? null : `non-finite number ${bad}`;
  },
  prob_unit: v => {
    const bad = numbersIn(v).find(x => !(x >= 0 && x <= 1));
    return bad === undefined ? null : `probability ${bad} outside [0, 1]`;
  },
  probs_sum_1: v => {
    const s = sum(topNumbers(v));
    return Math.abs(s - 1) <= EPS ? null : `probabilities sum to ${s}, not 1`;
  },
  quantiles_ordered: v => {
    const q = Array.isArray(v) ? v : Array.isArray(v?.v) ? v.v : null;
    if (!q) return 'no quantile array';
    for (let i = 1; i < q.length; i++) if (!(q[i] >= q[i - 1])) return `quantile ${i} (${q[i]}) below quantile ${i - 1} (${q[i - 1]})`;
    return null;
  },
};
const PARAMETRIC = {
  sum_to: ([target]) => {
    const t = Number(target);
    if (!Number.isFinite(t)) throw new Error(`sum_to needs a number, got ${target}`);
    return v => { const s = sum(topNumbers(v)); return Math.abs(s - t) <= EPS ? null : `sums to ${s}, not ${t}`; };
  },
  in_range: ([lo, hi]) => {
    const a = Number(lo); const b = Number(hi);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`in_range needs lo:hi, got ${lo}:${hi}`);
    return v => { const bad = numbersIn(v).find(x => !(x >= a && x <= b)); return bad === undefined ? null : `${bad} outside [${a}, ${b}]`; };
  },
};

/** The check function for an id, or throws for an unknown id. */
export function checkFor(id) {
  if (CHECKS[id]) return CHECKS[id];
  const [name, ...args] = String(id).split(':');
  if (PARAMETRIC[name]) return PARAMETRIC[name](args);
  throw new Error(`unknown health check "${id}"`);
}

/** Validates a list of check ids (at registration). */
export function assertCheckIds(ids) {
  if (!Array.isArray(ids)) throw new Error('checks must be an array of check ids');
  for (const id of ids) checkFor(id);
}

const RANK = { ok: 0, thin: 1, degraded: 2, failed: 3 };
/** The worst of several health statuses ('ok' < 'thin' < 'degraded' < 'failed'). */
export function worstHealth(statuses) {
  return statuses.reduce((w, s) => ((RANK[s] ?? 0) > (RANK[w] ?? 0) ? s : w), 'ok');
}

/**
 * Run `checkIds` (plus no_nan, always) on a value. A null value (typed absence) passes
 * every check: absence is not a failure. Returns {status: 'ok'|'failed', checks:[{id, passed, detail}]}.
 */
export function runChecks(value, checkIds = []) {
  const ids = ['no_nan', ...checkIds.filter(id => id !== 'no_nan')];
  const checks = ids.map(id => {
    if (value === null || value === undefined) return { id, passed: true, detail: 'absent value' };
    const detail = checkFor(id)(value);
    return { id, passed: detail == null, detail: detail ?? null };
  });
  return { status: checks.every(c => c.passed) ? 'ok' : 'failed', checks };
}
