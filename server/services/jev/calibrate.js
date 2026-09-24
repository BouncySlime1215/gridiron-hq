/**
 * Calibration maps for a Jev arm: claimed probability -> observed rate.
 *
 * JEV-01b pre-registration (docs/evidence/2026-09-24/jev-01b-chat-preregistration.md):
 * isotonic at n >= ISOTONIC_MIN_N training points, Platt below. Isotonic needs
 * the points to pin its steps down; with fewer, a two-parameter logistic on the
 * logit is the honest fit.
 */

export const ISOTONIC_MIN_N = 200;
/** Every served probability stays inside this band, so a log loss is finite. */
export const P_EPS = 1e-4;

export const clampP = p => Math.min(1 - P_EPS, Math.max(P_EPS, p));
export const logit = p => { const q = clampP(p); return Math.log(q / (1 - q)); };
export const sigmoid = z => 1 / (1 + Math.exp(-z));

/**
 * Pool-adjacent-violators over points sorted by claim. Points with the same
 * claim are one block from the start, so a block's centre is a claim value
 * and the map is linear between centres.
 */
function isotonic(points) {
  const sorted = [...points].sort((a, b) => a.p - b.p);
  const blocks = [];
  for (const { p, y } of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && last.x === p) { last.sum += y; last.w += 1; last.xs += p; } else blocks.push({ x: p, xs: p, sum: y, w: 1 });
  }
  const stack = [];
  for (const b of blocks) {
    stack.push({ ...b });
    while (stack.length > 1 && stack[stack.length - 2].sum / stack[stack.length - 2].w >= stack[stack.length - 1].sum / stack[stack.length - 1].w) {
      const top = stack.pop(); const under = stack[stack.length - 1];
      under.sum += top.sum; under.w += top.w; under.xs += top.xs;
    }
  }
  return { kind: 'isotonic', n: points.length,
    x: stack.map(b => b.xs / b.w), y: stack.map(b => b.sum / b.w) };
}

/**
 * Logistic regression y ~ a * (logit(p) - mu) + b by damped Newton. Centring
 * on mu decouples a from b, and a small ridge on `a` keeps it defined when
 * every claim is the same number (then a -> 0 and b is the base rate's logit).
 * Each step is halved until the penalised loss goes down, so it cannot diverge.
 */
function platt(points, ridge = 1e-3) {
  const xs = points.map(({ p }) => logit(p));
  const mu = xs.reduce((s, x) => s + x, 0) / xs.length;
  const loss = (a, b) => ridge * a * a / 2 + points.reduce((s, { y }, i) => {
    const q = clampP(sigmoid(a * (xs[i] - mu) + b));
    return s - (y ? Math.log(q) : Math.log(1 - q));
  }, 0);
  let a = 1, b = 0, cur = loss(a, b);
  for (let it = 0; it < 100; it++) {
    let ga = ridge * a, gb = 0, haa = ridge, hab = 0, hbb = 1e-9;
    points.forEach(({ y }, i) => {
      const x = xs[i] - mu;
      const q = sigmoid(a * x + b);
      const r = q - y, w = q * (1 - q);
      ga += r * x; gb += r; haa += w * x * x; hab += w * x; hbb += w;
    });
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    let step = 1, next = loss(a - da, b - db);
    while (next > cur && step > 1e-6) { step /= 2; next = loss(a - step * da, b - step * db); }
    if (next > cur) break;
    a -= step * da; b -= step * db;
    const moved = Math.abs(step * da) + Math.abs(step * db);
    cur = next;
    if (moved < 1e-12) break;
  }
  return { kind: 'platt', n: points.length, a, b, mu };
}

/** points: [{ p: claimed probability, y: 0|1 }] */
export function fitCalibration(points) {
  if (!points.length) throw new Error('fitCalibration: no points');
  return points.length >= ISOTONIC_MIN_N ? isotonic(points) : platt(points);
}

export function applyCalibration(cal, p) {
  if (cal.kind === 'platt') return clampP(sigmoid(cal.a * (logit(p) - cal.mu) + cal.b));
  const { x, y } = cal;
  if (p <= x[0]) return clampP(y[0]);
  if (p >= x[x.length - 1]) return clampP(y[y.length - 1]);
  let i = 1;
  while (x[i] < p) i++;
  const f = (p - x[i - 1]) / (x[i] - x[i - 1]);
  return clampP(y[i - 1] + f * (y[i] - y[i - 1]));
}
