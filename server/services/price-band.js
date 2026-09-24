/**
 * PRICE-BAND-01: the clone's accept band — the price range the app says a manager
 * would say yes to — as a fitted, split-conformal band instead of a hand-set one.
 *
 * Price is the engine's ladder ratio r = value the other manager receives / value he
 * gives up (trade-engine.js#offerFor: give_value / target.value).
 *
 * LEGACY (served today, flag off): search window [0.70, 1.65], "he might say yes" at
 * r >= 1.00, so the stated accept band is [1.00, 1.65]. On executed Sleeper trades
 * 2023-24 it holds 28.5% [25.8, 31.1] of real clearing prices, and 66.7% clear BELOW
 * its yes point (rnd C2-BASE). It is off-centre (prices clear near r ~ 0.90) and not
 * sized to any coverage.
 *
 * V2 (GRIDIRON_PRICE_BAND_V2=1, or preview mode): split-conformal on log r.
 *   centre c  = median log r of the Sleeper 2021 trades (the fit split);
 *   score     = |log r - c| on the Sleeper 2022 trades (the calibration split);
 *   half-width q = the ceil((n+1)(1-alpha))-th smallest score, alpha = 0.20;
 *   band      = [exp(c - q), exp(c + q)], nominal 80% of clearing prices.
 * The band is both the ladder's search window and its accept band, and its lower edge
 * is the yes point. Graded once on 2023-24 held out; 2025 is never read. Numbers and
 * the command that reproduces them: scripts/price-band-calibrate.mjs.
 */
import { previewUnconfirmed } from './preview-mode.js';

export const PRICE_BAND_V2_ENV = 'GRIDIRON_PRICE_BAND_V2';

export const PRICE_BAND_V2_REASON =
  'Fitted 80% accept band (split-conformal on Sleeper 2021-22 clearing prices). '
  + 'Graded on executed Sleeper trades only, in ECR-proxy value, not on accept/decline decisions in FantasyCalc value.';

/** The served band before PRICE-BAND-01. Kept verbatim so flag-off is byte-identical. */
export const LEGACY_BAND = Object.freeze({
  version: 'legacy', window_lo: 0.70, window_hi: 1.65, yes_point: 1.00,
  lo: 1.00, hi: 1.65, center: null, nominal: null
});

/**
 * Written by `scripts/price-band-calibrate.mjs --emit` from the 2021-22 fit.
 * log_center / half_width are the fitted numbers; lo / hi are derived and rounded.
 */
export const FITTED_BAND = Object.freeze({
  version: 'v2-conformal-2021-22', alpha: 0.2,
  log_center: -0.106301, half_width: 0.508539,
  fit_n: 765, cal_n: 1066, fit_seasons: [2021], cal_seasons: [2022]
});

/** Build the served band object from a fitted {log_center, half_width, alpha}. */
export function bandFromFit(fit) {
  const lo = +Math.exp(fit.log_center - fit.half_width).toFixed(3);
  const hi = +Math.exp(fit.log_center + fit.half_width).toFixed(3);
  return Object.freeze({
    version: fit.version, window_lo: lo, window_hi: hi, yes_point: lo,
    lo, hi, center: +Math.exp(fit.log_center).toFixed(3), nominal: +(1 - fit.alpha).toFixed(2)
  });
}

export const V2_BAND = bandFromFit(FITTED_BAND);

/** Same precedence as season-sim.js#rosBasisFlag: '1' on, '0' vetoes preview, else preview. */
export function priceBandV2Flag() {
  const v = process.env[PRICE_BAND_V2_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** The band the ladder serves right now, plus the preview label when preview mode turned it on. */
export function servedAcceptBand(flag = priceBandV2Flag()) {
  if (!flag.on) return LEGACY_BAND;
  return flag.preview
    ? { ...V2_BAND, preview: true, preview_reason: PRICE_BAND_V2_REASON }
    : V2_BAND;
}

/** The ladder's "he might say yes" on price alone. */
export const priceSaysYes = (ratio, band) => ratio >= band.yes_point && ratio <= band.hi;

/* ------------------------------------------------------------ calibration (pure) */

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Split-conformal band on log r. `fitR` sets the centre, `calR` sets the width.
 * Finite-sample rank k = ceil((n+1)(1-alpha)); k > n means the band is unbounded.
 */
export function fitConformalBand(fitR, calR, alpha = 0.2) {
  const clean = xs => xs.filter(r => Number.isFinite(r) && r > 0);
  const f = clean(fitR), c = clean(calR);
  if (!f.length || !c.length) throw new Error('fitConformalBand: empty fit or calibration split');
  if (!(alpha > 0 && alpha < 1)) throw new Error(`fitConformalBand: alpha ${alpha} outside (0,1)`);
  const logCenter = median(f.map(Math.log));
  const scores = c.map(r => Math.abs(Math.log(r) - logCenter)).sort((a, b) => a - b);
  const k = Math.ceil((scores.length + 1) * (1 - alpha));
  const halfWidth = k > scores.length ? Infinity : scores[k - 1];
  return { alpha, log_center: +logCenter.toFixed(6), half_width: +halfWidth.toFixed(6),
    fit_n: f.length, cal_n: c.length };
}

/** Share of prices inside [lo, hi], below lo, above hi. */
export function bandCoverage(rs, band) {
  const xs = rs.filter(r => Number.isFinite(r));
  const n = xs.length;
  if (!n) return { n: 0, inside: null, below: null, above: null };
  let inside = 0, below = 0, above = 0;
  for (const r of xs) {
    if (r < band.lo) below++; else if (r > band.hi) above++; else inside++;
  }
  return { n, inside: inside / n, below: below / n, above: above / n };
}

/** Deterministic PRNG (mulberry32) so the bootstrap CI is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * League-clustered bootstrap CI for a share: resample leagues with replacement.
 * rows: [{ key, hit: 0|1 }]. Returns { est, lo, hi } (95%).
 */
export function clusteredShareCI(rows, { reps = 2000, seed = 20260923 } = {}) {
  const by = new Map();
  for (const { key, hit } of rows) {
    const g = by.get(key) ?? [0, 0];
    g[0] += hit; g[1] += 1;
    by.set(key, g);
  }
  const parts = [...by.values()];
  if (!parts.length) return { est: null, lo: null, hi: null };
  const num = parts.reduce((s, p) => s + p[0], 0), den = parts.reduce((s, p) => s + p[1], 0);
  const rnd = mulberry32(seed);
  const bs = [];
  for (let b = 0; b < reps; b++) {
    let n = 0, d = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[Math.floor(rnd() * parts.length)];
      n += p[0]; d += p[1];
    }
    bs.push(n / d);
  }
  bs.sort((a, b) => a - b);
  const q = p => bs[Math.min(bs.length - 1, Math.max(0, Math.floor(p * (bs.length - 1))))];
  return { est: num / den, lo: q(0.025), hi: q(0.975) };
}
