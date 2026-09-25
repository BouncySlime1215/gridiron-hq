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

/**
 * Build the served band object from a fitted {log_center, half_width, alpha}.
 * FIX-303-2: the fitted band is the SEARCH WINDOW and the served accept_band only. The yes
 * point stays the legacy 1.00 (the band's lower edge, r ~ 0.54, is the 10th percentile of
 * clearing prices: as a yes point it passed nearly every package and read a lowball as
 * "might say yes"). The yes point belongs to the counterpart model (FIELD-REGISTRY).
 */
export function bandFromFit(fit) {
  // PRICE-BAND-02 shape bands are equal-tailed: separate widths below and above the centre.
  const lo = +Math.exp(fit.log_center - (fit.width_lo ?? fit.half_width)).toFixed(3);
  const hi = +Math.exp(fit.log_center + (fit.width_hi ?? fit.half_width)).toFixed(3);
  return Object.freeze({
    version: fit.version, window_lo: lo, window_hi: hi, yes_point: LEGACY_BAND.yes_point,
    lo, hi, center: +Math.exp(fit.log_center).toFixed(3), nominal: +(1 - fit.alpha).toFixed(2)
  });
}

/**
 * PRICE-BAND-02: one split-conformal band per trade shape (Mondrian conformal), same
 * splits and alpha as FITTED_BAND. Shape is read from the target owner's side:
 * n_get = players he receives (the package), n_give = players he gives (the targets).
 * On the 2021-22 splits the shapes clear at very different prices (median r: 1-for-1
 * 0.83, 2-for-1 1.43, 3+-for-fewer ~1.3), so one pooled band covered 89.6% of 1-for-1s
 * and 57.4% of uneven trades. Held-out 2023-24 with these bands: 1-for-1 73.6%, 2-for-1
 * 75.7%, 3-for-2+ 83.8%, all uneven 81.4%. A shape with too few trades to fit
 * (fitShapeBands minN) falls back to the pooled band; none does today.
 * Written by `scripts/price-band-calibrate.mjs --emit`.
 */
export const TRADE_SHAPES = Object.freeze(['1for1', '2for1', '3for2plus', 'even', 'fewer_for_more']);

/** The shape of a trade: nGet players to the target's owner for nGive of his. */
export function tradeShape(nGet, nGive) {
  if (!(Number.isInteger(nGet) && Number.isInteger(nGive) && nGet > 0 && nGive > 0)) {
    throw new Error(`tradeShape: bad counts ${nGet}-for-${nGive}`);
  }
  if (nGet === 1 && nGive === 1) return '1for1';
  if (nGet === 2 && nGive === 1) return '2for1';
  if (nGet >= 3 && nGet > nGive) return '3for2plus';
  if (nGet === nGive) return 'even';
  return 'fewer_for_more';
}

export const FITTED_SHAPE_BANDS = Object.freeze({
  '1for1': Object.freeze({ alpha: 0.2, log_center: 0, half_width: 0.425413, direction_free: true, fit_n: 279, cal_n: 361 }),
  '2for1': Object.freeze({ alpha: 0.2, log_center: 0.343893, width_lo: 0.2325, width_hi: 0.186102, fit_n: 127, cal_n: 188 }),
  '3for2plus': Object.freeze({ alpha: 0.2, log_center: 0.26026, width_lo: 0.258092, width_hi: 0.442499, fit_n: 81, cal_n: 135 }),
  'even': Object.freeze({ alpha: 0.2, log_center: -0.111118, width_lo: 0.228924, width_hi: 0.194967, fit_n: 189, cal_n: 243 }),
  'fewer_for_more': Object.freeze({ alpha: 0.2, log_center: -0.655618, width_lo: 0.339567, width_hi: 0.389703, fit_n: 89, cal_n: 139 })
});

export const V2_BAND = Object.freeze({
  ...bandFromFit(FITTED_BAND),
  by_shape: Object.freeze(Object.fromEntries(TRADE_SHAPES.map(k => [k,
    FITTED_SHAPE_BANDS[k] ? bandFromFit({ ...FITTED_SHAPE_BANDS[k], version: `${FITTED_BAND.version}/${k}` }) : null])))
});

/**
 * The band for one package: nGet players offered for nGive targets. Legacy has one band
 * for every shape. V2 serves the shape's own band, or the pooled band when that shape
 * has no fit.
 */
export function bandForShape(served, nGet, nGive) {
  if (!served.by_shape) return served;
  const shape = tradeShape(nGet, nGive);
  const b = served.by_shape[shape];
  if (b) return { ...b, shape };
  const { by_shape: _all, ...pooled } = served;
  return { ...pooled, shape };
}

/** The outermost [window_lo, window_hi] over package sizes `sizes` for nGive targets. */
export function windowSpan(served, sizes, nGive) {
  const bs = sizes.map(n => bandForShape(served, n, nGive));
  return { lo: Math.min(...bs.map(b => b.window_lo)), hi: Math.max(...bs.map(b => b.window_hi)) };
}

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
 * Split-conformal band on log r. `fitR` sets the centre (unless `logCenter` fixes it), `calR` sets the width.
 * Finite-sample rank k = ceil((n+1)(1-alpha)); k > n means the band is unbounded.
 */
/**
 * Mondrian split conformal: fitEqualTailedBand within each trade shape. rows carry
 * { r, n_get, n_give }. A shape with fewer than `minN` rows in either split gets no
 * band (callers fall back to the pooled one).
 */
export function fitShapeBands(fitRows, calRows, alpha = 0.2, minN = 30) {
  const byShape = rows => {
    const m = new Map(TRADE_SHAPES.map(k => [k, []]));
    for (const t of rows) m.get(tradeShape(t.n_get, t.n_give)).push(t.r);
    return m;
  };
  const f = byShape(fitRows), c = byShape(calRows);
  const out = {};
  for (const k of TRADE_SHAPES) {
    if (f.get(k).length < minN || c.get(k).length < minN) { out[k] = null; continue; }
    // A Sleeper 1-for-1 does not say which side asked, and its extract framing forces
    // r <= 1; the ladder asks target-first, where r > 1 is a real package. So the 1-for-1
    // band is direction-free: centred on even value (r = 1), width from |log r|.
    out[k] = k === '1for1'
      ? { ...fitConformalBand(f.get(k), c.get(k), alpha, { logCenter: 0 }), direction_free: true }
      : fitEqualTailedBand(f.get(k), c.get(k), alpha);
  }
  return out;
}

/**
 * Equal-tailed split conformal on log r: the centre from `fitR`, then one conformal rank
 * per tail on `calR` at alpha/2 each (scores c - log r below, log r - c above). Used for
 * the shape bands because clearing prices are skewed within a shape: a Sleeper 1-for-1 is
 * framed so r <= 1, and a symmetric band there spends half its width above 1.
 */
export function fitEqualTailedBand(fitR, calR, alpha = 0.2) {
  const clean = xs => xs.filter(r => Number.isFinite(r) && r > 0);
  const f = clean(fitR), c = clean(calR);
  if (!f.length || !c.length) throw new Error('fitEqualTailedBand: empty fit or calibration split');
  if (!(alpha > 0 && alpha < 1)) throw new Error(`fitEqualTailedBand: alpha ${alpha} outside (0,1)`);
  const logCenter = median(f.map(Math.log));
  const k = Math.ceil((c.length + 1) * (1 - alpha / 2));
  const rank = scores => (k > scores.length ? Infinity : scores.sort((a, b) => a - b)[k - 1]);
  const widthLo = rank(c.map(r => logCenter - Math.log(r)));
  const widthHi = rank(c.map(r => Math.log(r) - logCenter));
  return { alpha, log_center: +logCenter.toFixed(6), width_lo: +widthLo.toFixed(6), width_hi: +widthHi.toFixed(6),
    fit_n: f.length, cal_n: c.length };
}

export function fitConformalBand(fitR, calR, alpha = 0.2, { logCenter: fixedCenter = null } = {}) {
  const clean = xs => xs.filter(r => Number.isFinite(r) && r > 0);
  const f = clean(fitR), c = clean(calR);
  if (!f.length || !c.length) throw new Error('fitConformalBand: empty fit or calibration split');
  if (!(alpha > 0 && alpha < 1)) throw new Error(`fitConformalBand: alpha ${alpha} outside (0,1)`);
  const logCenter = fixedCenter ?? median(f.map(Math.log));
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
