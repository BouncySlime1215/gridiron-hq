/**
 * Wong teaser leg rates — the one number the weekly scanner is allowed to
 * price with, and the reasons it is that number and not a more flattering one.
 *
 * `server/services/nfl-teasers.js` establishes WHY a 6-point teaser can be
 * structurally +EV: NFL margins are lumpy, a margin of exactly 3 occurs in
 * ~15% of games and exactly 7 in ~9%, and a teaser that spends its six points
 * crossing BOTH of those numbers buys roughly a quarter of the margin
 * distribution for the same price as six points spent crossing nothing. This
 * module does the measurement that turns that mechanism into a price gate.
 *
 * It differs from `nfl-teasers.js` in two deliberate ways:
 *
 *  1. It uses the FULL cross-both candidate set (eight posted lines), derived
 *     below from the crossing requirement rather than quoted from folklore.
 *     The classic Wong window (-7.5/-8/-8.5, +1.5/+2/+2.5) is a subset that
 *     drops -7, +3 and (on some tellings) -8.5 for no stated reason. -7 and +3
 *     cross both key numbers exactly as the others do, and +3 alone is 39% of
 *     all available legs, so leaving it out is not conservatism, it is
 *     throwing away the largest sample in the family.
 *  2. It excludes 2025 and 2026 (see DATA DEFECT below), which `nfl-teasers.js`
 *     does not.
 *
 * WHAT IS COUNTED. Both sides of every game, each indexed at ITS OWN posted
 * number. `game_lines` stores one row per team per game with `spread` from
 * that team's perspective, so "all rows whose spread is in the candidate set"
 * is exactly the population of legs the scanner could have taken. A single
 * game never contributes two candidate legs — the counterpart of a -7..-8.5
 * favourite is a +7..+8.5 dog and the counterpart of a +1.5..+3 dog is a
 * -1.5..-3 favourite, and neither counterpart is in the family — so there is
 * no same-game double-count to remove. (This is asserted, not assumed: see
 * `familyPairCorrelation`, which reports the same-game pair count and finds 0.)
 *
 * THE COLUMN. `spread`, the same column `nfl-teasers.js` reads, not
 * `closing_spread`. Two columns would be two different populations and two
 * different rates, and the point of this module is that there is one rate.
 *
 * ---------------------------------------------------------------------------
 * DATA DEFECT — WHY 2025 AND 2026 ARE EXCLUDED. Measured 2026-09-10 on this
 * database, the share of `game_lines.spread` values that are whole integers:
 *
 *     2021 49.5%   2022 51.1%   2023 48.4%   2024 47.7%
 *     2025 24.9%   2026 16.2%
 *
 * That is not the market changing its habits over one offseason. Whole
 * integers are simply MISSING from those two seasons: 2025 has no -1, -2, -4,
 * -8, -9, -11, -12, -13 or -15 anywhere in 570 rows, and 2026 is worse. The
 * damage lands directly on this family — in both 2025 and 2026 the lines -8.0
 * and +2.0 have ZERO rows, so two of the eight candidate legs do not exist and
 * the pooled rate silently re-weights onto the six that survive.
 *
 * So every historical rate in this module is computed on 1999-2024 only. This
 * is load-bearing, not decorative: including 2025-2026 moves the family rate
 * from 74.0586% to 73.9058% on a leg set that is missing a quarter of its
 * lines. `test/teaser-leg-rates.test.js` asserts both the exclusion and the
 * fact that it changes the answer, so nobody can widen the window back out
 * without the suite noticing.
 *
 * A live 2025/2026 line is still perfectly fine to BET — the defect is in the
 * stored history, not in the market. It just cannot be used to MEASURE.
 * ---------------------------------------------------------------------------
 *
 * PERFORMANCE. Every function here answers from one pass over ~14,000
 * `game_lines` rows, tallied once per `points` value and cached in module
 * scope for the life of the process. The scanner calls `familyRate` once per
 * candidate leg per week; without the cache that would be one full table scan
 * each time. Nothing here mutates the database, and nothing here is
 * time-dependent, so a process-lifetime cache cannot go stale within a run.
 * (A data sync during a long-running process would not be picked up. That is
 * what `clearRateCache` is for, and why it exists.)
 */
import { rows } from '../../../db/index.js';

export const TEASER_LEG_RATES_VERSION = 'nfl-teaser-leg-rates-v1';

/** The teaser this module is about. Six points, two teams, one price. */
export const TEASER_POINTS = 6;

/** The two numbers the six points have to buy. Everything else follows. */
export const KEY_NUMBERS = Object.freeze([3, 7]);

/**
 * The measurement window, and the two seasons kept out of it.
 *
 * See DATA DEFECT above. `from` is 1999 because that is where `game_lines`
 * starts; `to` is 2024 because 2025 is where `spread` stops being trustworthy.
 */
export const MEASUREMENT_SEASONS = Object.freeze({ from: 1999, to: 2024 });
export const EXCLUDED_SEASONS = Object.freeze([2025, 2026]);
export const EXCLUSION_REASON =
  'game_lines.spread is corrupted for 2025-2026: the integer share collapses from ~48% (2021-2024) ' +
  'to 24.9% (2025) and 16.2% (2026), whole integers are absent outright, and the candidate lines ' +
  '-8.0 and +2.0 have zero rows in both seasons — so a pooled rate that includes them is computed ' +
  'on six of the eight legs, not eight.';

/* ------------------------------------------------- the candidate leg set */

/**
 * Which integer margins does teasing this line newly WIN?
 *
 * A leg posted at `line` (from that team's perspective, negative = favoured)
 * wins when `margin + line > 0` and pushes when it equals 0. Teased, the same
 * leg wins when `margin + line + points > 0`. So teasing converts into wins
 * exactly the integer margins in the half-open interval
 *
 *     ( -line - points , -line ]
 *
 * The interval is half-OPEN on purpose, and the asymmetry is the whole reason
 * the candidate set is what it is. At the closed end sits the margin that used
 * to PUSH: a -7 favourite pushes on a 7-point win, and teasing it to -1 turns
 * that push into a win, so 7 counts as bought. At the open end sits the margin
 * that now pushes instead of winning: -9 teased to -3 does NOT buy 3, it only
 * moves the push there. That single point of difference is why -7.0 and +3.0
 * qualify while -9.0 and +3.5 do not.
 */
export function gainedMargins(line, points = TEASER_POINTS) {
  if (!Number.isFinite(line) || !Number.isFinite(points) || points <= 0) return [];
  const lo = Math.floor(-line - points) + 1;   // strictly greater than -line-points
  const hi = Math.floor(-line);                // less than or equal to -line
  const out = [];
  for (let m = lo; m <= hi; m++) out.push(m);
  return out;
}

/**
 * Does this line's teaser strictly cross BOTH key numbers?
 *
 * A favourite gains positive margins and so must buy +3 and +7; a dog gains
 * negative margins and must buy -3 and -7. Asking for "a gained margin of
 * absolute value 3 and one of absolute value 7" covers both without a
 * side-of-the-game branch: the gained interval is only six integers wide, so
 * it can never straddle zero far enough to pick up +3 and -7.
 */
export function crossesBothKeyNumbers(line, points = TEASER_POINTS) {
  const gained = gainedMargins(line, points);
  return KEY_NUMBERS.every(k => gained.some(m => Math.abs(m) === k));
}

/**
 * The eight posted lines a 6-point teaser can move across both 3 and 7.
 *
 * Working the condition above through by hand, for a favourite at magnitude
 * f the gained interval is (f-6, f], which contains 7 only if f >= 7 and
 * contains 3 only if f < 9 — so f in [7, 9). For a dog at +d the gained
 * losing margins are [d, d+6), which contains 3 only if d <= 3 and contains 7
 * only if d > 1 — so d in (1, 3]. On the half-point grid the market actually
 * posts, that is:
 *
 *     favourites  -7.0  -7.5  -8.0  -8.5   teased to  -1.0 -1.5 -2.0 -2.5
 *     underdogs   +1.5  +2.0  +2.5  +3.0   teased to  +7.5 +8.0 +8.5 +9.0
 *
 * and nothing else. -6.5 buys 3 but not 7. -9.0 buys 7 but only moves the push
 * to 3. +1.0 buys 3 but not 7. +3.5 buys 7 but only moves the push to 3. The
 * set is not a matter of taste; it is the solution set of one inequality.
 *
 * Frozen because it is a definition, not a tuning parameter. A scanner that
 * "extends the window a little" is no longer running this strategy.
 */
export const CROSS_BOTH_LINES = Object.freeze([-8.5, -8, -7.5, -7, 1.5, 2, 2.5, 3]);

const CROSS_BOTH_SET = new Set(CROSS_BOTH_LINES);

/** Which half of the family a line belongs to. */
export function legSide(line) {
  if (!Number.isFinite(line) || line === 0) return null;
  return line < 0 ? 'favourite' : 'underdog';
}

/* ------------------------------------------------------ the measurement */

/**
 * One pass over the window, tallied by posted line, cached per `points`.
 *
 * Every line in the window is tallied, not just the eight candidates. That
 * costs nothing on a single scan and it is what lets `teasedLegRate` answer
 * for -9.0 or +3.5 too — which matters, because the argument for pooling
 * (below) is an argument about how much the neighbours move around, and it
 * would be weak if the neighbours could not be looked at.
 */
const tallyCache = new Map();

export function clearRateCache() {
  tallyCache.clear();
}

function tally(points) {
  const cached = tallyCache.get(points);
  if (cached) return cached;

  const legs = rows(
    `SELECT season, week, team, opponent, spread, team_score, opp_score
       FROM game_lines
      WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`,
    MEASUREMENT_SEASONS.from, MEASUREMENT_SEASONS.to);

  const byLine = new Map();
  const byWeek = new Map();
  let scanned = 0;

  for (const leg of legs) {
    scanned++;
    const line = leg.spread;
    const margin = leg.team_score - leg.opp_score;
    // The teased result, on the same sign convention the raw spread uses:
    // > 0 win, = 0 push, < 0 loss.
    const result = margin + line + points;

    let bucket = byLine.get(line);
    if (!bucket) {
      bucket = { line, n: 0, wins: 0, pushes: 0, first: leg.season, last: leg.season };
      byLine.set(line, bucket);
    }
    bucket.n++;
    if (result === 0) bucket.pushes++;
    else if (result > 0) bucket.wins++;
    bucket.first = Math.min(bucket.first, leg.season);
    bucket.last = Math.max(bucket.last, leg.season);

    if (!CROSS_BOTH_SET.has(line)) continue;
    const key = `${leg.season}-${leg.week}`;
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push({
      win: result > 0 ? 1 : 0,
      push: result === 0,
      // Sorted so both perspectives of one game produce the same identifier.
      game: [leg.team, leg.opponent].sort().join('@')
    });
  }

  const built = { points, byLine, byWeek, scanned };
  tallyCache.set(points, built);
  return built;
}

/**
 * Deliberately unrounded.
 *
 * The rest of this codebase rounds measurements to 4dp for display, and that
 * is right for a dashboard. These numbers feed an EV calculation and a
 * break-even price instead, where 4dp rounding is visible in the answer, so
 * rounding here would be a rounding of the decision rather than of the
 * display. Callers that want 4dp can round at the edge.
 */
function summarise(bucket, { line, points, seasons, extra = {} }) {
  const decided = bucket.n - bucket.pushes;
  return {
    line,
    teased_to: line + points,
    n: bucket.n,                                   // every leg, pushes included
    wins: bucket.wins,
    pushes: bucket.pushes,
    decided,                                       // the rate's denominator
    rate_of_decided: decided ? bucket.wins / decided : null,
    push_share: bucket.n ? bucket.pushes / bucket.n : null,
    // What `ticketProbabilities` actually needs: unconditional per-leg
    // outcome shares, which are NOT the same thing as rate_of_decided.
    win_share: bucket.n ? bucket.wins / bucket.n : null,
    loss_share: bucket.n ? (bucket.n - bucket.wins - bucket.pushes) / bucket.n : null,
    standard_error: decided
      ? Math.sqrt((bucket.wins / decided) * (1 - bucket.wins / decided) / decided) : null,
    seasons,
    ...extra
  };
}

function seasonWindow(bucket) {
  return {
    from: MEASUREMENT_SEASONS.from,
    to: MEASUREMENT_SEASONS.to,
    excluded: [...EXCLUDED_SEASONS],
    exclusion_reason: EXCLUSION_REASON,
    observed_first: bucket?.n ? bucket.first : null,
    observed_last: bucket?.n ? bucket.last : null
  };
}

/**
 * The measured historical record of a single posted line, teased `points`.
 *
 * Pushes are excluded from the DENOMINATOR of `rate_of_decided` — a push is
 * neither a win nor a loss and counting it either way misstates the bet — but
 * they are kept in `n` and reported as `push_share`, because a ticket has to
 * price them and a rate that has quietly deleted them cannot.
 *
 * READ THE RETURNED `use_for_ev` FLAG. It is always false, and the reason is
 * the next comment block.
 */
export function teasedLegRate(line, { points = TEASER_POINTS } = {}) {
  if (!Number.isFinite(line)) throw new TypeError('teasedLegRate needs a numeric posted line');
  const bucket = tally(points).byLine.get(line)
    ?? { line, n: 0, wins: 0, pushes: 0, first: null, last: null };

  return summarise(bucket, {
    line,
    points,
    seasons: seasonWindow(bucket),
    extra: {
      crosses_both: crossesBothKeyNumbers(line, points),
      gained_margins: gainedMargins(line, points),
      // A single flag at the call site, so the pooling argument does not
      // depend on anyone scrolling up to read it.
      use_for_ev: false,
      caution: 'Per-line rates are for inspection only. Price tickets with familyRate(); ' +
        'the per-line spread is noise (chi-square 5.99 on 7 df, p = 0.54) and ranking legs by ' +
        'it is selecting on sampling error. See WHY THE SCANNER POOLS in this module.'
    }
  });
}

/* -------------------------------------------------------------------------
 * WHY THE SCANNER POOLS — read this before "improving" the leg selection.
 *
 * The eight candidate lines do not win at the same measured rate:
 *
 *     +1.5  78.70% (n=169)      -7.0  75.22% (n=472)
 *     +2.0  70.91% (n=169)      -7.5  74.91% (n=275)
 *     +2.5  76.02% (n=492)      -8.0  70.41% (n=100)
 *     +3.0  72.67% (n=1124)     -8.5  73.12% (n=93)
 *
 * The obvious move is to take the good ones and skip -8.0 and +2.0. Do not.
 *
 * THE ADJACENT-HALF-POINT ARGUMENT. +1.5 and +2.0 have IDENTICAL sample sizes
 * (n = 169 legs each) and differ by 7.8 percentage points. They also cross the
 * two key numbers identically: +1.5 teases to +7.5 and buys losing margins 2
 * through 7; +2.0 teases to +8.0 and buys losing margins 2 through 7. Same
 * bought margins, same count of them, same n — and an 8-point gap. There is no
 * football story that explains that, because there is no football difference
 * to explain. The standard error at n=169 is 3.4pp, the two-proportion z for
 * that gap is 1.64, and a gap that size between two adjacent half-points is
 * exactly what sampling noise looks like at this sample size.
 *
 * THE WHOLE-FAMILY ARGUMENT. Testing all eight lines against a single common
 * rate gives chi-square 5.99 on 7 degrees of freedom, p = 0.54. That is not a
 * marginal pass. The observed spread across the family is BELOW the average
 * spread you would expect if every line genuinely shared one rate. There is
 * nothing here to explain. `familyHomogeneity()` recomputes this from the
 * database rather than quoting it, so it cannot go stale.
 *
 * THE SEARCH-SPACE ARGUMENT. The prior sweep over this database that motivated
 * the family scanned 4,060 line windows and produced apparent winners at
 * z = 2.87 against a noise ceiling of z = 4.26 — that is, the best-looking
 * window in the search was LESS impressive than the best window a pure-noise
 * search of the same size would be expected to throw up. Any per-line ranking
 * done after the fact is a smaller version of the same search, run on the same
 * data, with the same result waiting for it.
 *
 * WHAT THE COST OF GETTING THIS WRONG LOOKS LIKE. Dropping the two worst lines
 * would raise the measured rate and shrink the sample by about a third, which
 * would move the break-even price in the flattering direction on both counts.
 * The scanner would then accept prices it should refuse, on legs it selected
 * because of the sampling error in a 100-leg cell. That is not a small error
 * with real money on it — it is the mechanism by which a real structural edge
 * becomes a losing bet.
 *
 * So: `familyRate()` is the number the scanner prices with. `teasedLegRate()`
 * exists so the family can be inspected, and returns `use_for_ev: false`.
 * ------------------------------------------------------------------------- */

/**
 * The pooled rate across the whole candidate family. THIS is the EV input.
 *
 * `side` narrows to 'favourite' or 'underdog' for inspection. The two halves
 * measure 74.41% and 73.89% — a 0.5pp difference on a ~1.2pp standard error,
 * which is to say no difference — so the scanner should use 'all' here too.
 */
export function familyRate({ side = 'all', points = TEASER_POINTS } = {}) {
  if (!['all', 'favourite', 'underdog'].includes(side)) {
    throw new TypeError(`familyRate side must be 'all', 'favourite' or 'underdog', got ${side}`);
  }
  const { byLine } = tally(points);
  const lines = CROSS_BOTH_LINES.filter(line => side === 'all' || legSide(line) === side);

  const pooled = { n: 0, wins: 0, pushes: 0, first: Infinity, last: -Infinity };
  for (const line of lines) {
    const bucket = byLine.get(line);
    if (!bucket?.n) continue;
    pooled.n += bucket.n;
    pooled.wins += bucket.wins;
    pooled.pushes += bucket.pushes;
    pooled.first = Math.min(pooled.first, bucket.first);
    pooled.last = Math.max(pooled.last, bucket.last);
  }
  if (!pooled.n) pooled.first = pooled.last = null;

  return summarise(pooled, {
    line: null,
    points,
    seasons: seasonWindow(pooled.n ? pooled : null),
    extra: {
      side,
      lines: [...lines],
      teased_to: null,
      use_for_ev: true,
      basis: 'pooled across the whole cross-both family; per-line differences are noise ' +
        '(see WHY THE SCANNER POOLS)'
    }
  });
}

/**
 * The homogeneity test, recomputed rather than quoted.
 *
 * If this ever starts returning a small p-value on materially more data, the
 * pooling argument above genuinely weakens and somebody should look again. It
 * returning p = 0.54 is what licenses the scanner to ignore the leg's line.
 */
export function familyHomogeneity({ points = TEASER_POINTS } = {}) {
  const { byLine } = tally(points);
  const cells = CROSS_BOTH_LINES
    .map(line => {
      const b = byLine.get(line);
      if (!b?.n) return null;
      return { line, decided: b.n - b.pushes, wins: b.wins };
    })
    .filter(cell => cell && cell.decided > 0);

  const decided = cells.reduce((sum, c) => sum + c.decided, 0);
  const wins = cells.reduce((sum, c) => sum + c.wins, 0);
  const p = wins / decided;

  let chiSquare = 0;
  for (const cell of cells) {
    const expectedWins = cell.decided * p;
    const expectedLosses = cell.decided * (1 - p);
    chiSquare += (cell.wins - expectedWins) ** 2 / expectedWins
      + ((cell.decided - cell.wins) - expectedLosses) ** 2 / expectedLosses;
  }
  const df = cells.length - 1;
  const pValue = chiSquarePValue(chiSquare, df);

  return {
    cells: cells.map(c => ({ ...c, rate_of_decided: c.wins / c.decided })),
    pooled_rate: p,
    chi_square: chiSquare,
    degrees_of_freedom: df,
    p_value: pValue,
    verdict: pValue > 0.05
      ? 'consistent with one common rate across all eight lines — pool them'
      : 'NOT consistent with one common rate — the pooling argument needs revisiting'
  };
}

/**
 * Upper tail of the chi-square distribution, by series expansion of the
 * regularised lower incomplete gamma. Local because pulling a stats dependency
 * into a module that needs exactly one tail probability is not a trade worth
 * making, and because a wrong p-value here would be invisible.
 */
function chiSquarePValue(x, df) {
  if (!(x > 0) || !(df > 0)) return null;
  const s = df / 2, z = x / 2;
  let term = 1 / s, sum = term;
  for (let k = 1; k < 500; k++) {
    term *= z / (s + k);
    sum += term;
    if (term < sum * 1e-15) break;
  }
  const lowerRegularised = sum * Math.exp(-z + s * Math.log(z) - logGamma(s));
  return Math.min(1, Math.max(0, 1 - lowerRegularised));
}

function logGamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / z);
}

/**
 * How correlated are two cross-both legs taken in the SAME week?
 *
 * Measured over every unordered pair of decided candidate legs sharing a
 * (season, week). This is the assumption `ticketProbabilities` makes and
 * cannot check for itself, so it is measured here instead of asserted.
 *
 * A CORRECTION TO THE FIGURE THIS MODULE WAS SPECIFIED WITH. The brief for
 * this module carried the numbers "joint 57.75% vs p-squared 55.79%, rho about
 * +0.082", concluding that same-week legs are positively correlated and that
 * p^n is therefore slightly conservative. Those two percentages are exactly
 * right — but for a different population: they reproduce to the basis point on
 * the CLASSIC six-line Wong window over 1999-2025, which is the leg set and
 * era in `nfl-teasers.js`'s header (n = 1,391, p = 74.69%). They do not
 * describe the eight-line cross-both family this module measures.
 *
 * On the family, over 1999-2024, the sign flips:
 *
 *     joint P(both win) 54.00%   p-squared 54.85%   rho -0.044
 *     (2,868 decided legs, 8,224 same-week pairs, 0 same-game pairs)
 *
 * with a week-block bootstrap 95% interval of about [-0.091, -0.004]. So on
 * this family independence is if anything slightly OPTIMISTIC, not
 * conservative: p-squared very mildly OVERSTATES the chance both legs land,
 * and `ticketProbabilities` therefore overstates ticket win probability by
 * roughly 0.85 percentage points on a two-leg ticket.
 *
 * That is small — it moves the break-even price by well under a point — but it
 * moves in the direction that costs money, so it is stated plainly rather than
 * left as a comforting note about conservatism. Anyone tempted to add a
 * correlation bonus to the EV should run this function first.
 *
 * Whichever sign it has, the operational rule from `nfl-teasers.js` stands and
 * is stricter than either: legs must come from DIFFERENT GAMES. The family
 * makes that automatic — a game's two sides can never both be candidates — and
 * `same_game_pairs` below is the standing proof of it.
 */
export function familyPairCorrelation({ points = TEASER_POINTS } = {}) {
  const { byWeek, byLine } = tally(points);
  let legs = 0, wins = 0, pairs = 0, bothWin = 0, sameGamePairs = 0;

  // The seasons actually observed, taken from the tally rather than restated
  // from the window constant — a reported range should be a measurement.
  const observed = { n: 0, first: Infinity, last: -Infinity };
  for (const line of CROSS_BOTH_LINES) {
    const bucket = byLine.get(line);
    if (!bucket?.n) continue;
    observed.n += bucket.n;
    observed.first = Math.min(observed.first, bucket.first);
    observed.last = Math.max(observed.last, bucket.last);
  }

  for (const week of byWeek.values()) {
    const decided = week.filter(leg => !leg.push);
    legs += decided.length;
    for (const leg of decided) wins += leg.win;
    for (let i = 0; i < decided.length; i++) {
      for (let j = i + 1; j < decided.length; j++) {
        if (decided[i].game === decided[j].game) { sameGamePairs++; continue; }
        pairs++;
        if (decided[i].win && decided[j].win) bothWin++;
      }
    }
  }

  const p = legs ? wins / legs : null;
  const joint = pairs ? bothWin / pairs : null;
  return {
    decided_legs: legs,
    pairs,
    same_game_pairs: sameGamePairs,          // 0, structurally — see the header
    leg_rate: p,
    joint_win_rate: joint,
    independent_joint: p == null ? null : p * p,
    rho: (p == null || joint == null) ? null : (joint - p * p) / (p * (1 - p)),
    seasons: seasonWindow(observed.n ? observed : null)
  };
}

/* --------------------------------------------------------- ticket pricing */

/**
 * The four things a multi-leg teaser ticket can do, under the owner's actual
 * DraftKings push rule.
 *
 * THE RULE. A pushed leg is REMOVED and the ticket reduces — a two-team teaser
 * with one push becomes a single on the survivor. It is NOT the Vegas rule
 * (push = whole ticket loses) and it is NOT "push = whole ticket voids" unless
 * every leg pushes. So:
 *
 *   loss       any leg loses. A pushed leg cannot rescue a lost one.
 *   win        every leg wins outright.
 *   both_push  every leg pushes; the ticket voids and the stake comes back.
 *   reduced    at least one push, no losses, not all pushes.
 *
 * For a two-leg ticket `reduced` means precisely "one leg pushed and the other
 * won", which is why `ticketEV` can price it with a single scalar. For n > 2
 * it lumps together one-push and two-push outcomes that pay differently, and
 * `ticketEV` refuses that case rather than quietly averaging over it.
 *
 * INDEPENDENCE IS ASSUMED and the legs are not quite independent — see
 * `familyPairCorrelation`, which measures rho = -0.044 on same-week family
 * legs over 1999-2024. Negative rho means this function slightly OVERSTATES
 * `win` for an all-must-win ticket (about 0.85pp on two legs). It is left
 * uncorrected because a 0.85pp adjustment estimated from 8,224 overlapping
 * pairs is not more trustworthy than the assumption it replaces — but it is
 * an overstatement, not a safety margin, and the price gate should be read
 * with that in mind.
 */
export function ticketProbabilities(legs) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new TypeError('ticketProbabilities needs at least two legs — a one-leg teaser is a straight bet');
  }
  let allWin = 1, allPush = 1, noLoss = 1;
  for (const leg of legs) {
    const w = leg?.w, t = leg?.t ?? 0;
    if (!Number.isFinite(w) || !Number.isFinite(t) || w < 0 || t < 0 || w + t > 1 + 1e-9) {
      throw new TypeError(`each leg needs { w, t } with w >= 0, t >= 0 and w + t <= 1; got ${JSON.stringify(leg)}`);
    }
    allWin *= w;
    allPush *= t;
    noLoss *= w + t;
  }
  // Everything that is not a loss, minus the two pure corners, is the reduced
  // bucket. Deriving it by subtraction rather than by enumerating push
  // patterns keeps the four numbers summing to exactly 1 by construction.
  const reduced = noLoss - allWin - allPush;
  return {
    win: allWin,
    reduced: Math.max(0, reduced),
    both_push: allPush,
    loss: 1 - noLoss
  };
}

/**
 * How a reduced ticket pays, as a profit multiple of the stake.
 *
 * UNVERIFIED. The push-removes-the-leg rule is confirmed for the owner's
 * DraftKings account; what the surviving single is then priced at is NOT.
 * Two plausible gradings:
 *
 *   'same_price'  the reduced single settles at the teaser's own price. Since
 *                 `reduced` already conditions on no leg having lost, a
 *                 two-leg reduced ticket always means the survivor WON, so
 *                 this pays full odds.
 *   'stake_back'  the reduced ticket is treated as no action and the stake is
 *                 returned. Profit 0.
 *
 * `stake_back` is the DEFAULT because it is the conservative of the two: it
 * gives up the whole reduced bucket. Pricing with `same_price` before somebody
 * has watched a real pushed ticket settle would be booking a payout the book
 * has not agreed to. `graded_loss` is the Vegas rule, kept as a stress floor —
 * it contradicts the confirmed DraftKings behaviour and should never be the
 * basis of a live price gate.
 *
 * The bucket is small — 1.32% of two-leg tickets at the family's measured
 * push rate — but the choice is not free. Measured on this database:
 *
 *     same_price   EV +5.36% at -110   break-even -123.2
 *     stake_back   EV +4.16% at -110   break-even -120.2
 *     graded_loss  EV +2.84% at -110   break-even -116.8
 *
 * So the two credible gradings differ by 1.2 percentage points of EV and 2.9
 * points of tolerable price, and the Vegas floor widens that to 2.5pp and 6.4
 * points. That is enough to decide whether a -122 quote is worth taking, which
 * is exactly the decision the scanner exists to make — which is why the
 * grading is worth confirming against a real settled ticket rather than
 * assumed. Until then the default gives the bucket away.
 */
const REDUCED_PAYOUTS = Object.freeze({
  stake_back: () => 0,
  same_price: profitMultiple => profitMultiple,
  graded_loss: () => -1
});

export const DEFAULT_REDUCED_PAYOUT = 'stake_back';

/** American odds to profit-per-unit-staked. -110 -> 0.909, +100 -> 1, +140 -> 1.4. */
export function profitMultiple(americanPrice) {
  if (!Number.isFinite(americanPrice) || Math.abs(americanPrice) < 100) {
    throw new TypeError(`americanPrice must be a real price at or beyond +/-100, got ${americanPrice}`);
  }
  return americanPrice > 0 ? americanPrice / 100 : 100 / Math.abs(americanPrice);
}

/** Profit multiple back to American odds, for reporting a break-even price. */
export function toAmerican(multiple) {
  if (!Number.isFinite(multiple) || multiple <= 0) return null;
  return multiple >= 1 ? 100 * multiple : -100 / multiple;
}

/**
 * Expected value per unit staked.
 *
 * Positive means the price is better than the measured edge requires; the
 * scanner's job is to find that price, not to talk itself into a worse one.
 */
export function ticketEV({ legs, americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT }) {
  const grade = REDUCED_PAYOUTS[reducedPayout];
  if (!grade) {
    throw new TypeError(`unknown reducedPayout '${reducedPayout}'; expected one of ` +
      Object.keys(REDUCED_PAYOUTS).join(', '));
  }
  const probabilities = ticketProbabilities(legs);
  if (legs.length > 2 && probabilities.reduced > 0) {
    // A three-leg ticket with one push reduces to a double and with two pushes
    // reduces to a single, and those pay differently. One scalar cannot say
    // which happened, so refuse rather than return a number that is wrong in a
    // way nobody would notice.
    throw new TypeError('ticketEV models the reduced bucket only for a two-leg ticket; ' +
      `a ${legs.length}-leg ticket with a possible push reduces to several different bets`);
  }

  const b = profitMultiple(americanPrice);
  const ev = probabilities.win * b
    + probabilities.reduced * grade(b)
    + probabilities.both_push * 0        // voided: stake back, zero profit
    + probabilities.loss * -1;

  return {
    ev,
    ev_percent: ev * 100,
    american_price: americanPrice,
    profit_multiple: b,
    reduced_payout: reducedPayout,
    reduced_payout_verified: false,
    probabilities,
    break_even_american: breakEvenAmericanPrice({ legs, reducedPayout })?.american ?? null
  };
}

/**
 * The worst price at which this ticket is still break-even.
 *
 * Solved rather than searched, because the EV is linear in the profit multiple
 * once the push grading is fixed. With W = P(win), R = P(reduced) and
 * L = P(loss):
 *
 *   stake_back   EV = W*b - L                 -> b = L / W
 *   same_price   EV = (W + R)*b - L           -> b = L / (W + R)
 *   graded_loss  EV = W*b - (L + R)           -> b = (L + R) / W
 *
 * This is the number the scanner should gate on. At the family's measured
 * rates it lands near -120, which is exactly why the price the book offers,
 * not the football, is the binding constraint on this strategy.
 */
export function breakEvenAmericanPrice({ legs, reducedPayout = DEFAULT_REDUCED_PAYOUT } = {}) {
  if (!REDUCED_PAYOUTS[reducedPayout]) {
    throw new TypeError(`unknown reducedPayout '${reducedPayout}'`);
  }
  const { win, reduced, loss } = ticketProbabilities(legs);
  const numerator = reducedPayout === 'graded_loss' ? loss + reduced : loss;
  const denominator = reducedPayout === 'same_price' ? win + reduced : win;
  if (!(denominator > 0)) return null;

  const multiple = numerator / denominator;
  return {
    profit_multiple: multiple,
    american: toAmerican(multiple),
    reduced_payout: reducedPayout,
    note: 'prices worse than this are negative EV even with the structural edge intact'
  };
}

/**
 * The convenience the scanner actually calls: two family legs at a quoted
 * price, priced off the pooled rate rather than either leg's own line.
 *
 * It takes no line arguments on purpose. If it took them it would eventually
 * be given them, and then somebody would notice that passing +1.5 twice makes
 * the number look better.
 */
export function familyTicketEV({ americanPrice, legCount = 2,
  reducedPayout = DEFAULT_REDUCED_PAYOUT, points = TEASER_POINTS } = {}) {
  const family = familyRate({ side: 'all', points });
  const legs = Array.from({ length: legCount },
    () => ({ w: family.win_share, t: family.push_share }));
  return {
    ...ticketEV({ legs, americanPrice, reducedPayout }),
    leg_count: legCount,
    leg_rate_of_decided: family.rate_of_decided,
    leg_sample: family.n,
    seasons: family.seasons,
    version: TEASER_LEG_RATES_VERSION
  };
}
