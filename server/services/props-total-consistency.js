/**
 * Market-prop-vs-market-total consistency check (Giant Plan Step 4a).
 *
 * Nick's idea: a sportsbook prices its player props and its game totals with
 * different models of different rigor. If a team's own player props imply
 * more (or fewer) points than the book's own posted total for that game, the
 * book disagrees with itself across two of its own products — a structural,
 * checkable claim that needs no edge over the market's judgment, only that
 * its two products agree with each other.
 *
 * WHAT THIS MODULE IS DESIGNED FOR vs. WHAT REAL DATA CAN ACTUALLY FEED IT
 * ------------------------------------------------------------------------
 * The clean version of this idea sums each player's de-vigged anytime-TD
 * probability into a points figure (6 points a TD, plus a fixed, real
 * extra-point/two-point conversion rate — a scoring RULE, not a prediction)
 * and needs no yardage at all. That is `teamTdPointsFromProps` below, and it
 * works correctly whenever anytime-TD props are present.
 *
 * As of this build (2026-09-13) they never are: `server/services/prop-feeds.js`
 * documents that Underdog — the only provider actually landing rows in
 * `nfl_prop_quote_snapshots` right now — "has no binary anytime-TD market,
 * only a yardage-style rush+rec TD count, which is a different question and
 * is skipped." Action Network's feed does carry `player_anytime_td`, but the
 * captured tape has zero rows of it (confirmed by direct query: every one of
 * the 100,944 captured quotes as of this build is `player_pass_yds`,
 * `player_rush_yds`, `player_reception_yds`, or `player_receptions`, and
 * every one is `provider='underdog'`).
 *
 * So the points-from-TD-props mechanism is built and unit-tested, but has
 * never run on a real market quote and could not be validated against real
 * outcomes in this pass. `teamYardsFromProps` + `yardsToPoints` is the
 * fallback this module ships to still exercise the MECHANISM (de-vig a
 * team's real captured props, aggregate, compare to the real posted total)
 * on the props that actually exist. Converting yardage into points needs a
 * historical yards<->points relationship — see `fitYardsToPointsCalibration`
 * — and that reintroduces exactly the kind of model uncertainty the original
 * idea was designed to avoid (yards do not determine points; turnovers,
 * red-zone efficiency and special teams do a lot of the rest). Every function
 * that touches this path documents that caveat again at the point of use, and
 * callers should treat `yards_points` output as a secondary, weaker signal
 * than a real TD-props total would have been.
 */
import { shinNoVig } from './nfl-devig.js';

/** Points a touchdown is worth including the extra-point/two-point try: a
 *  fixed NFL scoring constant, not a fitted or predicted number. Using the
 *  league's actual long-run PAT make rate (~94%) and 2-point rate (~2-3%
 *  when down big) puts this at essentially 6.94; the codebase carries no
 *  existing constant for it, so this one is introduced here, documented,
 *  and used nowhere else. */
export const TD_POINT_VALUE = 6.94;

/* --------------------------------------------------------------- pairing */

/**
 * Groups raw `nfl_prop_quote_snapshots` rows (or any row shaped the same way)
 * into one entry per (market, player, line), each carrying both sides' prices
 * when both were captured. A one-sided market (Underdog's anytime-TD-style
 * "Yes" only, or a side that simply never got captured) comes back with the
 * missing side left null — `devigPropPairs` reports that honestly rather than
 * guessing a price.
 */
export function pairPropQuotes(quoteRows) {
  const pairs = new Map();
  for (const q of quoteRows ?? []) {
    const key = [q.market, q.player, q.line].join('|');
    const entry = pairs.get(key) ?? {
      market: q.market, player: q.player, line: q.line,
      overPrice: null, underPrice: null
    };
    if (/^over$/i.test(q.side)) entry.overPrice = q.american_price;
    else if (/^under$/i.test(q.side)) entry.underPrice = q.american_price;
    else if (/^yes$/i.test(q.side)) entry.overPrice = q.american_price; // anytime-TD style, one-sided
    pairs.set(key, entry);
  }
  return [...pairs.values()];
}

/**
 * De-vigs each paired quote with Shin's method (`nfl-devig.js` — the one
 * de-vig this project uses everywhere else; not reimplemented here). A
 * one-sided quote cannot be de-vigged (there is no second price to remove
 * margin against) and is passed through with `fair_prob_over: null` and a
 * stated reason, not silently dropped or guessed at.
 */
export function devigPropPairs(pairs) {
  return pairs.map(p => {
    if (p.overPrice == null || p.underPrice == null) {
      return { ...p, fair_prob_over: null, devig_method: 'unavailable',
        reason: p.overPrice == null && p.underPrice == null
          ? 'no price captured on either side'
          : 'one-sided quote: cannot remove vig from a single price' };
    }
    return { ...p, fair_prob_over: shinNoVig(p.overPrice, p.underPrice), devig_method: 'shin' };
  });
}

/* -------------------------------------------------------- line -> mean */

/** Acklam's rational approximation to the inverse standard normal CDF.
 *  Same algorithm `clv-core.js` already uses for closing-line pricing
 *  (ported here, not imported, because that module opens the live database
 *  as a side effect of import and this one must stay pure — see header). */
function normalInv(p) {
  if (!(p > 0) || !(p < 1)) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

/**
 * Converts a de-vigged prop into a fair mean estimate for the underlying
 * stat, rather than just handing back the posted line.
 *
 * A sportsbook prop line is usually set close to the stat's true median (both
 * sides price near -110), so the line itself is already a fine estimate. But
 * roughly a quarter of the props actually captured in this project's tape
 * price meaningfully away from 50/50 (measured: 75% of 446 real paired quotes
 * fall within 45-55% fair-Over probability, but the tail runs from 33% to
 * 67%) — exactly the cases where using the raw line instead of the
 * de-vigged-implied mean would throw away real information the market
 * priced in. This treats the stat as approximately normal around the line
 * with standard deviation `sigma` (the real, historically-measured
 * game-to-game standard deviation of that stat for a player in this role —
 * see `empiricalSigma` in the audit script, not invented here) and inverts:
 * if P(actual > line) = p, then line = mean + sigma * z(1-p), so
 * mean = line - sigma * z(1-p).
 *
 * Without a `sigma` (caller doesn't have one, or the quote couldn't be
 * de-vigged) this falls back to the line itself — a defensible, disclosed
 * default, not a hidden zero.
 */
export function impliedMean({ line, fairProbOver, sigma = null }) {
  if (line == null) return null;
  if (fairProbOver == null || sigma == null || !(sigma > 0)) return line;
  const z = normalInv(1 - fairProbOver);
  if (z == null) return line;
  return line - sigma * z;
}

/* ------------------------------------------------------- team aggregation */

/**
 * Sums one team's captured, de-vigged anytime-TD props into an implied point
 * total. Pure market arithmetic — TD probability times a fixed points-per-TD
 * constant — needing no yardage model and no prediction of this game. Returns
 * `available: false` (not zero) when no anytime-TD prop exists for the team,
 * because zero implied TD points is not the same claim as "no data."
 */
export function teamTdPointsFromProps(devigged) {
  const tds = devigged.filter(p => p.market === 'player_anytime_td' && p.fair_prob_over != null);
  if (!tds.length) return { available: false, points: null, players: 0, reason: 'no anytime-TD props captured for this team' };
  const points = tds.reduce((sum, p) => sum + p.fair_prob_over * TD_POINT_VALUE, 0);
  return { available: true, points: +points.toFixed(3), players: tds.length };
}

/**
 * Sums one team's captured pass/rush yardage props into implied total
 * offensive yards. Deliberately excludes `player_reception_yds` from the sum
 * — receiving yards are a subset of the same team's passing yards (every
 * completed pass is caught by someone), and adding both would double-count
 * the same offense. Receiving yards are still useful as a cross-check
 * (do the receivers' props roughly add up to the QB's?), reported separately
 * as `receiving_check`, not folded into the total.
 *
 * The starting QB is picked as the `player_pass_yds` candidate with the
 * highest line — a backup/handcuff prop, when one exists at all, is priced
 * far below the starter's — rather than assumed to be a single unambiguous
 * row.
 */
export function teamYardsFromProps(devigged, { sigmas = {} } = {}) {
  const passCandidates = devigged.filter(p => p.market === 'player_pass_yds');
  const rushProps = devigged.filter(p => p.market === 'player_rush_yds');
  const recProps = devigged.filter(p => p.market === 'player_reception_yds');

  const starter = passCandidates.length
    ? passCandidates.reduce((best, p) => (best == null || (p.line ?? -Infinity) > (best.line ?? -Infinity) ? p : best), null)
    : null;
  const passMean = starter
    ? impliedMean({ line: starter.line, fairProbOver: starter.fair_prob_over, sigma: sigmas.pass_yds })
    : null;

  const rushMeans = rushProps.map(p => ({
    player: p.player,
    mean: impliedMean({ line: p.line, fairProbOver: p.fair_prob_over, sigma: sigmas.rush_yds })
  }));
  const rushTotal = rushMeans.reduce((s, r) => s + (r.mean ?? 0), 0);

  const recMeans = recProps.map(p => ({
    player: p.player,
    mean: impliedMean({ line: p.line, fairProbOver: p.fair_prob_over, sigma: sigmas.rec_yds })
  }));
  const recTotal = recMeans.reduce((s, r) => s + (r.mean ?? 0), 0);

  const totalYards = (passMean ?? 0) + rushTotal;
  return {
    pass_yds: { player: starter?.player ?? null, mean: passMean, candidates: passCandidates.length },
    rush_yds: { contributors: rushMeans, total: +rushTotal.toFixed(2), n: rushProps.length },
    total_yards: (starter || rushProps.length) ? +totalYards.toFixed(2) : null,
    // Internal props-vs-props sanity check, not part of the total: receivers'
    // summed implied yards vs. the QB's implied passing yards. These should
    // roughly agree (completions go to receivers); a large gap is itself a
    // market-inconsistency signal, just a different one than Step 4a asked
    // for, so it is surfaced but not scored.
    receiving_check: recProps.length && passMean != null
      ? { receivers_total: +recTotal.toFixed(2), qb_pass_yds: +passMean.toFixed(2),
          gap: +(recTotal - passMean).toFixed(2), n: recProps.length }
      : null
  };
}

/**
 * Converts implied total offensive yards into implied points via a
 * `{ intercept, slope, r2 }` calibration the CALLER fits from real historical
 * team-game data (yards vs. that team's own final score) and passes in — this
 * function does no fitting and holds no historical data itself, keeping it
 * pure and testable. `r2` is carried through into the result so nothing
 * downstream can present this conversion's precision as better than it is:
 * total yardage alone typically explains well under half of a team's scoring
 * variance (turnovers and red-zone/goal-to-go efficiency are not yardage),
 * so this is a genuinely weak conversion, not a rounding detail.
 */
export function yardsToPoints(totalYards, calibration) {
  if (totalYards == null || !calibration) return { points: null, r2: null };
  const { intercept = 0, slope, r2 = null } = calibration;
  if (!Number.isFinite(slope)) return { points: null, r2 };
  return { points: +(intercept + slope * totalYards).toFixed(2), r2 };
}

/* -------------------------------------------------------------- compare */

/**
 * The Step 4a comparison itself: how much does the props-implied game total
 * (home + away, whichever component — TD points or yards-derived points —
 * each team actually has) disagree with the book's own posted total for the
 * same game, and (when known) which side of that total the game actually
 * landed on.
 */
export function compareImpliedTotalToPostedTotal({ homePoints, awayPoints, postedTotal, actualTotal = null }) {
  const impliedTotal = (homePoints == null || awayPoints == null) ? null : +(homePoints + awayPoints).toFixed(2);
  const disagreement = (impliedTotal == null || postedTotal == null) ? null : +(impliedTotal - postedTotal).toFixed(2);
  let actualSide = null, propsSide = null, propsCalledSideCorrectly = null;
  if (actualTotal != null && postedTotal != null && actualTotal !== postedTotal) {
    actualSide = actualTotal > postedTotal ? 'Over' : 'Under';
  }
  if (disagreement != null && disagreement !== 0) propsSide = disagreement > 0 ? 'Over' : 'Under';
  if (actualSide && propsSide) propsCalledSideCorrectly = actualSide === propsSide;
  return { implied_total: impliedTotal, posted_total: postedTotal, disagreement, actual_total: actualTotal,
    props_implied_side: propsSide, actual_side: actualSide, props_called_side_correctly: propsCalledSideCorrectly };
}

export const __internal = { normalInv };
