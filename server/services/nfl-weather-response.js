/**
 * How a single offense responds to the conditions it plays in.
 *
 * This is one pure function over a list of that team's prior games, and it
 * lives on its own for a reason: both `nfl-features.js` (which surfaces these
 * deltas per team) and `nfl-ensemble.js` (whose `weather_total` component
 * forecasts with them) need exactly the same definition, and neither should
 * have to import the other to get it. `nfl-features.js` reaches into
 * play-by-play and the player tables; pulling all of that into the forecasting
 * ensemble's module graph just to share thirty lines of arithmetic is how a
 * dependency tangle starts.
 *
 * No database, no imports, no state.
 */

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Wind at or above this speed is the level that measurably hurts passing and kicking. */
export const WINDY_MPH = 15;
/** Below freezing. */
export const COLD_F = 32;

/** A roof that is shut, whether it was built that way or closed on the day. */
export const isIndoors = roof => roof === 'dome' || roof === 'closed';

/**
 * Splits one team's own prior games by playing conditions and reports how much
 * its offense actually gained or lost per play in each.
 *
 * The sample counts come out alongside each delta, and they are the point. A
 * team may play one indoor game all season, so these deltas rest on very few
 * games -- a consumer that treats a one-game delta as a settled team trait is
 * modelling noise. Anything reading these should be shrinking them on `*_n`,
 * and `epa_samples` is returned so a caller can estimate the per-game variance
 * that noise is drawn from rather than assume one.
 *
 * `samples` is a list of `{ epa, roof, temp, wind }`, one per prior game. A
 * delta is null unless BOTH sides of its split have at least one game -- there
 * is no "difference" measured against an empty comparison group.
 */
export function weatherSplits(samples) {
  const dome = samples.filter(x => isIndoors(x.roof));
  const outdoor = samples.filter(x => x.roof && !isIndoors(x.roof));
  const cold = samples.filter(x => x.temp != null && x.temp < COLD_F);
  const warm = samples.filter(x => x.temp != null && x.temp >= COLD_F);
  const windy = samples.filter(x => x.wind != null && x.wind >= WINDY_MPH);
  const calm = samples.filter(x => x.wind != null && x.wind < WINDY_MPH);
  const delta = (a, b) => (a.length && b.length ? r3(avg(a.map(x => x.epa)) - avg(b.map(x => x.epa))) : null);
  return {
    dome_epa_delta: delta(dome, outdoor),
    cold_epa_delta: delta(cold, warm),
    wind_epa_delta: delta(windy, calm),
    dome_n: dome.length, outdoor_n: outdoor.length,
    cold_n: cold.length, warm_n: warm.length,
    windy_n: windy.length, calm_n: calm.length,
    epa_samples: samples.map(x => x.epa)
  };
}
