/**
 * Execution edge and stake sizing — profit that does not require out-predicting
 * the market.
 *
 * The spread question has been treated as one problem and it is two.
 *
 *   PREDICTION EDGE — settled negative. 21 component models measured against
 *   15,096 closing lines; 0 clear the materiality gate. The closing line is
 *   sharper than anything in this repository and that will not change.
 *
 *   EXECUTION EDGE — real, measured, and never exploited here. Books do not
 *   agree with each other. In a single 272-event snapshot across 6.4 books
 *   per market: spread lines differ by **0.813 points on average**, 37.5% of
 *   markets differ by a full point or more, and simply taking the best
 *   available price rather than a median one is worth **2.566% per bet**.
 *
 * That second number matters more than it looks. Vig on -110 both ways is
 * ~4.55%, and the break-even win rate is 52.38%. Best-price selection alone
 * moves the break-even to roughly **51.1%** — it does not manufacture a
 * winning model, but it removes about a quarter of the hurdle, and it
 * requires no forecasting skill whatsoever. It is arithmetic on prices that
 * are visible before the bet is placed.
 *
 * KEY NUMBERS ARE WHY LINE SHOPPING IS WORTH MORE THAN PRICE SHOPPING.
 * NFL margins are not smooth. Measured over 6,991 games in this database,
 * seasons 1999-2024 (GIANT PLAN 29: 2025 and 2026 are excluded here for the
 * same reason `margin-distribution.js` excludes them -- `game_lines.spread`
 * is corrupted in both, see `EXCLUSION_REASON` -- and these figures now match
 * that module's own measurement of the same population exactly):
 *
 *     margin of  3  ->  15.08% of games
 *     margin of  7  ->   9.03%
 *     margin of  6  ->   6.08%
 *     margin of 10  ->   5.59%
 *
 * A half point from 5.5 to 5.0 is worth almost nothing. A half point from
 * 3.5 to 3.0 is worth roughly half of that 15.08% mass, because it converts
 * a loss into a push on the single most common margin in football. Treating
 * all half points as equal is the mistake that makes line shopping look
 * marginal; weighting them by the actual margin distribution is what makes it
 * the largest available edge in this system.
 *
 * ON SIZING, and why the distinction above is load-bearing: Kelly staking
 * amplifies estimation error. Sizing off a MODEL probability the model has
 * never proven means sizing off an unvalidated number, and Kelly will
 * cheerfully bankrupt a bettor whose edge estimate is optimistic. Sizing off
 * an EXECUTION edge is different in kind — the price and line advantages are
 * observed at bet time, not forecast. So this module is deliberately built to
 * stake on measured execution advantage, and treats any model-derived edge as
 * requiring proven CLV before it may size anything at all.
 */
import { rows } from '../db/index.js';
import { fromMarginDistribution, expectedNetReturn, profitMultiple }
  from '../betting/nfl/contracts/spread-probabilities.js';
import { MEASUREMENT_SEASONS, EXCLUDED_SEASONS, EXCLUSION_REASON }
  from '../betting/nfl/strategy/teaser-leg-rates.js';

/**
 * GIANT PLAN 29. Every query in this file that builds a margin (or margin-
 * residual, or margin-by-posted-line) distribution used to read `game_lines`
 * with no season bound at all -- unlike `margin-distribution.js`, which
 * excludes 2025 and 2026 for a measured, specific reason: `game_lines.spread`
 * is corrupted in both (`EXCLUSION_REASON`, imported rather than restated so
 * the two modules cannot drift apart). That defect is in `spread`, not in
 * `team_score`/`opp_score`, so `marginDistribution()` below was not wrong on
 * its own terms -- but this file computes the empirical margin distribution
 * teaser and shopping-board pricing lean on, and having it answer a different
 * question (1999-2026, partial-and-corrupted-spread seasons included) than
 * every other consumer of the same "the NFL margin distribution" phrase
 * (1999-2024) is a correctness bug by inconsistency even where the raw column
 * queried is clean: two call sites asking "what is margin 3's share of
 * football" should not get two different answers depending on which file
 * they imported from. So every query below is bounded to `MEASUREMENT_SEASONS`
 * as well, and 2026 is additionally an in-progress season -- its completed
 * games so far are a handful of early weeks, not a representative sample of a
 * full season, which is its own reason not to fold them into a distribution
 * meant to describe the whole game.
 */
const SEASON_BOUND = 'AND season BETWEEN ? AND ?';
const seasonArgs = () => [MEASUREMENT_SEASONS.from, MEASUREMENT_SEASONS.to];

/**
 * An American price below 100 in magnitude is a parsing failure, not a price.
 *
 * `profitMultiple` in the probability contract has refused these since it was
 * written — "how a malformed feed stops rather than silently becoming a huge
 * edge" — and `riskModes` throws on them. The two functions that actually SIZE
 * MONEY did not, and they disagreed with the contract on the same input:
 * `impliedProb(-50)` returned 0.333 while `profitMultiple(-50)` returned null.
 *
 * What that bought: at -1, `dec()` returns 100, so a coin flip sized to the
 * 3-unit cap. The cap's only practical function was bounding the blast radius
 * of a bad feed. Now the feed stops instead.
 */
export function assertRealPrice(american) {
  if (!Number.isFinite(american) || Math.abs(american) < 100) {
    throw new TypeError(`american price ${JSON.stringify(american)} is below 100 in magnitude — ` +
      'that is a parsing failure, not a very short price, and it must not reach a stake');
  }
  return american;
}
const dec = american => (assertRealPrice(american) >= 0 ? 1 + american / 100 : 1 + 100 / -american);
export const impliedProb = american =>
  (assertRealPrice(american) >= 0 ? 100 / (american + 100) : -american / (-american + 100));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * A de-vigged spread is a coin flip. Neither this module nor
 * execution-slate-reasoning.js (which re-exports this exact binding) has a
 * forecast and both say so with a constant rather than by omission — moved
 * here from execution-slate-reasoning.js so `coverProbabilities` below can
 * use it directly without a circular import (that module already imports
 * FROM this one).
 */
export const NO_FORECAST_BASE = 0.5;

/* ------------------------------------------------- key-number distribution */

let marginCache = null;
/** Empirical distribution of absolute NFL margins, from this database. */
export function marginDistribution() {
  if (marginCache) return marginCache;
  const g = rows(`SELECT team_score, opp_score FROM game_lines
                  WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND home = 1
                  ${SEASON_BOUND}`, ...seasonArgs());
  const freq = new Map();
  for (const x of g) {
    const m = Math.abs(x.team_score - x.opp_score);
    freq.set(m, (freq.get(m) ?? 0) + 1);
  }
  const n = g.length || 1;
  marginCache = { n, pmf: new Map([...freq].map(([m, c]) => [m, c / n])) };
  return marginCache;
}

/**
 * What a line move from `from` to `to` is actually worth, in win probability.
 *
 * Counts the probability mass of margins that sit strictly between the two
 * numbers — those are the games whose result changes. Direction matters: a
 * bettor taking points wants the larger number.
 *
 * A push (landing exactly on an integer line) is counted as half a win, which
 * is the correct valuation of getting a stake back rather than losing it.
 */
export function lineMoveValue(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return 0;
  const { pmf } = marginDistribution();

  // Work on the SIGNED number line. An earlier version took Math.abs() of both
  // endpoints, which silently collapsed sign and priced every zero-crossing
  // move at zero: moving -1.5 → +1.5 is a three-point swing that flips margins
  // 0 and ±1, and it was being reported as worth nothing. That inverted the
  // ranking whenever books disagreed about which team was favoured at all.
  //
  // A side taking `line` points covers when its own signed margin exceeds
  // -line, so the result changes exactly for margins between -hi and -lo.
  const lo = Math.min(from, to), hi = Math.max(from, to);

  // The stored distribution is over |margin|. Absent knowing whether this bet
  // is on the favourite or the underdog, split each magnitude symmetrically —
  // the neutral assumption, and a close one near a pick'em where these
  // disagreements actually occur.
  let mass = 0;
  for (const [absMargin, p] of pmf) {
    const signed = absMargin === 0 ? [0] : [absMargin, -absMargin];
    const share = absMargin === 0 ? p : p / 2;
    for (const m of signed) {
      if (m > -hi && m < -lo) mass += share;                 // outcome flips outright
      else if (m === -hi || m === -lo) mass += share * 0.5;  // push boundary
    }
  }
  return r4(mass);
}

/**
 * Codex audit finding E5 (2026-09-10): `lineMoveValue` above folds a push
 * transition into a flat "half a win" scalar -- a defensible RANKING proxy
 * (it is not dollar-accurate, but it orders numbers correctly for "which
 * book's line is worth more") that is wrong to feed directly into a win
 * probability used for staking, because a loss-to-push transition (worth a
 * full "avoid the loss," i.e. +1 unit of return relative to losing) and a
 * push-to-win transition (worth a full win, i.e. +profit-multiple units) are
 * NOT the same size in dollar terms, and neither is "half a win."
 *
 * This exposes the three states separately instead of blending them, so a
 * caller that actually knows the price (and therefore the real profit
 * multiple) can compute exact EV as `p_win*profitMultiple - p_loss` (pushes
 * contribute exactly zero, never an approximated half-win), per the audit's
 * own fix instruction. `lineMoveValue` is kept unchanged for its existing
 * ranking-only consumers (nfl-execution.js, nfl-espn-line-watch.js,
 * polymarket-lines.js) -- this is an additive, more precise sibling for the
 * one consumer (`bestExecution` below) that actually stakes money on the
 * result.
 *
 * `betterLine` must be the more favorable number to the bettor's own side
 * (the caller already knows this from its own takingPoints logic — this
 * function no longer re-derives direction from raw magnitude, which is what
 * let an earlier version of the sibling function collapse sign on a
 * zero-crossing move).
 */
export function lineMoveTransitions(worseLine, betterLine) {
  if (!Number.isFinite(worseLine) || !Number.isFinite(betterLine) || worseLine >= betterLine) {
    return { loss_to_win: 0, loss_to_push: 0, push_to_win: 0 };
  }
  const { pmf } = marginDistribution();
  const lo = worseLine, hi = betterLine;
  let lossToWin = 0, lossToPush = 0, pushToWin = 0;
  for (const [absMargin, p] of pmf) {
    const signed = absMargin === 0 ? [0] : [absMargin, -absMargin];
    const share = absMargin === 0 ? p : p / 2;
    for (const m of signed) {
      // A signed margin m covers a bet taking `line` points when m > -line,
      // pushes when m === -line, loses when m < -line (bettor's own side,
      // already signed consistently by the caller).
      if (m > -hi && m < -lo) lossToWin += share;       // loss at worseLine, win at betterLine
      else if (m === -lo) pushToWin += share;           // push at worseLine, win at betterLine
      else if (m === -hi) lossToPush += share;           // loss at worseLine, push at betterLine
    }
  }
  return { loss_to_win: r4(lossToWin), loss_to_push: r4(lossToPush), push_to_win: r4(pushToWin) };
}

/**
 * The residual distribution: how far actual margins land from the number the
 * market posted.
 *
 * Codex correction C05. The previous baseline combined an assumed coin-flip
 * anchor with the UNCONDITIONAL distribution of ABSOLUTE margins, and those two
 * things do not describe the same random variable. Migrating mass between two
 * distant lines under that mixture could remove more probability than the
 * anchor had: `coverProbabilities(3, -10.5)` returned win -0.125, loss 1.125,
 * push 0 on the preserved empirical fixture. A negative probability is not a
 * number that needs clipping; it is a signal that the object producing it was
 * never a distribution.
 *
 * What replaces it is one coherent object. For each completed game with both
 * a score and a posted spread, the residual is
 *
 *     r = home margin + home spread
 *
 * -- zero when the game landed exactly on the number, positive when the home
 * side beat it. This is a genuine signed distribution, and every handicap is
 * then answered from it rather than from a separate anchoring assumption.
 */
let residualCache = null;
export function marginResidualDistribution() {
  if (residualCache) return residualCache;
  const games = rows(`SELECT team_score, opp_score, spread FROM game_lines
    WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND spread IS NOT NULL AND home = 1
    ${SEASON_BOUND}`, ...seasonArgs());
  const freq = new Map();
  for (const g of games) {
    const residual = (g.team_score - g.opp_score) + g.spread;
    if (!Number.isFinite(residual)) continue;
    freq.set(residual, (freq.get(residual) ?? 0) + 1);
  }
  const n = [...freq.values()].reduce((s, c) => s + c, 0);
  residualCache = { n, pmf: n ? new Map([...freq].map(([r, c]) => [r, c / n])) : new Map() };
  return residualCache;
}

/**
 * The empirical margin distribution for games actually posted NEAR a line.
 *
 * CORRECTED 2026-09-10, after an adversarial review measured what the first
 * version cost. That version shifted ONE pooled residual distribution by the
 * reference line. Shifting is translation-invariant by construction, so the
 * shape never changed and every half point everywhere came out worth exactly
 * the same 4.57%:
 *
 *     K    half point at K, old model    actually lands on K
 *     3          4.57%                        10.21%   (n=656)
 *     5          4.57%                         0.00%
 *     7          4.57%                         9.03%
 *     4          4.57%                         0.88%
 *
 * That is precisely "treating all half points as equal" -- the mistake this
 * file's own header calls out as the one that makes line shopping look
 * marginal. Key numbers do not move with the spread. A game posted at -2.5
 * cannot land on -2.5; a game posted at -3 lands on it one time in ten. The
 * spikes sit at absolute margins, and shifting a pooled shape drags them to
 * wherever the line happens to be.
 *
 * Measured cost on 40 real sides from the live tape: the best-book pick
 * changed on 15 of them, and the old ranking was better on 12 of those 15 --
 * about 1.88% per changed bet, against a total measured execution edge of
 * 2.566%. It sold the 3 for a 7% price gain more than once.
 *
 * The fix is not to go back. The old `coverProbabilities` really could return
 * negative probabilities, and the old ranking really did contradict its own
 * economics. What this does instead is condition on the line rather than
 * translate: it takes the margins of games that were actually POSTED at or
 * near this number, so the key-number structure appears where the data puts
 * it, and the location comes from the market's own estimate.
 *
 * The window widens only as far as it must to reach `MIN_GAMES_FOR_LINE`,
 * and the result reports how far it had to go, because a distribution built
 * from a 6-point window is a weaker statement than one built from an exact
 * match and should not be able to pretend otherwise.
 */
const MIN_GAMES_FOR_LINE = 60;
const MAX_LINE_WINDOW = 6;

let marginByLineCache = null;
function marginsByPostedLine() {
  if (marginByLineCache) return marginByLineCache;
  const games = rows(`SELECT team_score, opp_score, spread FROM game_lines
    WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND spread IS NOT NULL AND home = 1
    ${SEASON_BOUND}`, ...seasonArgs());

  // BOTH sides of every game, each from its own point of view.
  //
  // A game posted at home -3 is two contracts: the home side at -3 with a
  // margin of +m, and the away side at +3 with a margin of -m. Indexing only
  // the home row would answer every away question with home numbers.
  //
  // That was a real defect, not a hypothetical: a review found
  // `coverProbabilities` returning the SAME win probability for both sides of
  // one game, so home win + away win + push summed to 0.983 rather than 1, and
  // `reconcileOppositeSides` -- which the contract module ships precisely to
  // catch this -- was never called. Every away side received the home side's
  // answer, and `execution-slate-reasoning.js` turned that into the conditional
  // probability Kelly staking consumes.
  //
  // Building both perspectives here fixes it at the source: the two are exact
  // mirror images, so the pair reconciles by construction rather than by a
  // check somebody has to remember to run.
  const byLine = new Map();
  const add = (line, margin) => {
    if (!Number.isFinite(line) || !Number.isFinite(margin)) return;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(margin);
  };
  for (const g of games) {
    const margin = g.team_score - g.opp_score;
    add(g.spread, margin);    // the home side, at its own posted number
    add(-g.spread, -margin);  // the away side, at its own posted number
  }
  marginByLineCache = byLine;
  return byLine;
}

/**
 * The integer signed-margin distribution implied for one game, given the
 * reference handicap posted for the side being priced.
 *
 * `referenceLine` is in the BACKED side's convention (larger is better), so
 * the equivalent posted home spread for that side is `referenceLine` itself
 * when the side is home. Margins are collected from that side's perspective.
 */
export function noForecastMarginDistribution(referenceLine) {
  if (!Number.isFinite(referenceLine)) return { ok: false, reason: 'reference_line_not_finite' };
  const byLine = marginsByPostedLine();
  if (!byLine.size) {
    return { ok: false, reason: 'no_qualified_distribution_available',
      detail: 'no completed game in this database carries both a final score and a posted spread, so ' +
        'there is no empirical distribution to price against' };
  }

  // Widen symmetrically until there is enough to estimate from. A team posted
  // at -3 and one posted at -3.5 are close enough to pool; one posted at -3
  // and one at -10 are not, and the window stops long before that.
  const margins = [];
  let window = 0;
  for (; window <= MAX_LINE_WINDOW; window += 0.5) {
    margins.length = 0;
    for (const [line, values] of byLine) {
      if (Math.abs(line - referenceLine) <= window) margins.push(...values);
    }
    if (margins.length >= MIN_GAMES_FOR_LINE) break;
  }
  if (!margins.length) {
    return { ok: false, reason: 'no_games_near_this_line', reference_line: referenceLine };
  }

  const counts = new Map();
  for (const m of margins) counts.set(m, (counts.get(m) ?? 0) + 1);
  const total = margins.length;
  const pmf = new Map([...counts].map(([m, c]) => [m, c / total]));
  return {
    ok: true, margins: pmf, games: total,
    reference_line: referenceLine,
    // How far the window had to open to find enough games. Reported because a
    // distribution pooled across +/-6 points is a weaker statement than one
    // built from an exact match, and a caller should be able to tell.
    line_window: window,
    exact_line_games: (byLine.get(referenceLine) ?? []).length
  };
}

/** Test-only: drop the cached distributions after changing fixtures. */
export function resetMarginResidualCache() { residualCache = null; marginByLineCache = null; }

/**
 * Full three-state win/push/loss probabilities for backing a side at
 * `targetLine`, given the market's reference handicap for that side.
 *
 * Returns `{ ok: false, reason }` rather than a repaired triple when the
 * inputs cannot support a valid distribution. C05 is explicit: "Invalid
 * probabilities must fail validation; clipping them is not an adequate
 * statistical repair."
 *
 * This is a NO-FORECAST baseline. It says what the market's own number
 * implies, not what any Gridiron model believes, and callers are expected to
 * treat it as a diagnostic until a qualified per-game distribution replaces it.
 */
export function coverProbabilities(referenceLine, targetLine) {
  if (!Number.isFinite(referenceLine) || !Number.isFinite(targetLine)) return null;
  const built = noForecastMarginDistribution(referenceLine);
  if (!built.ok) return null;
  const result = fromMarginDistribution(built.margins, targetLine);
  if (!result.ok) return null;
  const { win, push, loss } = result.probabilities;
  return { win: r4(win), loss: r4(loss), push: r4(push) };
}

/**
 * The reference line's own three-state breakdown. Kept as a named export
 * because callers asking about the median book itself should get the identical
 * computation rather than a second copy of it.
 */
export function referenceCoverBaseline(line) {
  return coverProbabilities(line, line);
}

/** The classic key numbers, ranked by how much probability mass they carry. */
export function keyNumbers(limit = 8) {
  const { pmf } = marginDistribution();
  return [...pmf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([margin, p]) => ({ margin, share: r4(p) }));
}

/** The most common line in a quote set; ties broken toward the value nearest zero. */
function modeOfLines(lines) {
  const counts = new Map();
  for (const l of lines) if (Number.isFinite(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0][0];
}

/* ---------------------------------------------------------- best execution */

/**
 * Pick the best available quote for one side, valuing the LINE by the margin
 * distribution and the PRICE by its payout, rather than assuming a better
 * number always beats a better price.
 *
 * `quotes` is [{book, line, american_price}] for a single side of a single
 * market. Returns the best book plus what choosing it is worth against the
 * median book — which is the honest counterfactual, since taking a random
 * book is what a bettor without a shopping habit actually does.
 */
export function bestExecution(quotes, { takingPoints = true } = {}) {
  const usable = (quotes ?? []).filter(q => Number.isFinite(q.american_price));
  if (usable.length < 2) return null;

  const withLines = usable.filter(q => Number.isFinite(q.line));
  const refLine = withLines.length
    ? [...withLines].map(q => q.line).sort((a, b) => a - b)[Math.floor(withLines.length / 2)]
    : null;
  const prices = usable.map(q => dec(q.american_price)).sort((a, b) => a - b);
  const refPrice = prices[Math.floor(prices.length / 2)];

  // Codex audit finding E5: transform each raw quoted line into the bettor's
  // OWN signed convention, where a LARGER value is always more favorable
  // (matching the "covers when margin > -line" formula lineMoveTransitions/
  // coverProbabilities are built on) -- takingPoints=true means the raw line
  // already is that convention (spreads, and totals' Under side); false
  // means it is inverted (totals' Over side, which wants a SMALLER raw
  // number). Computed once here so win/loss/push and line_edge use the
  // identical direction, rather than two independently-maintained branches.
  const bettorSigned = line => (Number.isFinite(line) ? (takingPoints ? line : -line) : null);
  const refSigned = bettorSigned(refLine);

  // GIANT PLAN 29. What blindly taking the MEDIAN book's own line and price
  // would return, under the identical distribution every quote below is
  // scored against. Subtracting this from a quote's own expected_net_return
  // is what `edge_vs_median` is: the improvement from shopping, with the
  // reference line's own historical cover-rate level (see the note on
  // `edge_vs_median` on the returned object) present in both terms and
  // cancelling out of the difference.
  const referenceProbabilities = refSigned != null ? referenceCoverBaseline(refSigned) : null;
  const referenceExpectedReturn = referenceProbabilities
    ? referenceProbabilities.win * (refPrice - 1) - referenceProbabilities.loss
    : null;

  const scored = usable.map(q => {
    // Value of this book's line versus the median line, in win probability.
    const lineEdge = refLine != null && Number.isFinite(q.line)
      ? (takingPoints ? (q.line > refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine))
        : (q.line < refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine)))
      : 0;
    // Value of this book's price versus the median price, as a return premium.
    const priceEdge = (dec(q.american_price) / refPrice) - 1;
    // Codex audit finding E5: the exact three-state breakdown for THIS book's
    // number, instead of folding a push into line_edge's "half a win" ranking
    // proxy. null only when there is no reference line to migrate from at all
    // (coverProbabilities itself handles "this book matches the reference
    // exactly" by returning the reference baseline directly).
    const qSigned = bettorSigned(q.line);
    const probabilities = refSigned != null && qSigned != null ? coverProbabilities(refSigned, qSigned) : null;

    // Codex correction C05: rank by EXPECTED NET RETURN at this book's actual
    // line AND actual price, under the same distribution, rather than by a
    // points-versus-price heuristic.
    //
    // The heuristic was `line_edge * 2 + price_edge`, and it contradicted its
    // own attached economics: on the audit's fixture it ranked +2.5/+100 above
    // +3/-150 even though the expected returns it had already computed were
    // -0.1500 and -0.1417 respectively. A ranking that disagrees with the
    // arithmetic beside it is worse than no ranking, because it looks reasoned.
    const expected = probabilities
      ? expectedNetReturn({ win: probabilities.win, loss: probabilities.loss,
        americanPrice: q.american_price })
      : null;

    // GIANT PLAN 29. `expected_net_return` above is the ABSOLUTE expected
    // return of this book's contract, under a distribution built from the
    // reference line's own historical cover rate -- which the 2026-09-10
    // audit measured as carrying a real underdog bias (+6.5 covers 53.53%
    // historically, +10 covers 55.28%, both against a 52.38% break-even). That
    // bias is a property of WHICH REFERENCE LINE this side sits at, not of how
    // well this book was shopped, and it is the same for every book quoting
    // this side -- so it is fine to rank BOOKS WITHIN one side by
    // expected_net_return (the bias is a shared additive term and the order
    // is unaffected), but it is not fine to rank SIDES OR EVENTS against each
    // other by it, because two sides can sit at reference lines with
    // different bias levels. `edge_vs_median` is the number that isolates the
    // part that actually is about shopping: this book's own expected return
    // minus what blindly taking the median book would have returned, both
    // priced under the identical distribution, so the shared bias term
    // present in both cancels out of the subtraction. See `bestExecution`'s
    // own docstring and `nfl-shopping-board.js`, which leads its cross-side
    // leaderboard on this field for exactly this reason.
    const edgeVsMedian = expected != null && referenceExpectedReturn != null
      ? expected - referenceExpectedReturn : null;

    return { ...q,
      // Retained as DIAGNOSTICS. The plan: "Until qualified, present price/line
      // improvement as a diagnostic, not modeled profit." They describe how
      // this book differs from the median; they are not an edge over the
      // market and must never be summed into one.
      line_edge: r4(lineEdge), price_edge: r4(priceEdge),
      win_probability: probabilities?.win ?? null,
      loss_probability: probabilities?.loss ?? null,
      push_probability: probabilities?.push ?? null,
      expected_net_return: r4(expected),
      edge_vs_median: r4(edgeVsMedian),
      // The old field name, kept so nothing silently reads a different number
      // under the same name: it is now null, because the quantity it used to
      // hold was never a total edge.
      total_edge: null };
  }).sort((a, b) => {
    // A quote we cannot price coherently never outranks one we can.
    if (a.expected_net_return == null && b.expected_net_return == null) return 0;
    if (a.expected_net_return == null) return 1;
    if (b.expected_net_return == null) return -1;
    return b.expected_net_return - a.expected_net_return;
  });

  const priced = scored.filter(q => q.expected_net_return != null);
  if (!priced.length) {
    // A contract with NO handicap -- a moneyline -- has nothing to price with a
    // margin distribution, and needs none. Both books are selling the identical
    // outcome; the only thing that differs is what they pay for it, so the best
    // book is simply the best price. That is the purest form of the execution
    // edge measured here, and it requires no forecast whatsoever.
    //
    // CORRECTED 2026-09-10. The first version of this refusal treated "no
    // distribution" as "cannot rank", which killed moneyline shopping outright:
    // an adversarial review found all 30 h2h sides on the live tape returning a
    // refusal where every one had previously produced a best book. Refusing to
    // guess at a probability is right; refusing to compare two prices for the
    // same outcome is not.
    //
    // The same applies to any contract this module cannot price. It owns ONE
    // distribution -- NFL winning margins -- so it can value a spread line and
    // nothing else. A total of 44.5 is not a margin of 44.5, and the first
    // version of this refusal quietly handed totals a probability drawn from
    // the margin distribution anyway. Refusing was the improvement; refusing
    // ENTIRELY was a regression, because best-price-on-an-identical-contract
    // needs no distribution at all.
    //
    // So: compare only like for like. Quotes at the same number are the same
    // contract and the better price is simply better. Quotes at different
    // numbers are different contracts, and this module says so rather than
    // guessing what the difference is worth.
    const withLine = usable.filter(q => Number.isFinite(q.line));
    const noLines = withLine.length === 0;
    const modalLine = noLines ? null : modeOfLines(withLine.map(q => q.line));
    const comparable = noLines ? scored : scored.filter(q => q.line === modalLine);

    if (comparable.length >= 2) {
      const byPrice = [...comparable].sort((a, b) => dec(b.american_price) - dec(a.american_price));
      const others = scored.filter(q => !comparable.includes(q));
      return {
        best: byPrice[0], median_line: refLine, median_price_decimal: r4(refPrice),
        books_compared: usable.length, all: [...byPrice, ...others],
        // Still not a qualified edge -- it says nothing about who wins. It says
        // this book pays more than that one for the SAME contract, which is a
        // fact about the market rather than a forecast about the game.
        qualified: false,
        ranked_by: 'price_only',
        compared_at_line: modalLine,
        lines_not_compared: [...new Set(others.map(q => q.line))].filter(l => l != null).sort((a, b) => a - b),
        qualification_note: noLines
          ? 'no handicap on this contract, so the books differ only in price. Ranked by payout alone; ' +
            'this identifies the best obtainable price, never an edge over the market.'
          : `this module prices NFL margins and cannot value a ${modalLine} on this market, so books are ` +
            'ranked by price at the most common number only. Quotes at other numbers are listed but not ' +
            'compared — pricing them against each other would require a distribution this module does ' +
            'not have.'
      };
    }
    // Anything else genuinely cannot be ranked: returning the first book with a
    // null number beside it would let a caller treat an unpriceable slate as a
    // ranked one.
    return { best: null, median_line: refLine, median_price_decimal: r4(refPrice),
      books_compared: usable.length, all: scored,
      qualified: false,
      reason: 'no_qualified_distribution — no book could be priced under a valid spread distribution, ' +
        'so there is no expected return to rank by' };
  }

  return {
    best: scored[0], median_line: refLine, median_price_decimal: r4(refPrice),
    books_compared: usable.length,
    expected_net_return: scored[0].expected_net_return,
    // GIANT PLAN 29: the leaderboard-safe number. See `edge_vs_median`'s own
    // comment above `scored`'s construction for why `expected_net_return`
    // cannot be compared ACROSS sides/events and this can.
    edge_vs_median: scored[0].edge_vs_median,
    // Explicitly NOT qualified: these probabilities come from the market's own
    // posted number and an empirical residual distribution, not from a
    // qualified Gridiron forecast. Sizing paths must refuse to treat this as
    // modeled profit; it ranks obtainable prices, it does not claim an edge.
    qualified: false,
    qualification_note: 'no-forecast baseline: probabilities are implied by the reference line itself, ' +
      'so the ranking identifies the best obtainable contract, never a positive expectation',
    all: scored
  };
}

/* --------------------------------------------------------------- staking */

/**
 * Fractional Kelly.
 *
 * Full Kelly is the growth-optimal stake only when the win probability is
 * known exactly. It never is. Kelly's downside is violently asymmetric to
 * overestimated edge — a bettor who thinks the edge is 4% when it is 1% is
 * not slightly over-betting, they are betting roughly four times too much and
 * will experience drawdowns that end the bankroll. Quarter Kelly is the
 * default here because it retains most of the growth while making the
 * variance survivable, which is the trade every serious staking treatment
 * lands on.
 */
export function kellyFraction({ winProbability, americanPrice, fraction = 0.25 }) {
  const p = Number(winProbability);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return { stake_fraction: 0, reason: 'invalid probability' };
  const b = dec(americanPrice) - 1;
  if (!(b > 0)) return { stake_fraction: 0, reason: 'invalid price' };
  const full = (b * p - (1 - p)) / b;
  if (full <= 0) return { stake_fraction: 0, full_kelly: r4(full), reason: 'no edge at this price — do not bet' };
  return {
    stake_fraction: r4(full * fraction),
    full_kelly: r4(full),
    fraction_used: fraction,
    edge: r4(p - impliedProb(americanPrice)),
    note: 'Fractional Kelly. Full Kelly assumes the probability is exact; it never is.'
  };
}

/**
 * The staking decision, with the guardrail that matters most here.
 *
 * `source` says where the win probability came from, and it changes what is
 * allowed:
 *
 *   'execution'  the advantage is observed at bet time — a better line or
 *                price than the market median. Sizable, because it is
 *                measured rather than forecast.
 *
 *   'model'      the advantage is a model estimate. Since 0 of 21 spread
 *                models beat the closing line and no prop CLV has ever been
 *                recorded, a model estimate has NOT earned the right to size
 *                a bet. Returns zero stake until `provenClv` is supplied.
 *
 * This is deliberately restrictive. The failure mode it prevents is the
 * ordinary one: a plausible model, sized with Kelly, run until the bankroll
 * is gone.
 *
 * The gate is an ALLOW-list on 'execution', not a deny-list on 'model'. It
 * used to check `source === 'model'`, which meant any caller could size a
 * full, unvalidated bet just by passing a `source` that was not literally the
 * string 'model' -- a typo, a new opportunity kind, anything. Only the one
 * source this repository has actually earned -- a measured, at-bet-time price
 * edge -- skips the CLV-proof requirement; every other value, recognised or
 * not, is treated as an unproven model estimate.
 */
export function stakeFor({ winProbability, americanPrice, source = 'model',
  bankrollUnits = 100, fraction = 0.25, provenClv = null, maxUnitsPerBet = 3 } = {}) {
  if (source !== 'execution' && !(provenClv > 0)) {
    return {
      units: 0, blocked: true,
      reason: 'A model-derived probability has not demonstrated closing-line value. ' +
        'Spreads: 0 of 21 models beat 15,096 closing lines. Props: no CLV recorded yet. ' +
        'Sizing on an unvalidated edge is how Kelly ruins bankrolls — record positive median ' +
        'CLV over ~200 settled bets first.'
    };
  }
  const k = kellyFraction({ winProbability, americanPrice, fraction });
  if (!k.stake_fraction) return { units: 0, blocked: true, reason: k.reason, ...k };
  const raw = k.stake_fraction * bankrollUnits;
  const units = Math.min(raw, maxUnitsPerBet);
  return {
    units: r4(units),
    capped: units < raw,
    bankroll_units: bankrollUnits,
    ...k,
    note: units < raw
      ? `Capped at ${maxUnitsPerBet}u. A cap is not timidity — it bounds the damage from a single ` +
        'mis-estimated probability, which is the error Kelly is least forgiving of.'
      : undefined
  };
}

/**
 * Risk modes, with the price of each one attached.
 *
 * This exists because of a reasonable question that has an unreasonable answer:
 * "the model says it is too cautious — can we turn the caution down and see how
 * it does?" No, and the reason is worth stating exactly, because the intuition
 * behind the question is sound and only the mechanism is wrong.
 *
 * The calibration slope is not a caution setting. It is a measurement of how
 * well the model's stated probabilities match reality. A slope of 1.37 does not
 * mean a dial is turned to "cautious"; it means the numbers are mis-scaled, and
 * the fix is to rescale them (which the calibration layer already does) rather
 * than to multiply them by something bigger. Turning a "risk" knob on a model
 * that is no more accurate than the betting line does not produce more profit at
 * more risk. It produces the same negative expectation with more variance — you
 * lose the same money, faster and less predictably. There is no setting that
 * converts a coin flip into an edge.
 *
 * What IS a real dial is how hard to bet an edge you have already proven. That
 * is the Kelly fraction, and unlike the calibration slope it genuinely trades
 * growth against drawdown along a curve with known closed form:
 *
 *   growth, as a share of the maximum:      f(2 − f)
 *   chance of EVER falling to a fraction a: a^(2/f − 1)
 *
 * Both are standard results for fractional Kelly, and together they are why
 * quarter-Kelly is the default everywhere serious. The second one is the reason
 * this function exists: full Kelly gives up nothing in growth and carries a 50%
 * chance of halving the bankroll at some point, which nobody consents to when it
 * is written down, and almost everybody consents to when it is not.
 *
 * Note the asymmetry at the top end — doubling past full Kelly does not double
 * anything. At f = 2 the growth term f(2 − f) is exactly zero: a bettor with a
 * real edge, betting twice Kelly, has no long-run growth at all. That is the
 * cliff this ladder deliberately stops short of.
 *
 * These modes apply ONLY to edges measured at bet time — a better price than the
 * market, a teaser through the key numbers. They are not a route around the
 * staking gate: a model-derived probability with no proven closing-line value
 * stakes zero in every mode, including the aggressive ones.
 */
export const RISK_MODES = {
  cautious: {
    label: 'Cautious', fraction: 0.25,
    plan: 'The default, and the right one until real money has run through the ledger.'
  },
  aggressive: {
    label: 'Aggressive', fraction: 0.5,
    plan: 'Three quarters of the growth for sixteen times the chance of halving. Defensible ' +
      'once an edge has held up over a few hundred settled bets.'
  },
  ultra: {
    label: 'Ultra', fraction: 1.0,
    plan: 'Growth-optimal only if the win probability is exactly right, which it never is. ' +
      'Overestimate the edge here and the over-betting is multiplicative, not additive.'
  }
};

/**
 * What each mode actually costs, computed rather than asserted.
 *
 * @param edgeWinRate the win rate of the edge being staked; defaults to the
 *   measured Wong teaser leg rate squared, since that is the only positive
 *   edge in this codebase and therefore the only one any of this applies to.
 */
export function riskModes({ winProbability = null, americanPrice = -110, bankrollUnits = 100 } = {}) {
  const p = winProbability == null ? null : Number(winProbability);
  const price = Number(americanPrice), bankroll = Number(bankrollUnits);
  if (p != null && (!Number.isFinite(p) || p <= 0 || p >= 1)) throw new RangeError('winProbability must be between 0 and 1');
  if (!Number.isFinite(price) || price === 0 || (price > -100 && price < 100)) throw new RangeError('americanPrice is not valid American odds');
  if (!Number.isFinite(bankroll) || bankroll <= 0) throw new RangeError('bankrollUnits must be positive');
  const modes = Object.entries(RISK_MODES).map(([id, m]) => {
    const growth = +(m.fraction * (2 - m.fraction)).toFixed(3);
    // a^(2/f − 1) for a = 0.5 and a = 0.25.
    const exponent = 2 / m.fraction - 1;
    const halve = +Math.pow(0.5, exponent).toFixed(4);
    const quarter = +Math.pow(0.25, exponent).toFixed(4);
    const stake = p != null
      ? kellyFraction({ winProbability: p, americanPrice: price, fraction: m.fraction })
      : null;
    return {
      id, label: m.label, kelly_fraction: m.fraction, plan: m.plan,
      growth_share_of_max: growth,
      theoretical_chance_of_ever_halving: halve,
      theoretical_chance_of_ever_losing_three_quarters: quarter,
      stake_units: stake?.stake_fraction != null ? +Math.min(bankroll, stake.stake_fraction * bankroll).toFixed(2) : null,
      // Said in words, because a probability of 0.5 for "you will at some point
      // halve your bankroll" is the kind of number people skim past.
      reads_as: `${Math.round(growth * 100)}% of the best possible growth, and a ` +
        `${halve >= 0.01 ? `${Math.round(halve * 100)}%` : 'well under 1%'} theoretical chance of ` +
        'halving under idealized fractional-Kelly assumptions.'
    };
  });
  return {
    modes,
    risk_note: 'Drawdown figures are idealized fractional-Kelly approximations. Real outcomes can be worse when bets are correlated or the estimated edge is wrong.',
    applies_to: 'Edges measured at bet time — a better price than the market, or a teaser through ' +
      'the key numbers. Model forecasts stake zero in every mode until they show closing-line value.',
    the_question_this_answers:
      'Turning down the model\'s "caution" is not available, because the calibration slope is a ' +
      'measurement rather than a setting. A model no sharper than the betting line does not become ' +
      'profitable when bet harder — it loses at the same rate with more variance. What can be ' +
      'turned up is how hard a PROVEN edge is bet, and that is this ladder.',
    the_cliff: 'At twice full Kelly the growth term f(2 − f) is exactly zero: a real edge, bet that ' +
      'hard, compounds to nothing. This ladder stops at 1.0 for that reason.'
  };
}

/**
 * The real break-even, measured from actual recorded prices rather than the
 * -110 convention.
 *
 * "52.4%" is quoted everywhere and it assumes every spread is priced -110
 * both ways. Measured over 10,590 games in this database carrying real
 * `spread_odds` (2006-2025), only 13.2% were actually -110. A quarter sat
 * at -105, 13% at -115 or worse, and 24% carried plus money on one side
 * because the book shaded the number. Mean implied probability per side is
 * **51.33%**, i.e. a real two-sided vig near 2.66%.
 *
 * So the hurdle for a bettor who takes the price in front of them is roughly
 * a point of win probability lower than the number everyone repeats. That is
 * not a rounding difference — a full point of required win rate is a large
 * share of any realistic edge.
 *
 * (Methodological note, because it is an easy error: American odds cannot be
 * averaged directly — the scale is discontinuous at zero, so a mean over
 * mixed +/- prices is meaningless. Everything here averages implied
 * probabilities and converts back.)
 */
export function realBreakEven() {
  const g = rows(`SELECT spread_odds FROM game_lines WHERE spread_odds IS NOT NULL`);
  if (!g.length) return { error: 'no recorded spread prices' };
  const probs = g.map(x => impliedProb(x.spread_odds));
  const meanProb = probs.reduce((s, x) => s + x, 0) / probs.length;
  const atMinus110 = g.filter(x => x.spread_odds === -110).length;
  return {
    games: g.length,
    mean_implied_per_side: r4(meanProb),
    real_two_sided_vig: r4(2 * meanProb - 1),
    real_breakeven: r4(meanProb),
    convention_breakeven: 0.5238,
    share_priced_at_minus_110: r4(atMinus110 / g.length),
    note: 'The -110 convention overstates the hurdle. Only 13.2% of recorded games were ' +
      'actually priced there.'
  };
}

/** What the execution edge is worth, summarised for a human. */
export function executionEdgeSummary() {
  const keys = keyNumbers(6);
  return {
    key_numbers: keys,
    half_point_across_3: lineMoveValue(2.5, 3.5),
    half_point_across_7: lineMoveValue(6.5, 7.5),
    half_point_across_5: lineMoveValue(4.5, 5.5),
    breakeven: realBreakEven(),
    note: 'Not all half points are equal. Crossing 3 is worth an order of magnitude more than ' +
      'crossing 5, because 3 is the most common margin in football. Line shopping that ignores ' +
      'key numbers captures a fraction of the available edge.'
  };
}
