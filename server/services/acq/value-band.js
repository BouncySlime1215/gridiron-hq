/**
 * ACQ-01: which packages look fair on the other manager's own screen.
 *
 * His screen is market value (FantasyCalc, the asset's `value`). A package is
 * "screen-fair" when what he gets is within the trade finder's window of what he
 * gives: -12% to +18% on his side (the same window as the ACQ-FLIP prototype and
 * the served finder).
 *
 * IDEA-038 (R&D r23, 5/5 leagues): a one-for-one search only ever asks "which ONE
 * of my players is worth about the same as his?". When the target is worth more
 * than any single spare piece, or sits in a gap between two of them, it finds
 * nothing, while a pair of mid-value players whose SUM lands in the band is a
 * normal 2-for-1 he would read as fair. `pairsInBand` enumerates exactly those
 * pairs with a sorted two-pointer sweep, so the cost is the pairs that qualify,
 * not every pair on the roster.
 *
 * Pure: no DB, no I/O. Values are plain numbers; items are { id, value }.
 */

/** The finder's fairness window on the counterparty's side, in percent. */
export const SCREEN_WINDOW = Object.freeze({ low: -12, high: 18 });

/** His side: what he gets minus what he gives, as a percent of what he gives. */
export function screenPct(theyGetValue, theyGiveValue) {
  if (!(theyGiveValue > 0)) return null;
  return ((theyGetValue - theyGiveValue) / theyGiveValue) * 100;
}

/** Whether a package looks fair on his screen. */
export function screenFair(theyGetValue, theyGiveValue, window = SCREEN_WINDOW) {
  const pct = screenPct(theyGetValue, theyGiveValue);
  return pct != null && pct >= window.low && pct <= window.high;
}

/**
 * The range Nick's side must sum to for a package worth `theyGiveValue` to him
 * to read as fair on his screen. Null when his side has no market value.
 */
export function fairBand(theyGiveValue, window = SCREEN_WINDOW) {
  if (!(theyGiveValue > 0)) return null;
  return { lo: theyGiveValue * (1 + window.low / 100), hi: theyGiveValue * (1 + window.high / 100) };
}

const byValue = (a, b) => a.value - b.value || String(a.id).localeCompare(String(b.id));

/** Single items whose value lies in [lo, hi]. */
export function onesInBand(items, band) {
  if (!band) return [];
  return items.filter(x => x.value >= band.lo && x.value <= band.hi).sort(byValue).map(x => [x.id]);
}

/** First index in sorted `vals` with value >= x (lower bound). */
function lowerBound(vals, x, from) {
  let lo = from, hi = vals.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Unordered pairs whose summed value lies in [lo, hi], each pair once, lowest
 * value first. Sorted sweep: for item i, the partners j > i that fit are one
 * contiguous run of the sorted list, found by binary search. `limit` caps the
 * output (the pairs nearest the band's centre are kept, so a cap never keeps the
 * edge cases over the fair middle).
 */
export function pairsInBand(items, band, { limit = Infinity } = {}) {
  if (!band) return [];
  const s = items.filter(x => x.value > 0).sort(byValue);
  const vals = s.map(x => x.value);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const need = band.lo - vals[i];
    let j = lowerBound(vals, need, i + 1);
    for (; j < s.length && vals[i] + vals[j] <= band.hi; j++) out.push({ ids: [s[i].id, s[j].id], sum: vals[i] + vals[j] });
  }
  if (out.length > limit) {
    const mid = (band.lo + band.hi) / 2;
    out.sort((a, b) => Math.abs(a.sum - mid) - Math.abs(b.sum - mid));
    out.length = limit;
  }
  return out.map(p => p.ids);
}
