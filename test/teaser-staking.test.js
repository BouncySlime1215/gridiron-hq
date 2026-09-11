/**
 * Staking for the Wong teaser.
 *
 * The load-bearing tests here are the two that could falsify the derivation
 * rather than confirm it:
 *
 *   - the three-outcome solver must collapse to (b·p - q)/b when nothing can
 *     push, for every price and every leg rate. If the concavity argument or
 *     the bisection bounds were wrong this is where it would show.
 *   - the enumerated weekend law at one ticket with zero correlation must equal
 *     the closed-form single-ticket law EXACTLY, not approximately. The
 *     enumerator is the only part of the module without an independent
 *     analytic check, and this gives it one.
 *
 * The cross-check against `teaser-leg-rates.js` exists because this module
 * re-derives the ticket outcome model rather than importing it — that module
 * opens a 9.8 GB database at import time and a staking calculator should not
 * need one. Re-derivation is a fork waiting to happen, so the fork is tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';

// Set before anything imports the database: the cross-check test pulls in
// teaser-leg-rates.js, which opens whatever GRIDIRON_DB_PATH points at.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-teaser-staking-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'staking.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const {
  MEASURED, TEASER_STAKING_VERSION, DEFAULT_KELLY_FRACTION,
  ticketOutcomes, growthRate, kellyForOutcomes, closedFormKelly, textbookKelly,
  betaPosterior, betaCdf, betaQuantile, legsAtRate, ticketEvAtRate, breakEvenLegRate,
  probabilityNegativeEv, pointEstimateKelly, predictiveKelly, robustKelly,
  weekendPayoffDistribution, portfolioKelly, recommendStake, seasonDrawdown
} = await import('../server/betting/nfl/strategy/teaser-staking.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const POSTERIOR = betaPosterior({ mean: MEASURED.decidedLegRate, sd: MEASURED.forwardRateSd });
const PUSHLESS = [0, 0];
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

/** Real American prices only: nothing strictly between -100 and +100 exists. */
const americanPrice = () => fc.oneof(
  fc.integer({ min: 100, max: 400 }),
  fc.integer({ min: -400, max: -100 }));

/* ------------------------------------------------- the exact derivation */

test('with no push the three-outcome solver IS the textbook formula, at every price and rate', () => {
  fc.assert(fc.property(americanPrice(), fc.integer({ min: 550, max: 950 }), (price, thousandths) => {
    const rate = thousandths / 1000;
    const ticket = ticketOutcomes({ legs: legsAtRate(rate, PUSHLESS), americanPrice: price });
    const solved = kellyForOutcomes(ticket.outcomes, { fraction: 1 });
    const textbook = textbookKelly({ winProbability: rate * rate, americanPrice: price });

    if (textbook <= 0) return solved.full_kelly === 0 && solved.blocked === true;
    return close(solved.full_kelly, textbook, 1e-9);
  }), { numRuns: 400 });
});

test('the numeric solve and the closed form agree for all three push gradings', () => {
  fc.assert(fc.property(americanPrice(), fc.integer({ min: 600, max: 900 }),
    fc.constantFrom('stake_back', 'same_price', 'graded_loss'), (price, thousandths, grading) => {
      const ticket = ticketOutcomes({
        legs: legsAtRate(thousandths / 1000, [0.02, 0.007]),
        americanPrice: price, reducedPayout: grading
      });
      const solved = kellyForOutcomes(ticket.outcomes, { fraction: 1 });
      if (solved.blocked) return true;
      assert.equal(solved.closed_form_agrees, true);
      return close(solved.closed_form, solved.full_kelly, 1e-10);
    }), { numRuns: 300 });
});

test('a reduced branch that pays neither 0, b nor -1 has no closed form and is solved anyway', () => {
  // The book re-prices the surviving single at -110 while the teaser was +100.
  // Four distinct payoffs, g'(f) = 0 is a genuine quadratic, and the closed
  // form must decline to answer rather than answer wrongly.
  const legs = legsAtRate(0.74, [0.02, 0.02]);
  const base = ticketOutcomes({ legs, americanPrice: 100, reducedPayout: 'stake_back' });
  const outcomes = base.outcomes.map(o => o.name === 'reduced' ? { ...o, profit: 100 / 110 } : o);

  assert.equal(closedFormKelly(outcomes), null);
  const solved = kellyForOutcomes(outcomes, { fraction: 1 });
  assert.equal(solved.closed_form, null);
  assert.ok(solved.full_kelly > 0);

  // Verify it really is the maximum: nudging either way must lower the growth.
  const best = growthRate(solved.full_kelly, outcomes);
  assert.ok(growthRate(solved.full_kelly * 0.99, outcomes) < best);
  assert.ok(growthRate(solved.full_kelly * 1.01, outcomes) < best);
});

test('hand-computed growth: even money at 60/40 gives f = 0.2 and g = 0.0201355', () => {
  const outcomes = [
    { name: 'win', profit: 1, probability: 0.6 },
    { name: 'loss', profit: -1, probability: 0.4 }
  ];
  const solved = kellyForOutcomes(outcomes, { fraction: 1 });
  assert.ok(close(solved.full_kelly, 0.2, 1e-12));

  // g(0.2) = 0.6·ln(1.2) + 0.4·ln(0.8)
  const byHand = 0.6 * Math.log(1.2) + 0.4 * Math.log(0.8);
  assert.ok(close(byHand, 0.0201355, 1e-7));
  assert.ok(close(solved.growth_rate_full, byHand, 1e-12));
});

test('a stake-back push scales the growth rate and leaves the fraction alone', () => {
  // The headline of the derivation. Same conditional odds as the 60/40 bet
  // above (p = 2/3 of decided) but 10% of the time the ticket voids.
  const outcomes = [
    { name: 'win', profit: 1, probability: 0.6 },
    { name: 'void', profit: 0, probability: 0.1 },
    { name: 'loss', profit: -1, probability: 0.3 }
  ];
  const solved = kellyForOutcomes(outcomes, { fraction: 1 });
  assert.ok(close(solved.full_kelly, 1 / 3, 1e-12));
  assert.ok(close(solved.full_kelly, textbookKelly({ winProbability: 2 / 3, americanPrice: 100 }), 1e-12));

  // g = 0.6·ln(4/3) + 0.3·ln(2/3) = 0.0509698, which is 0.9x the growth of the
  // same bet with the void mass removed.
  const byHand = 0.6 * Math.log(4 / 3) + 0.3 * Math.log(2 / 3);
  assert.ok(close(byHand, 0.0509698, 1e-7));
  assert.ok(close(solved.growth_rate_full, byHand, 1e-12));

  const decided = kellyForOutcomes([
    { name: 'win', profit: 1, probability: 2 / 3 },
    { name: 'loss', profit: -1, probability: 1 / 3 }
  ], { fraction: 1 });
  assert.ok(close(solved.growth_rate_full, 0.9 * decided.growth_rate_full, 1e-12));
});

/* --------------------------------------------------- parameter uncertainty */

test('uncertainty-aware Kelly is strictly smaller than point-estimate Kelly, for any posterior', () => {
  fc.assert(fc.property(
    fc.integer({ min: 700, max: 800 }),        // posterior mean, in thousandths
    fc.integer({ min: 5, max: 60 }),           // posterior sd, in ten-thousandths
    fc.integer({ min: 5, max: 45 }),           // confidence quantile, in hundredths
    americanPrice(),
    (meanThousandths, sdTenThousandths, quantileHundredths, price) => {
      const posterior = betaPosterior({ mean: meanThousandths / 1000, sd: sdTenThousandths / 10000 });
      const shared = { posterior, americanPrice: price, fraction: 1 };
      const point = pointEstimateKelly({ ...shared });
      const robust = robustKelly({ ...shared, confidence: quantileHundredths / 100 });
      if (!(point.full_kelly > 0)) return robust.full_kelly === 0;
      return robust.full_kelly < point.full_kelly;
    }), { numRuns: 400 });
});

test('and it converges to point-estimate Kelly as the posterior tightens', () => {
  const shared = { americanPrice: 100, fraction: 1 };
  const previous = [];
  for (const sd of [0.023, 0.01, 0.003, 0.001, 0.0003]) {
    const posterior = betaPosterior({ mean: MEASURED.decidedLegRate, sd });
    const ratio = robustKelly({ ...shared, posterior }).full_kelly
      / pointEstimateKelly({ ...shared, posterior }).full_kelly;
    previous.push(ratio);
  }
  for (let i = 1; i < previous.length; i++) assert.ok(previous[i] > previous[i - 1]);
  assert.ok(previous.at(-1) > 0.99);
  assert.ok(previous[0] < 0.7);        // at the real posterior it is about half
});

test('integrating expected log wealth over the posterior makes Kelly LARGER, not smaller', () => {
  // The finding the module exists to report, pinned so that nobody "corrects"
  // it. E[rho²] > E[rho]² makes the predictive ticket-win probability higher
  // than the win probability at the mean, so the E[log] criterion cannot be
  // the thing that shrinks the stake. Only the quantile criterion does that.
  fc.assert(fc.property(fc.integer({ min: 700, max: 800 }), fc.integer({ min: 5, max: 60 }),
    (meanThousandths, sdTenThousandths) => {
      const posterior = betaPosterior({ mean: meanThousandths / 1000, sd: sdTenThousandths / 10000 });
      const shared = { posterior, americanPrice: 100, fraction: 1 };
      const point = pointEstimateKelly({ ...shared });
      const predictive = predictiveKelly({ ...shared });
      if (!(point.full_kelly > 0)) return true;
      return predictive.full_kelly > point.full_kelly;
    }), { numRuns: 250 });

  const gap = predictiveKelly({ posterior: POSTERIOR, americanPrice: 100, fraction: 1 }).full_kelly
    / pointEstimateKelly({ posterior: POSTERIOR, americanPrice: 100, fraction: 1 }).full_kelly;
  assert.ok(gap > 1 && gap < 1.02, `predictive gap should be a hair above 1, got ${gap}`);
});

/* ------------------------------------------------------------- the price */

test('the stake falls to zero as the price approaches break-even and is refused below it', () => {
  const previous = { units: Infinity };
  for (const price of [100, -105, -110, -115, -119, -120]) {
    const stake = recommendStake({
      posterior: POSTERIOR, americanPrice: price,
      maxNegativeEvProbability: 1, confidence: 0.5   // disable the other two gates
    });
    const units = stake.blocked ? 0 : stake.caps.uncapped_units;
    assert.ok(units <= previous.units + 1e-12, `stake rose from ${previous.units} to ${units} at ${price}`);
    previous.units = units;
  }
  assert.ok(previous.units < 0.02, 'at -120 the stake should be a rounding error');

  const below = recommendStake({ posterior: POSTERIOR, americanPrice: -140, maxNegativeEvProbability: 1 });
  assert.equal(below.blocked, true);
  assert.equal(below.units, 0);

  const breakEven = breakEvenLegRate({ americanPrice: 100 });
  assert.ok(close(ticketEvAtRate({ rate: breakEven, americanPrice: 100 }), 0, 1e-9));
  assert.ok(breakEven > 0.708 && breakEven < 0.710, `break-even leg rate was ${breakEven}`);
});

test('the negative-EV gate refuses prices the break-even gate would pass', () => {
  const measured = price => probabilityNegativeEv({ posterior: POSTERIOR, americanPrice: price }).probability;
  assert.ok(measured(100) > 0.08 && measured(100) < 0.09);
  assert.ok(measured(-110) > 0.25 && measured(-110) < 0.26);
  assert.ok(measured(-115) > 0.36 && measured(-115) < 0.37);
  assert.ok(measured(-120) > 0.48 && measured(-120) < 0.50);

  // -115 is inside the scanner's break-even gate of -120.2 and outside this one.
  const allowed = recommendStake({ posterior: POSTERIOR, americanPrice: 100 });
  assert.equal(allowed.blocked, false);
  const refused = recommendStake({ posterior: POSTERIOR, americanPrice: -115 });
  assert.equal(refused.blocked, true);
  assert.equal(refused.blocked_by, 'negative_ev_probability');
  assert.ok(refused.probability_negative_ev > 0.2);
  assert.ok(refused.break_even_american < -120 && refused.break_even_american > -121);
});

/* ------------------------------------------------------------- the caps */

test('the per-ticket cap and the weekly exposure cap both bind', () => {
  const generous = { posterior: POSTERIOR, americanPrice: 100, bankrollUnits: 1000 };

  const uncapped = recommendStake({ ...generous, maxUnitsPerTicket: 1e9, maxWeeklyUnits: 1e9 });
  assert.ok(uncapped.units > 7, `expected a large raw stake on a 1000u bankroll, got ${uncapped.units}`);
  assert.equal(uncapped.caps.binding, null);

  const perTicket = recommendStake({ ...generous, maxUnitsPerTicket: 2, maxWeeklyUnits: 1e9 });
  assert.equal(perTicket.units, 2);
  assert.equal(perTicket.caps.binding, 'per_ticket_cap');
  assert.ok(perTicket.caps.uncapped_units > 2);

  const weekly = recommendStake({ ...generous, simultaneousTickets: 4, maxUnitsPerTicket: 2, maxWeeklyUnits: 5 });
  assert.equal(weekly.caps.binding, 'weekly_exposure_cap');
  assert.ok(close(weekly.weekly_units, 5, 1e-12));
  assert.ok(close(weekly.units, 1.25, 1e-12));

  // At the real 100-unit bankroll neither cap binds, which is the point of
  // choosing them: they bound a mistake, they do not shape the normal answer.
  const normal = recommendStake({ posterior: POSTERIOR, americanPrice: 100 });
  assert.equal(normal.caps.binding, null);
});

/* -------------------------------------------------- simultaneous tickets */

test('the enumerated weekend law reproduces the closed-form ticket exactly at one ticket', () => {
  fc.assert(fc.property(fc.integer({ min: 650, max: 850 }), americanPrice(), (thousandths, price) => {
    const rate = thousandths / 1000;
    const shares = [0.02, 0.007];
    const closed = ticketOutcomes({ legs: legsAtRate(rate, shares), americanPrice: price });
    const enumerated = weekendPayoffDistribution({
      rate, pushShares: shares, americanPrice: price, tickets: 1, legCorrelation: 0
    });
    // Atoms are keyed by ticket counts, so a voided ticket and a reduced one
    // are separate atoms that happen to pay the same. Sum them.
    const found = profit => enumerated.atoms
      .filter(a => close(a.profit, profit, 1e-12))
      .reduce((sum, a) => sum + a.probability, 0);

    return close(found(closed.profit_multiple), closed.probabilities.win, 1e-12)
      && close(found(-1), closed.probabilities.loss, 1e-12)
      && close(found(0), closed.probabilities.reduced + closed.probabilities.both_push, 1e-12);
  }), { numRuns: 200 });
});

test('every enumerated weekend law is a probability distribution', () => {
  for (const tickets of [1, 2, 3, 4]) {
    const law = weekendPayoffDistribution({
      rate: MEASURED.decidedLegRate, americanPrice: 100, tickets
    });
    const mass = law.atoms.reduce((sum, a) => sum + a.probability, 0);
    assert.ok(close(mass, 1, 1e-12), `mass was ${mass} at ${tickets} tickets`);
    for (const atom of law.atoms) assert.ok(atom.probability > 0);
    assert.ok(law.atoms.every(a => a.profit >= -tickets));
    // The within-ticket correlation is always the measured one; only the
    // cross-ticket term is allowed to shrink, and only upward toward zero.
    assert.equal(law.within_ticket_correlation, MEASURED.legCorrelation);
    assert.ok(law.cross_ticket_correlation >= MEASURED.legCorrelation);
    assert.ok(law.cross_ticket_correlation <= 0);
  }
});

test('the portfolio fraction is not the single-bet fraction, and not n times it either', () => {
  const shared = { posterior: POSTERIOR, americanPrice: 100, fraction: 1 };
  const single = portfolioKelly({ ...shared, tickets: 1 }).per_ticket_full_kelly;

  for (const tickets of [2, 3, 4]) {
    const portfolio = portfolioKelly({ ...shared, tickets });

    // Per ticket it differs from the single-bet answer by a material margin.
    assert.notEqual(portfolio.per_ticket_full_kelly, single);
    assert.ok(Math.abs(portfolio.per_ticket_vs_single - 1) > 0.01,
      `${tickets} tickets moved the per-ticket fraction by only ` +
      `${((portfolio.per_ticket_vs_single - 1) * 100).toFixed(2)}%`);

    // Total exposure is therefore not n x the single-bet fraction.
    assert.ok(Math.abs(portfolio.total_exposure_full_kelly - tickets * single) > 1e-3);

    // Negative correlation helps: simultaneous tickets hedge, so per ticket
    // this is larger than the single-bet fraction.
    assert.ok(portfolio.per_ticket_full_kelly > single);

    // Strip the correlation out and the only remaining effect is simultaneity,
    // which competes for one bankroll and must lower the per-ticket fraction.
    const independent = portfolioKelly({ ...shared, tickets, legCorrelation: 0 });
    const independentSingle = portfolioKelly({ ...shared, tickets: 1, legCorrelation: 0 });
    assert.ok(independent.per_ticket_full_kelly < independentSingle.per_ticket_full_kelly);
  }
});

test('the correlation inside a ticket costs more than the whole portfolio effect', () => {
  const portfolio = portfolioKelly({ posterior: POSTERIOR, americanPrice: 100, tickets: 4, fraction: 1 });
  // Within-ticket rho = -0.044 removes about a third of the fraction.
  assert.ok(portfolio.within_ticket_correlation_cost < 0.7);
  assert.ok(portfolio.within_ticket_correlation_cost > 0.5);
  // The four-ticket portfolio adjustment is worth a few percent.
  assert.ok(Math.abs(portfolio.per_ticket_vs_single - 1) < 0.15);
});

/* ------------------------------------------------------------ drawdown */

test('the drawdown view is survivable, and a bigger fraction makes it less so', () => {
  const shared = { posterior: POSTERIOR, americanPrice: 100, seasons: 1500 };
  const small = seasonDrawdown({ ...shared, perTicketFraction: 0.005 });
  const large = seasonDrawdown({ ...shared, perTicketFraction: 0.04 });

  assert.equal(small.tickets_per_season, 28);
  assert.ok(small.max_drawdown.p50 < large.max_drawdown.p50);
  assert.ok(small.max_drawdown.p99 < large.max_drawdown.p99);
  assert.ok(large.max_drawdown.p50 > 0);
  assert.ok(small.probability_ruin === 0 && large.probability_ruin === 0);

  // A real edge still loses in a large minority of seasons. If this ever drops
  // below a quarter, something has started flattering the strategy.
  assert.ok(small.probability_season_red > 0.25 && small.probability_season_red < 0.55);
});

test('holding the rate fixed within a season produces fatter tails than resampling it', () => {
  // This is why the rate is drawn once per season. Resampling per week averages
  // the bad worlds away and reports a drawdown nobody will ever experience.
  const shared = {
    posterior: POSTERIOR, americanPrice: 100, perTicketFraction: 0.012, seasons: 4000
  };
  const fixed = seasonDrawdown({ ...shared, rateFixedPerSeason: true });
  const resampled = seasonDrawdown({ ...shared, rateFixedPerSeason: false });
  assert.ok(fixed.max_drawdown.p95 > resampled.max_drawdown.p95);
  assert.ok(fixed.terminal_bankroll.p05 < resampled.terminal_bankroll.p05);
});

/* ----------------------------------------- cross-check against the source */

test('the re-derived ticket model has not forked from teaser-leg-rates.js', async () => {
  const source = await import('../server/betting/nfl/strategy/teaser-leg-rates.js');
  const legs = legsAtRate(MEASURED.decidedLegRate, [0.02, 4 / 169]);

  const theirs = source.ticketProbabilities(legs);
  const ours = ticketOutcomes({ legs, americanPrice: 100 }).probabilities;
  for (const key of ['win', 'reduced', 'both_push', 'loss']) {
    assert.ok(close(ours[key], theirs[key], 1e-15), `${key}: ${ours[key]} vs ${theirs[key]}`);
  }

  // The reduced-payout table is private over there, so it is checked through
  // the break-even prices it produces — which is the number that would actually
  // hurt if the two tables ever disagreed.
  for (const grading of ['stake_back', 'same_price', 'graded_loss']) {
    const theirBreakEven = source.breakEvenAmericanPrice({ legs, reducedPayout: grading });
    const ourEv = ticketOutcomes({ legs, americanPrice: theirBreakEven.american, reducedPayout: grading }).ev;
    assert.ok(close(ourEv, 0, 1e-12), `${grading} break-even gave EV ${ourEv}`);

    const solved = kellyForOutcomes(
      ticketOutcomes({ legs, americanPrice: theirBreakEven.american, reducedPayout: grading }).outcomes,
      { fraction: 1 });
    assert.equal(solved.full_kelly, 0);
    assert.equal(solved.blocked, true);
  }

  assert.equal(source.profitMultiple(-110), ticketOutcomes({ legs, americanPrice: -110 }).profit_multiple);
});

test('the posterior helpers round-trip and the version is pinned', () => {
  assert.equal(TEASER_STAKING_VERSION, 'nfl-teaser-staking-v1');
  assert.equal(DEFAULT_KELLY_FRACTION, 0.25);

  const rebuilt = betaPosterior({ alpha: POSTERIOR.alpha, beta: POSTERIOR.beta });
  assert.ok(close(rebuilt.mean, POSTERIOR.mean, 1e-12));
  assert.ok(close(rebuilt.sd, POSTERIOR.sd, 1e-9));

  for (const q of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const x = betaQuantile(q, POSTERIOR.alpha, POSTERIOR.beta);
    assert.ok(close(betaCdf(x, POSTERIOR.alpha, POSTERIOR.beta), q, 1e-9));
  }
  assert.ok(close(betaQuantile(0.5, POSTERIOR.alpha, POSTERIOR.beta), POSTERIOR.mean, 0.001));
});
