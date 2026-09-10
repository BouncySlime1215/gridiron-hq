/**
 * The cross-both teaser family, and the three ways it could quietly go wrong.
 *
 * These checks guard, in order: that the candidate leg set is the SOLUTION of
 * the crossing condition rather than a list somebody typed; that the measured
 * rates are the real ones and are measured on the seasons whose data can bear
 * it; and that the ticket arithmetic under DraftKings' push rule is right,
 * including the price at which the whole strategy stops being worth doing.
 *
 * WHY THIS RUNS AGAINST THE REAL DATABASE. The rate assertions below are
 * economic claims about football — 2,894 legs at 74.06% — and a synthetic
 * fixture could be generated to produce any rate at all, which would prove
 * only that the generator was tuned. So these follow the convention in
 * test/helpers/requires-real-history.js: they stay in the suite, they stay
 * meaningful, and on a clean checkout they report an explicit disposition
 * naming the history they need. The pure arithmetic (line derivation, ticket
 * probabilities, EV, break-even) needs no data and always runs.
 *
 * The integrity check is turned OFF before the database is opened. It is a
 * PRAGMA quick_check that last took 159 seconds on this 9.8 GB file, it writes
 * a row when it runs, and neither belongs in a read-only measurement test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { rows } = await import('../server/db/index.js');
const { realHistoryDisposition } = await import('./helpers/requires-real-history.js');
const {
  CROSS_BOTH_LINES, MEASUREMENT_SEASONS, EXCLUDED_SEASONS, TEASER_POINTS,
  teasedLegRate, familyRate, familyHomogeneity, familyPairCorrelation,
  ticketProbabilities, ticketEV, breakEvenAmericanPrice, familyTicketEV,
  profitMultiple, crossesBothKeyNumbers
} = await import('../server/betting/nfl/strategy/teaser-leg-rates.js');

const NEEDS_HISTORY = realHistoryDisposition(rows, ['game_lines'],
  'These checks assert the measured historical win rate of a real betting strategy across 26 NFL ' +
  'seasons of posted spreads and final scores. The whole point of the assertion is that the number ' +
  'came from the market and the scoreboard.', { min: 5000 });

/**
 * Tolerances, stated once.
 *
 * RATE_TOLERANCE is 0.0005 — five hundredths of a percentage point. The target
 * figures were quoted to 2dp, so anything tighter would be testing the
 * rounding of the brief rather than the measurement. Counts (`n`, `wins`,
 * `pushes`) are integers and are asserted EXACTLY: a count that drifts means
 * the population changed, and that must never pass quietly.
 */
const RATE_TOLERANCE = 0.0005;
/** Break-even is asserted to a hundredth of a cent on the dollar. */
const PRICE_TOLERANCE = 0.05;

const closeTo = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} +/- ${tolerance}, got ${actual} (off by ${Math.abs(actual - expected)})`);

/* ================================================== 1. the candidate set */

/**
 * Derived here from scratch, by simulating outcomes rather than by reusing the
 * module's interval arithmetic — otherwise this would only prove the module
 * agrees with itself.
 *
 * For a posted line L a leg wins when margin + L > 0 and pushes when it is 0.
 * Teasing adds six. A key number is CROSSED when teasing converts that exact
 * margin from a non-win into a win: crossing 7 as a -7 favourite means the
 * 7-point win that used to push now pays, and NOT crossing 3 as a -9 favourite
 * means the 3-point win that used to lose now merely pushes.
 */
function derivedCrossBothLines(points = 6) {
  const qualifies = [];
  for (let halves = -60; halves <= 60; halves++) {
    const line = halves / 2;
    if (line === 0) continue;                 // a pick'em is not a posted side
    const gained = new Set();
    for (let margin = -70; margin <= 70; margin++) {
      const before = margin + line;
      const after = margin + line + points;
      if (after > 0 && before <= 0) gained.add(margin);   // non-win -> win
    }
    const buys = k => [...gained].some(m => Math.abs(m) === k);
    if (buys(3) && buys(7)) qualifies.push(line);
  }
  return qualifies;
}

test('the candidate set is exactly the lines whose six points cross both 3 and 7', () => {
  const derived = derivedCrossBothLines(TEASER_POINTS).sort((a, b) => a - b);
  assert.deepEqual(derived, [...CROSS_BOTH_LINES].sort((a, b) => a - b));
  assert.equal(derived.length, 8);
  assert.deepEqual(derived, [-8.5, -8, -7.5, -7, 1.5, 2, 2.5, 3]);
});

test('the neighbours that look qualifying are excluded for the right reason', () => {
  // -9 teased to -3: the 7 is bought, but a 3-point win only becomes a PUSH,
  // so 3 is moved rather than crossed.
  assert.equal(crossesBothKeyNumbers(-9), false);
  // -6.5 teased to -0.5 buys 3 and never reaches 7.
  assert.equal(crossesBothKeyNumbers(-6.5), false);
  // +1 teased to +7: a 7-point loss pushes, so 7 is not bought.
  assert.equal(crossesBothKeyNumbers(1), false);
  // +3.5 teased to +9.5 buys 7 but starts already past 3.
  assert.equal(crossesBothKeyNumbers(3.5), false);
  for (const line of CROSS_BOTH_LINES) assert.equal(crossesBothKeyNumbers(line), true, `${line} must qualify`);
});

test('the frozen constant cannot be edited by a caller', () => {
  assert.ok(Object.isFrozen(CROSS_BOTH_LINES));
  assert.throws(() => { CROSS_BOTH_LINES.push(-9); });
});

/* ============================================ 2. the per-line measurement */

/** line -> [n including pushes, rate of decided legs]. From the 1999-2024 window. */
const EXPECTED_PER_LINE = [
  [1.5, 169, 0.7870],
  [2, 169, 0.7091],
  [2.5, 492, 0.7602],
  [3, 1124, 0.7267],
  [-7, 472, 0.7522],
  [-7.5, 275, 0.7491],
  [-8, 100, 0.7041],
  [-8.5, 93, 0.7312]
];

test('teasedLegRate reproduces the measured per-line record', { skip: NEEDS_HISTORY }, () => {
  for (const [line, n, rate] of EXPECTED_PER_LINE) {
    const measured = teasedLegRate(line);
    assert.equal(measured.n, n, `${line}: leg count (pushes included) must be exact`);
    closeTo(measured.rate_of_decided, rate, RATE_TOLERANCE, `${line} rate of decided legs`);
    assert.equal(measured.teased_to, line + 6);
    assert.ok(measured.wins + measured.pushes <= measured.n,
      `${line}: wins and pushes cannot exceed the legs available`);
    assert.equal(measured.decided, measured.n - measured.pushes,
      `${line}: pushes must be out of the denominator, not counted as half a win`);
    assert.equal(measured.crosses_both, true);
  }
});

test('only the integer lines can push after teasing, and they are the only ones that do',
  { skip: NEEDS_HISTORY }, () => {
    // -7 -> -1, -8 -> -2, +2 -> +8, +3 -> +9 all land on integers, so a margin
    // can land exactly on the teased number. The half-point legs cannot push,
    // and a non-zero push count on one of them would mean a corrupted spread.
    for (const line of [-7.5, -8.5, 1.5, 2.5]) {
      assert.equal(teasedLegRate(line).pushes, 0, `${line} teases to a half-point and cannot push`);
    }
    for (const line of [-7, -8, 2, 3]) {
      assert.ok(teasedLegRate(line).pushes > 0, `${line} teases to an integer and must show pushes`);
    }
  });

test('per-line rates are flagged unusable for EV at the call site', { skip: NEEDS_HISTORY }, () => {
  const best = teasedLegRate(1.5);
  const worst = teasedLegRate(-8);
  assert.equal(best.use_for_ev, false);
  assert.equal(worst.use_for_ev, false);
  assert.match(best.caution, /noise/);
  assert.equal(familyRate({ side: 'all' }).use_for_ev, true);
});

test('the per-line spread is statistically indistinguishable from one common rate',
  { skip: NEEDS_HISTORY }, () => {
    // This is the load-bearing fact behind pooling. If it ever fails, the
    // module's central argument is wrong and the scanner needs rethinking —
    // so it is asserted rather than left in a comment.
    const homogeneity = familyHomogeneity();
    assert.equal(homogeneity.degrees_of_freedom, 7, 'eight lines, one pooled rate estimated');
    closeTo(homogeneity.chi_square, 5.994, 0.02, 'chi-square across the eight lines');
    assert.ok(homogeneity.p_value > 0.5,
      `expected a large p-value (no evidence of per-line differences), got ${homogeneity.p_value}`);
    // The 8pp gap between two adjacent half-points at identical n is the
    // clearest single illustration and is worth pinning down.
    const up = teasedLegRate(1.5), down = teasedLegRate(2);
    assert.equal(up.n, down.n, 'the +1.5 / +2.0 comparison is only striking because n is identical');
    assert.ok(up.rate_of_decided - down.rate_of_decided > 0.07,
      'the two adjacent half-points really do differ by more than 7pp');
    assert.deepEqual(up.gained_margins, down.gained_margins,
      'and they buy exactly the same margins, so there is no football difference to explain');
  });

/* ================================================ 3. the pooled family rate */

test('familyRate pools the whole family and reproduces 74.06% on 2,894 legs',
  { skip: NEEDS_HISTORY }, () => {
    const all = familyRate({ side: 'all' });
    assert.equal(all.n, 2894, 'every candidate leg, pushes included');
    assert.equal(all.wins, 2124);
    assert.equal(all.pushes, 26);
    assert.equal(all.decided, 2868);
    closeTo(all.rate_of_decided, 0.7406, RATE_TOLERANCE, 'pooled family rate');
    assert.deepEqual([...all.lines].sort((a, b) => a - b), [...CROSS_BOTH_LINES].sort((a, b) => a - b));

    // The family n is exactly the eight per-line n's, so nothing is being
    // double counted and nothing silently dropped.
    assert.equal(EXPECTED_PER_LINE.reduce((sum, [, n]) => sum + n, 0), all.n);
  });

test('the two halves of the family agree with each other', { skip: NEEDS_HISTORY }, () => {
  const favourites = familyRate({ side: 'favourite' });
  const underdogs = familyRate({ side: 'underdog' });
  closeTo(favourites.rate_of_decided, 0.7441, RATE_TOLERANCE, 'favourite legs');
  closeTo(underdogs.rate_of_decided, 0.7389, RATE_TOLERANCE, 'underdog legs');
  assert.equal(favourites.n + underdogs.n, familyRate({ side: 'all' }).n);
  assert.ok(favourites.lines.every(line => line < 0));
  assert.ok(underdogs.lines.every(line => line > 0));
  assert.throws(() => familyRate({ side: 'dogs' }), /favourite/);
});

test('win_share and push_share are unconditional and feed the ticket maths',
  { skip: NEEDS_HISTORY }, () => {
    const all = familyRate({ side: 'all' });
    // rate_of_decided drops pushes from the denominator; win_share does not.
    // Confusing the two is how a ticket ends up priced with no push bucket.
    closeTo(all.win_share, 2124 / 2894, 1e-12, 'win share');
    closeTo(all.push_share, 26 / 2894, 1e-12, 'push share');
    closeTo(all.win_share + all.push_share + all.loss_share, 1, 1e-12, 'the three shares');
    assert.ok(all.win_share < all.rate_of_decided, 'pushes must make win_share the smaller number');
  });

/* ============================================= 4. the 2025/2026 exclusion */

test('the measurement window stops at 2024 and says why', { skip: NEEDS_HISTORY }, () => {
  const all = familyRate({ side: 'all' });
  assert.equal(all.seasons.from, 1999);
  assert.equal(all.seasons.to, 2024);
  assert.deepEqual(all.seasons.excluded, [2025, 2026]);
  assert.match(all.seasons.exclusion_reason, /2025|2026/);
  assert.equal(MEASUREMENT_SEASONS.to, 2024);
  assert.deepEqual([...EXCLUDED_SEASONS], [2025, 2026]);

  // Not just configured — no leg from an excluded season made it into the tally.
  assert.ok(all.seasons.observed_last <= 2024,
    `a leg from ${all.seasons.observed_last} is inside a window that stops at 2024`);
  assert.equal(all.seasons.observed_first, 1999);
  for (const [line] of EXPECTED_PER_LINE) {
    assert.ok(teasedLegRate(line).seasons.observed_last <= 2024, `${line} reaches past 2024`);
  }
});

test('the 2025/2026 spread defect is real and is what the exclusion is for',
  { skip: NEEDS_HISTORY }, () => {
    const integerShare = season => {
      const r = rows(`SELECT COUNT(*) n, SUM(CASE WHEN spread = CAST(spread AS INTEGER) THEN 1 ELSE 0 END) ints
        FROM game_lines WHERE season=? AND spread IS NOT NULL`, season)[0];
      return r.ints / r.n;
    };
    for (const season of [2021, 2022, 2023, 2024]) {
      assert.ok(integerShare(season) > 0.45,
        `${season} integer share ${integerShare(season)} — the healthy seasons sit near half`);
    }
    for (const season of EXCLUDED_SEASONS) {
      assert.ok(integerShare(season) < 0.30,
        `${season} integer share ${integerShare(season)} — expected the collapse that motivates the exclusion`);
    }
    // The damage is specific: two of the eight candidate lines vanish outright.
    for (const season of EXCLUDED_SEASONS) {
      for (const line of [-8, 2]) {
        const n = rows('SELECT COUNT(*) n FROM game_lines WHERE season=? AND spread=?', season, line)[0].n;
        assert.equal(n, 0, `${season} unexpectedly has ${n} rows at ${line} — recheck the defect before widening the window`);
      }
      const survives = rows('SELECT COUNT(*) n FROM game_lines WHERE season=? AND spread=?', season, -7.5)[0].n;
      assert.ok(survives > 0, `${season} has half-point lines but not integer ones — that is the defect`);
    }
  });

test('excluding 2025 and 2026 is load-bearing: including them changes the answer',
  { skip: NEEDS_HISTORY }, () => {
    // Computed here, independently of the module, so this measures the effect
    // of the window rather than the module's opinion of it.
    const measure = (from, to) => {
      const legs = rows(`SELECT spread, team_score, opp_score FROM game_lines
        WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
          AND season BETWEEN ? AND ?`, from, to);
      let n = 0, wins = 0, pushes = 0;
      for (const leg of legs) {
        if (!CROSS_BOTH_LINES.includes(leg.spread)) continue;
        const result = leg.team_score - leg.opp_score + leg.spread + 6;
        n++;
        if (result === 0) pushes++; else if (result > 0) wins++;
      }
      return { n, rate: wins / (n - pushes) };
    };

    const excluded = measure(1999, 2024);
    const included = measure(1999, 2026);
    const moduleRate = familyRate({ side: 'all' });

    assert.equal(excluded.n, moduleRate.n, 'the module must be measuring the 1999-2024 window');
    closeTo(excluded.rate, moduleRate.rate_of_decided, 1e-12, 'module vs independent recomputation');

    assert.ok(included.n > excluded.n, 'the excluded seasons do contain candidate legs');
    assert.notEqual(included.rate, excluded.rate);
    assert.ok(Math.abs(included.rate - excluded.rate) > 0.0001,
      `including 2025-2026 moves the rate from ${excluded.rate} to ${included.rate}; if these ever ` +
      'coincide the exclusion has stopped being observable and this test has stopped meaning anything');

    // And the direction matters: the contaminated seasons drag the rate DOWN,
    // so the exclusion is not a convenient way of flattering the strategy.
    assert.ok(included.rate < excluded.rate);
  });

/* ================================================= 5. ticket probabilities */

test('ticketProbabilities: the hand-checked two-leg example', () => {
  // Leg A wins 75%, pushes 5%, loses 20%. Leg B wins 60%, pushes 10%, loses 30%.
  //
  //   win        0.75 * 0.60                       = 0.450
  //   both_push  0.05 * 0.10                       = 0.005
  //   reduced    A pushes & B wins  0.05 * 0.60    = 0.030
  //            + A wins & B pushes 0.75 * 0.10     = 0.075  -> 0.105
  //   loss       1 - (0.80 * 0.70)                 = 0.440
  //                                                 -------
  //                                                  1.000
  const p = ticketProbabilities([{ w: 0.75, t: 0.05 }, { w: 0.60, t: 0.10 }]);
  closeTo(p.win, 0.450, 1e-12, 'both legs win');
  closeTo(p.both_push, 0.005, 1e-12, 'both legs push');
  closeTo(p.reduced, 0.105, 1e-12, 'exactly one leg pushed, the other won');
  closeTo(p.loss, 0.440, 1e-12, 'at least one leg lost');
  closeTo(p.win + p.reduced + p.both_push + p.loss, 1, 1e-12, 'the four outcomes');
});

test('ticketProbabilities: a push removes its leg rather than sinking the ticket', () => {
  // A certain winner paired with a leg that pushes 20% of the time: the ticket
  // can never lose because of the push, it just reduces.
  const p = ticketProbabilities([{ w: 1, t: 0 }, { w: 0.5, t: 0.2 }]);
  closeTo(p.win, 0.5, 1e-12, 'survivor won outright');
  closeTo(p.reduced, 0.2, 1e-12, 'the pushed leg is removed, not graded as a loss');
  closeTo(p.both_push, 0, 1e-12, 'one leg cannot push');
  closeTo(p.loss, 0.3, 1e-12, 'only a real loss loses the ticket');
});

test('ticketProbabilities: a lost leg beats a pushed one', () => {
  // The rule that separates DraftKings from a parlay-style "void the ticket":
  // one push and one loss is a LOSS, not a refund.
  const p = ticketProbabilities([{ w: 0, t: 1 }, { w: 0, t: 0 }]);
  closeTo(p.loss, 1, 1e-12, 'the losing leg decides it');
  closeTo(p.both_push, 0, 1e-12);
});

test('ticketProbabilities: every leg pushing voids the ticket', () => {
  const p = ticketProbabilities([{ w: 0, t: 1 }, { w: 0, t: 1 }]);
  closeTo(p.both_push, 1, 1e-12);
  closeTo(p.win + p.reduced + p.loss, 0, 1e-12);
});

test('ticketProbabilities sums to 1 across a spread of inputs, legs and push rates', () => {
  const cases = [
    [{ w: 0.734, t: 0.009 }, { w: 0.734, t: 0.009 }],
    [{ w: 0.5, t: 0 }, { w: 0.5, t: 0 }],
    [{ w: 0.9, t: 0.05 }, { w: 0.1, t: 0.4 }, { w: 0.6, t: 0.2 }],
    [{ w: 0.734, t: 0.009 }, { w: 0.734, t: 0.009 }, { w: 0.734, t: 0.009 }, { w: 0.734, t: 0.009 }]
  ];
  for (const legs of cases) {
    const p = ticketProbabilities(legs);
    closeTo(p.win + p.reduced + p.both_push + p.loss, 1, 1e-12, `${legs.length} legs`);
    for (const [name, value] of Object.entries(p)) {
      assert.ok(value >= 0 && value <= 1, `${name} out of range: ${value}`);
    }
  }
});

test('ticketProbabilities rejects nonsense rather than returning a number', () => {
  assert.throws(() => ticketProbabilities([{ w: 0.7, t: 0 }]), /at least two legs/);
  assert.throws(() => ticketProbabilities([{ w: 0.7, t: 0.5 }, { w: 0.7, t: 0 }]), /w \+ t/);
  assert.throws(() => ticketProbabilities([{ w: -0.1, t: 0 }, { w: 0.7, t: 0 }]), /w >= 0/);
  assert.throws(() => ticketProbabilities('two legs'), /at least two legs/);
});

/* ============================================================== 6. ticket EV */

const familyLegs = () => {
  const family = familyRate({ side: 'all' });
  return [{ w: family.win_share, t: family.push_share }, { w: family.win_share, t: family.push_share }];
};

test('two cross-both legs are +EV at +100 and -EV at -130', { skip: NEEDS_HISTORY }, () => {
  const legs = familyLegs();
  const even = ticketEV({ legs, americanPrice: 100 });
  const bad = ticketEV({ legs, americanPrice: -130 });
  assert.ok(even.ev > 0, `+100 should be positive, got ${even.ev}`);
  assert.ok(bad.ev < 0, `-130 should be negative, got ${bad.ev}`);
  // The measured size, not just the sign — a sign test would still pass if the
  // rate collapsed to 60%.
  closeTo(even.ev, 0.0906, 0.001, 'EV at +100');
  closeTo(bad.ev, -0.0337, 0.001, 'EV at -130');
  assert.equal(even.reduced_payout, 'stake_back', 'the conservative grading is the default');
  assert.equal(even.reduced_payout_verified, false, 'the DraftKings reduced price is not confirmed');
});

test('the break-even price sits between them and is where EV crosses zero',
  { skip: NEEDS_HISTORY }, () => {
    const legs = familyLegs();
    const ev = price => ticketEV({ legs, americanPrice: price }).ev;

    // Found by bisection using only ticketEV, so the break-even is located
    // independently of the module's closed-form solution.
    let low = -200, high = -100;                 // ev(-200) < 0 < ev(-100)
    assert.ok(ev(low) < 0 && ev(high) > 0, 'the bracket must actually straddle zero');
    for (let i = 0; i < 200; i++) {
      const mid = (low + high) / 2;
      if (ev(mid) < 0) low = mid; else high = mid;
    }
    const found = (low + high) / 2;

    closeTo(found, -120.22, PRICE_TOLERANCE, 'break-even American price');
    assert.ok(found > -130 && found < 100, 'break-even must lie between the tested prices');
    closeTo(ev(found), 0, 1e-6, 'EV at the break-even price');
    assert.ok(ev(found + 1) > 0, 'a point better than break-even is +EV');
    assert.ok(ev(found - 1) < 0, 'a point worse than break-even is -EV');

    // The module's solved answer must agree with the searched one.
    const solved = breakEvenAmericanPrice({ legs });
    closeTo(solved.american, found, 1e-6, 'solved vs bisected break-even');
    closeTo(solved.profit_multiple, profitMultiple(Math.round(solved.american * 1e6) / 1e6), 1e-6,
      'the profit multiple must be the same price expressed the other way');
    closeTo(ticketEV({ legs, americanPrice: -110 }).break_even_american, found, 1e-6,
      'ticketEV reports the same gate it is measured against');

    // -110 is comfortably inside the gate and -120 is right on the edge, which
    // is the operational headline: the book's price is the binding constraint.
    assert.ok(ev(-110) > 0, 'the classic -110 teaser price is still +EV');
    assert.ok(ev(-125) < 0, 'a -125 teaser is not');
  });

test('the reduced-payout models are ordered, and the default is the conservative one',
  { skip: NEEDS_HISTORY }, () => {
    const legs = familyLegs();
    const price = -115;
    const optimistic = ticketEV({ legs, americanPrice: price, reducedPayout: 'same_price' }).ev;
    const conservative = ticketEV({ legs, americanPrice: price, reducedPayout: 'stake_back' }).ev;
    const floorCase = ticketEV({ legs, americanPrice: price, reducedPayout: 'graded_loss' }).ev;
    const byDefault = ticketEV({ legs, americanPrice: price }).ev;

    assert.ok(optimistic > conservative, 'paying the reduced single at full odds can only help');
    assert.ok(conservative > floorCase, 'grading a push as a loss can only hurt');
    assert.equal(byDefault, conservative, 'an unverified payout must not be assumed in our favour');

    // Whichever model is used, the break-even moves in the same direction.
    const [optimisticGate, defaultGate, floorGate] = ['same_price', 'stake_back', 'graded_loss']
      .map(model => breakEvenAmericanPrice({ legs, reducedPayout: model }).american);
    assert.ok(optimisticGate < defaultGate && defaultGate < floorGate,
      `expected the optimistic model to tolerate the worst price, got ${[optimisticGate, defaultGate, floorGate]}`);

    // The measured size of the disagreement, pinned rather than waved at. The
    // reduced bucket is only 1.32% of tickets, but choosing between the two
    // CREDIBLE gradings still moves the gate by ~2.9 American points, which is
    // the difference between taking a -122 quote and refusing it. That is why
    // the grading is documented as unverified instead of quietly assumed.
    closeTo(optimisticGate, -123.16, PRICE_TOLERANCE, 'break-even if a reduced ticket pays full odds');
    closeTo(defaultGate, -120.22, PRICE_TOLERANCE, 'break-even if a reduced ticket is no action');
    closeTo(floorGate, -116.78, PRICE_TOLERANCE, 'break-even under the Vegas push-is-a-loss floor');
    closeTo(optimistic - conservative, 0.0120, 0.001, 'EV cost of giving the reduced bucket away');

    assert.throws(() => ticketEV({ legs, americanPrice: -110, reducedPayout: 'refund_plus_tip' }), /unknown/);
  });

test('ticketEV refuses a three-leg ticket whose reduced bucket it cannot price', () => {
  const pushy = [{ w: 0.73, t: 0.01 }, { w: 0.73, t: 0.01 }, { w: 0.73, t: 0.01 }];
  assert.throws(() => ticketEV({ legs: pushy, americanPrice: 160 }),
    /two-leg ticket/, 'one push reduces to a double and two reduce to a single; a scalar cannot say which');

  // With no possible push there is no reduced bucket and the maths is exact.
  const clean = [{ w: 0.74, t: 0 }, { w: 0.74, t: 0 }, { w: 0.74, t: 0 }];
  const out = ticketEV({ legs: clean, americanPrice: 160 });
  closeTo(out.probabilities.win, 0.74 ** 3, 1e-12, 'three independent legs');
  closeTo(out.ev, 0.74 ** 3 * 1.6 - (1 - 0.74 ** 3), 1e-12, 'three-leg EV');
});

test('profitMultiple round-trips real prices and rejects impossible ones', () => {
  closeTo(profitMultiple(100), 1, 1e-12, '+100');
  closeTo(profitMultiple(-110), 100 / 110, 1e-12, '-110');
  closeTo(profitMultiple(160), 1.6, 1e-12, '+160');
  assert.throws(() => profitMultiple(-99), /at or beyond/);
  assert.throws(() => profitMultiple(0), /at or beyond/);
});

test('familyTicketEV prices off the pooled rate and takes no line arguments',
  { skip: NEEDS_HISTORY }, () => {
    const priced = familyTicketEV({ americanPrice: -110 });
    const manual = ticketEV({ legs: familyLegs(), americanPrice: -110 });
    closeTo(priced.ev, manual.ev, 1e-12, 'familyTicketEV vs the pooled legs by hand');
    assert.equal(priced.leg_count, 2);
    assert.equal(priced.leg_sample, 2894);
    assert.equal(priced.seasons.to, 2024);
    closeTo(priced.leg_rate_of_decided, 0.7406, RATE_TOLERANCE, 'the rate it priced with');
  });

/* ========================================== 7. the independence assumption */

test('same-week legs never share a game, and the correlation is measured not assumed',
  { skip: NEEDS_HISTORY }, () => {
    const correlation = familyPairCorrelation();
    assert.equal(correlation.same_game_pairs, 0,
      'a game can never supply two cross-both legs — the counterpart of a -7..-8.5 favourite is a ' +
      '+7..+8.5 dog, which is not in the family');
    assert.equal(correlation.decided_legs, 2868);
    assert.ok(correlation.pairs > 8000, `expected thousands of same-week pairs, got ${correlation.pairs}`);
    closeTo(correlation.leg_rate, 0.7406, RATE_TOLERANCE, 'pair-study leg rate matches the family rate');

    // The brief for this module carried rho = +0.082 from the classic six-line
    // window; on this eight-line family the sign is the other way. The module
    // documents the discrepancy, and this pins the measurement so the
    // documentation cannot drift away from it.
    assert.ok(correlation.rho < 0,
      `expected slightly negative same-week correlation on this family, got ${correlation.rho}`);
    closeTo(correlation.rho, -0.044, 0.005, 'same-week leg correlation');
    assert.ok(correlation.joint_win_rate < correlation.independent_joint,
      'p-squared overstates the joint rate here, so independence is optimistic rather than conservative');
    assert.ok(Math.abs(correlation.joint_win_rate - correlation.independent_joint) < 0.02,
      'and the size of the error is small enough to document rather than correct for');
  });
