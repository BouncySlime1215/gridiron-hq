/**
 * FP-GUARD (RULES-EVERYWHERE): Nick's rule is that FantasyPros is never displayed or committed. Its
 * ranks stay internal inputs on the server (people/fantasypros-ros.js feeds the blue-chip board's
 * gap flags); a client payload that carries them is exposure even when no page renders them.
 *
 * One key test, FP_KEY (/^fp_|fantasypros/i), applied in one place: fantasyProsGuard wraps res.json
 * for every /api response (server/index.js), so any fp_* or FantasyPros key is removed before it
 * leaves the server. The War Room view also drops the board's `fp` block (the FantasyPros sync
 * status), a key too short to strip globally ('fp' is also a false-positive count elsewhere).
 *
 * stripFantasyPros returns the value itself when nothing matches (no copy on the common path).
 */
export const FP_KEY = /^fp_|fantasypros/i;

const plain = v => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Whether any key anywhere in `value` would be stripped. */
export function hasFantasyPros(value, { also = [] } = {}, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(v => hasFantasyPros(v, { also }, seen));
  if (!plain(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (FP_KEY.test(k) || also.includes(k)) return true;
    if (hasFantasyPros(v, { also }, seen)) return true;
  }
  return false;
}

/** `value` without any FP_KEY key (and any key in `also`), at any depth. Unchanged when clean. */
export function stripFantasyPros(value, { also = [] } = {}) {
  if (!hasFantasyPros(value, { also })) return value;
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (!plain(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!FP_KEY.test(k) && !also.includes(k)) out[k] = walk(x);
    return out;
  };
  return walk(value);
}

/** Express middleware: every res.json body leaves without FantasyPros keys. */
export function fantasyProsGuard(_req, res, next) {
  const json = res.json.bind(res);
  res.json = body => json(stripFantasyPros(body));
  next();
}
