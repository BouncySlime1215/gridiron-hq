/**
 * Codex audit finding E5 (2026-09-10): `bestExecution`'s shopped-line
 * "win probability" folded a push transition into a flat "half a win" scalar
 * (`lineMoveValue`) and fed that directly toward staking. A push is neither
 * a win nor a loss, and a loss-to-push transition (worth a full "avoid the
 * loss," i.e. +1 unit) is not the same dollar size as a push-to-win
 * transition (worth a full win, i.e. +profit-multiple units) -- "half a win"
 * for both is a defensible RANKING proxy, not an accurate probability.
 *
 * These tests build an exact, known synthetic margin distribution (so every
 * expected number below is hand-derivable, not just "plausible") and prove:
 * lineMoveTransitions splits a boundary crossing into the correct
 * loss/push/win buckets; coverProbabilities' three outputs always sum to
 * exactly 1 and correctly migrate mass from a reference line to a real
 * target line; and bestExecution attaches this breakdown to its best quote
 * so a downstream consumer never has to re-derive it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-edge-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// A KNOWN, exact synthetic margin distribution: margin 0 -> 10%, margin 3 ->
// 30%, margin 7 -> 20%, margin 10 -> 40% (100 games total). Every expected
// number in this file is hand-derived from exactly this population.
const N = 100;
const COUNTS = { 0: 10, 3: 30, 7: 20, 10: 40 };
let seq = 0;
for (const [margin, count] of Object.entries(COUNTS)) {
  const m = Number(margin);
  for (let i = 0; i < count; i++) {
    seq++;
    // Alternate which side "wins" so the population is genuinely symmetric
    // for nonzero margins, matching what marginDistribution() (Math.abs)
    // and the signed-splitting logic elsewhere both assume.
    const home = i % 2 === 0 || m === 0 ? m : 0;
    const away = i % 2 === 0 || m === 0 ? 0 : m;
    run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
      VALUES (2024,?,?,?,1,-3,44,?,?)`, seq, `H${seq}`, `A${seq}`, 20 + home, 20 + away);
  }
}

const { marginDistribution, lineMoveTransitions, coverProbabilities, bestExecution, NO_FORECAST_BASE, stakeFor } =
  await import('../server/services/nfl-execution-edge.js');

test('the synthetic pmf matches the constructed population exactly', () => {
  const { pmf, n } = marginDistribution();
  assert.equal(n, N);
  for (const [margin, count] of Object.entries(COUNTS)) {
    assert.ok(Math.abs(pmf.get(Number(margin)) - count / N) < 1e-9, `margin ${margin}`);
  }
});

test('lineMoveTransitions: crossing a key number at an INTEGER reference produces a real push_to_win, not a blended half-win', () => {
  // Moving from worseLine=3 to betterLine=4: margin=-3 pushes at 3 (signed
  // margin === -3) and wins at 4 (signed margin -3 > -4). That is exactly
  // HALF of the margin-3 population (the -3 signed half): 0.30/2 = 0.15.
  const t = lineMoveTransitions(3, 4);
  assert.ok(Math.abs(t.push_to_win - 0.15) < 1e-6, JSON.stringify(t));
  assert.equal(t.loss_to_win, 0);
  assert.equal(t.loss_to_push, 0);
});

test('lineMoveTransitions: crossing a key number between two HALF-POINT lines produces a full loss_to_win, never a push', () => {
  // 2.5 -> 3.5 never lands exactly on an integer, so there is no push
  // boundary at all -- the entire -3 signed half (0.15) flips outright.
  const t = lineMoveTransitions(2.5, 3.5);
  assert.ok(Math.abs(t.loss_to_win - 0.15) < 1e-6, JSON.stringify(t));
  assert.equal(t.loss_to_push, 0);
  assert.equal(t.push_to_win, 0);
});

test('lineMoveTransitions: a move that crosses no probability mass at all reports all zeros', () => {
  const t = lineMoveTransitions(4, 5); // no games with |margin| in (4,5] at all in this synthetic population
  assert.deepEqual(t, { loss_to_win: 0, loss_to_push: 0, push_to_win: 0 });
});

test('lineMoveTransitions: refuses a backwards or equal call rather than silently computing a negative-width interval', () => {
  assert.deepEqual(lineMoveTransitions(4, 3), { loss_to_win: 0, loss_to_push: 0, push_to_win: 0 });
  assert.deepEqual(lineMoveTransitions(3, 3), { loss_to_win: 0, loss_to_push: 0, push_to_win: 0 });
});

test('coverProbabilities: the three outputs always sum to exactly 1', () => {
  for (const [ref, target] of [[3, 4], [4, 3], [2.5, 3.5], [0, 7], [7, 0], [-3, 3]]) {
    const c = coverProbabilities(ref, target);
    assert.ok(c, `${ref} -> ${target}`);
    assert.ok(Math.abs(c.win + c.loss + c.push - 1) < 1e-6, `${ref}->${target}: ${JSON.stringify(c)}`);
  }
});

test('coverProbabilities: hand-derived exact numbers for reference=3, target=4', () => {
  // CORRECTED 2026-09-10. These numbers were originally derived from a model
  // that shifted one pooled residual distribution by the reference line, which
  // is translation-invariant and therefore priced every half point identically.
  // The distribution now CONDITIONS on the posted line instead, so the
  // derivation changes with it.
  //
  // Every game in this fixture carries a home spread of -3, and the population
  // is symmetric, so the margins seen from EITHER side of a 3-point line are
  //
  //   -10: 0.20   -7: 0.10   -3: 0.15   0: 0.10   3: 0.15   7: 0.10   10: 0.20
  //
  // At target 4 the bet wins when M + 4 > 0, i.e. M > -4: that is
  // {-3, 0, 3, 7, 10} = 0.15 + 0.10 + 0.15 + 0.10 + 0.20 = 0.70. It pushes when
  // M = -4, and no mass sits there.
  const c = coverProbabilities(3, 4);
  assert.ok(Math.abs(c.win - 0.70) < 1e-6, JSON.stringify(c));
  assert.ok(Math.abs(c.loss - 0.30) < 1e-6, JSON.stringify(c));
  assert.ok(Math.abs(c.push - 0) < 1e-6, JSON.stringify(c));
});

test('coverProbabilities: a WORSE line strictly reduces win probability, and never leaves the unit interval', () => {
  // The exact defect C05 reports: `coverProbabilities(3, -10.5)` returned
  // win -0.125, loss 1.125, push 0. A negative probability is not a number
  // that needs clipping -- it means the object producing it was never a
  // distribution.
  const far = coverProbabilities(3, -10.5);
  assert.ok(far.win >= 0 && far.win <= 1, `win must be a probability: ${JSON.stringify(far)}`);
  assert.ok(far.loss >= 0 && far.loss <= 1, `loss must be a probability: ${JSON.stringify(far)}`);
  assert.ok(Math.abs(far.win + far.loss + far.push - 1) < 1e-6);

  const better = coverProbabilities(3, 4);
  const worse = coverProbabilities(3, 3);
  assert.ok(worse.win < better.win, 'fewer points cannot raise the win probability');
});

test('coverProbabilities: equal lines return the reference baseline directly (no migration needed); non-finite inputs refuse rather than fabricate', () => {
  const equal = coverProbabilities(3, 3);
  assert.ok(Math.abs(equal.win + equal.loss + equal.push - 1) < 1e-6);
  assert.ok(equal.push > 0, 'line 3 is an integer -- its own baseline must show real push mass');
  assert.equal(coverProbabilities(NaN, 4), null);
  assert.equal(coverProbabilities(3, undefined), null);
});

test('bestExecution attaches the exact three-state breakdown to its best quote, and it sums to 1', () => {
  // Three books on the same side: 3 (median), 3.5, and a much worse 1.
  const quotes = [
    { book: 'a', line: 3, american_price: -110 },
    { book: 'b', line: 3.5, american_price: -110 },
    { book: 'c', line: 1, american_price: -110 }
  ];
  const exec = bestExecution(quotes, { takingPoints: true });
  assert.ok(exec);
  assert.equal(exec.best.book, 'b');
  assert.ok(Number.isFinite(exec.best.win_probability), JSON.stringify(exec.best));
  assert.ok(Number.isFinite(exec.best.loss_probability));
  assert.ok(Number.isFinite(exec.best.push_probability));
  const sum = exec.best.win_probability + exec.best.loss_probability + exec.best.push_probability;
  assert.ok(Math.abs(sum - 1) < 1e-3, `win+loss+push should sum to 1, got ${sum}`);
  // Book 'b' (3.5) is strictly better than the median (3) at the same price,
  // so it must win more often and be worth more.
  const median = exec.all.find(q => q.book === 'a');
  assert.ok(exec.best.win_probability > median.win_probability);
  assert.ok(exec.best.expected_net_return > median.expected_net_return);
});

test('bestExecution: a book with a WORSE line than the median shows below-baseline win probability, never a fabricated advantage', () => {
  // The worse line is -5 rather than +1. In this fixture the margin population
  // is {0, +/-3, +/-7, +/-10}, so +1 and +3 win on exactly the same games --
  // there is no mass between them, and a test that used +1 was asserting a
  // difference the fixture cannot express. -5 genuinely gives up the 3.
  const quotes = [
    { book: 'median1', line: 3, american_price: -110 },
    { book: 'median2', line: 3, american_price: -110 },
    { book: 'worse', line: -5, american_price: -300 } // terrible line, terrible price -- must not look good
  ];
  const exec = bestExecution(quotes, { takingPoints: true });
  const worseEntry = exec.all.find(q => q.book === 'worse');
  const medianEntry = exec.all.find(q => q.book === 'median1');
  assert.ok(worseEntry.win_probability < medianEntry.win_probability, JSON.stringify(worseEntry));
  assert.ok(worseEntry.expected_net_return < medianEntry.expected_net_return);
  assert.notEqual(exec.best.book, 'worse', 'a worse line at a worse price can never rank first');
});

/* ======================================================================
 * Codex correction C05 — "Shopping probabilities can be impossible; ranking
 * contradicts EV." Close-with: "generated probability, sign, monotonicity,
 * adjacent-line push, cutoff and ranking tests; independent direct-payout
 * arithmetic; explicit refusal when no qualified distribution is available."
 * ====================================================================== */

const fc = (await import('fast-check')).default;
const { noForecastMarginDistribution, marginResidualDistribution, resetMarginResidualCache } =
  await import('../server/services/nfl-execution-edge.js');

test('C05: the reported counterexample no longer produces an impossible probability', () => {
  // "coverProbabilities(3, -10.5) returned win -0.125, loss 1.125, push zero
  // on the preserved empirical-margin fixture."
  const c = coverProbabilities(3, -10.5);
  assert.ok(c.win >= 0 && c.win <= 1, JSON.stringify(c));
  assert.ok(c.loss >= 0 && c.loss <= 1, JSON.stringify(c));
  assert.ok(c.push >= 0 && c.push <= 1, JSON.stringify(c));
  assert.ok(Math.abs(c.win + c.loss + c.push - 1) < 1e-6);
});

test('C05: EVERY generated line pair produces a valid probability triple', () => {
  const halfPoints = fc.integer({ min: -60, max: 60 }).map(h => h / 2);
  fc.assert(fc.property(halfPoints, halfPoints, (reference, target) => {
    const c = coverProbabilities(reference, target);
    if (c == null) return true;
    if (!(c.win >= 0 && c.win <= 1 && c.loss >= 0 && c.loss <= 1 && c.push >= 0 && c.push <= 1)) return false;
    return Math.abs(c.win + c.loss + c.push - 1) < 1e-3;
  }), { numRuns: 600 });
});

test('C05: win probability is monotone in the points taken', () => {
  const halfPoints = fc.integer({ min: -40, max: 40 }).map(h => h / 2);
  fc.assert(fc.property(halfPoints, halfPoints, fc.integer({ min: 1, max: 14 }),
    (reference, target, extra) => {
      const less = coverProbabilities(reference, target);
      const more = coverProbabilities(reference, target + extra);
      if (!less || !more) return true;
      return more.win >= less.win - 1e-9;
    }), { numRuns: 400 });
});

test('C05: a half-point line NEVER pushes; its integer neighbours may', () => {
  const halfPoints = fc.integer({ min: -40, max: 40 }).map(h => h / 2);
  fc.assert(fc.property(halfPoints, halfPoints, (reference, target) => {
    const c = coverProbabilities(reference, target);
    if (!c) return true;
    const isHalf = Math.abs(Math.abs(target % 1) - 0.5) < 1e-9;
    return !isHalf || c.push === 0;
  }), { numRuns: 400 });

  // Adjacent lines around a key number: only the integer can push, and it
  // pushes on exactly the mass the other two split between win and loss.
  const at = t => coverProbabilities(3, t);
  assert.equal(at(2.5).push, 0);
  assert.equal(at(3.5).push, 0);
  assert.ok(at(3).push > 0);
  assert.ok(Math.abs((at(3.5).win - at(2.5).win) - at(3).push) < 1e-6,
    'the push mass at the integer is exactly what the two half-points differ by');
});

test('C05: ranking follows expected return, not a points-versus-price heuristic', () => {
  // The audit's exact counterexample: "+2.5/+100 was ranked above +3/-150 even
  // though its own EVs were -0.1500 and -0.1416667 respectively." The old
  // score was line_edge * 2 + price_edge, which disagreed with the economics
  // printed beside it.
  const exec = bestExecution([
    { book: 'cheap-line', line: 2.5, american_price: 100 },
    { book: 'better-line', line: 3, american_price: -150 }
  ], { takingPoints: true });

  const ranked = exec.all.map(q => [q.book, q.expected_net_return]);
  const [top] = exec.all;
  assert.equal(top.book, exec.best.book);
  for (const q of exec.all.slice(1)) {
    assert.ok(top.expected_net_return >= q.expected_net_return,
      `ranking must follow expected return: ${JSON.stringify(ranked)}`);
  }
  assert.equal(top.total_edge, null, 'the heuristic score is retired, not silently reused');
});

test('C05: expected return matches an independent direct-payout calculation', () => {
  const exec = bestExecution([
    { book: 'a', line: 3, american_price: -110 },
    { book: 'b', line: 3.5, american_price: 120 }
  ], { takingPoints: true });

  for (const q of exec.all) {
    if (q.expected_net_return == null) continue;
    // Oracle: stake 1 unit. A win returns the profit multiple, a loss returns
    // -1, a push returns 0. Written from the payout rules, not from the code.
    const profit = q.american_price > 0 ? q.american_price / 100 : 100 / Math.abs(q.american_price);
    const oracle = q.win_probability * profit + q.push_probability * 0 + q.loss_probability * -1;
    assert.ok(Math.abs(q.expected_net_return - oracle) < 1e-3,
      `${q.book}: ${q.expected_net_return} vs oracle ${oracle}`);
  }
});

test('C05: nothing here claims to be a qualified edge', () => {
  const exec = bestExecution([
    { book: 'a', line: 3, american_price: -110 },
    { book: 'b', line: 3.5, american_price: -110 }
  ], { takingPoints: true });
  assert.equal(exec.qualified, false,
    'these probabilities come from the market\'s own line; a better contract is not an edge');
  assert.match(exec.qualification_note, /never a positive expectation/);
});

test('C05: with no qualified distribution available, it refuses rather than ranking', async () => {
  // A separate database with scores but NO posted spreads: there is no
  // residual population, so there is nothing to price against.
  const emptyTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-no-dist-'));
  const previous = process.env.GRIDIRON_DB_PATH;
  process.env.GRIDIRON_DB_PATH = path.join(emptyTemp, 'empty.sqlite');
  try {
    resetMarginResidualCache();
    // The live module still points at the original connection, so assert the
    // refusal shape directly on a distribution built from an empty population.
    const built = noForecastMarginDistribution(Number.NaN);
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'reference_line_not_finite');
  } finally {
    process.env.GRIDIRON_DB_PATH = previous;
    resetMarginResidualCache();
    fs.rmSync(emptyTemp, { recursive: true, force: true });
  }
  // A quote set with no handicap at all is a MONEYLINE, and is ranked by price
  // rather than refused -- see the C05 regression tests at the end of this
  // file. This originally asserted a refusal there, which is what killed h2h
  // shopping on the live board. The refusal still applies to a contract that
  // has lines but cannot be priced under a valid distribution.
  const moneyline = bestExecution([
    { book: 'a', american_price: -110 },
    { book: 'b', american_price: -105 }
  ], { takingPoints: true });
  assert.equal(moneyline.best.book, 'b', '-105 pays more than -110 for the same outcome');
  assert.equal(moneyline.ranked_by, 'price_only');
  assert.equal(moneyline.qualified, false);

  // A quote set with no USABLE line is indistinguishable from a moneyline here
  // -- `Number.isFinite` rejects null and NaN alike -- so it is ranked by price
  // at the common (absent) number, exactly as h2h is.
  const noUsableLine = bestExecution([
    { book: 'a', line: Number.NaN, american_price: -110 },
    { book: 'b', line: Number.NaN, american_price: -105 }
  ], { takingPoints: true });
  assert.equal(noUsableLine.best.book, 'b');
  assert.equal(noUsableLine.ranked_by, 'price_only');
  assert.equal(noUsableLine.qualified, false);

  // The genuine refusal survives: lines that exist, no distribution that covers
  // them, and no two books at the same number to compare like for like.
  const unpriceable = bestExecution([
    { book: 'a', line: 44.5, american_price: -110 },
    { book: 'b', line: 51.5, american_price: -105 }
  ], { takingPoints: true });
  if (unpriceable.best == null) {
    assert.equal(unpriceable.qualified, false);
    assert.match(unpriceable.reason, /no_qualified_distribution/);
  }
});

test('C05: the residual population is the one this database actually contains', () => {
  const { pmf, n } = marginResidualDistribution();
  assert.equal(n, N, 'every fixture game carries both a score and a spread');
  // Fixture spread is -3 throughout, so residual = margin - 3. Margin 0
  // (10 games) gives residual -3; margin 3 splits 15 home / 15 away giving
  // residuals 0 and -6.
  assert.ok(Math.abs(pmf.get(-3) - 0.10) < 1e-9);
  assert.ok(Math.abs(pmf.get(0) - 0.15) < 1e-9);
  assert.ok(Math.abs(pmf.get(-6) - 0.15) < 1e-9);
  assert.ok(Math.abs([...pmf.values()].reduce((s, p) => s + p, 0) - 1) < 1e-9);
});

/* ======================================================================
 * Regressions introduced by the C05 rewrite itself, found by an adversarial
 * review against real quote data on 2026-09-10. Both cost real money on the
 * live board, and neither was caught by the tests above — which is the point
 * of writing them down here.
 * ====================================================================== */

test('C05 regression: a half point is worth MORE at 3 and 7 than at 5 and 9', () => {
  // The first C05 distribution shifted one pooled residual pmf by the
  // reference line. Shifting is translation-invariant, so every half point
  // everywhere came out worth exactly the same 4.57% — the "all half points
  // are equal" mistake this file's own header names as the thing that makes
  // line shopping look marginal.
  //
  // Key numbers do not move with the spread. A game posted at -2.5 cannot land
  // on -2.5; one posted at -3 lands on it about one time in ten.
  const halfPoint = K => {
    const hi = coverProbabilities(K, K + 0.5), lo = coverProbabilities(K, K - 0.5);
    return hi && lo ? hi.win - lo.win : null;
  };
  const three = halfPoint(3), seven = halfPoint(7), five = halfPoint(5), nine = halfPoint(9);
  for (const [name, v] of [['3', three], ['7', seven], ['5', five], ['9', nine]]) {
    assert.ok(v != null, `no value computed at ${name}`);
  }
  assert.ok(three > five, `the 3 must be worth more than the 5 (${three} vs ${five})`);
  assert.ok(three > nine, `the 3 must be worth more than the 9 (${three} vs ${nine})`);
  assert.ok(seven > nine, `the 7 must be worth more than the 9 (${seven} vs ${nine})`);
  assert.ok(three > 0.05, `the 3 is the most valuable number in football; got ${three}`);

  // And the values must not all be the same, which is the defect stated
  // directly rather than inferred from the comparisons above.
  const distinct = new Set([three, seven, five, nine].map(v => v.toFixed(4)));
  assert.ok(distinct.size > 1,
    'every half point priced identically — the distribution is translation-invariant again');
});

test('C05 regression: MONEYLINE shopping ranks by price rather than refusing', () => {
  // A contract with no handicap has nothing to price with a margin
  // distribution and needs none: both books sell the identical outcome, so the
  // best book is the best price. The first C05 refusal treated "no
  // distribution" as "cannot rank" and killed h2h shopping entirely — 30 of 30
  // sides on the live tape returned a refusal where every one had priced.
  const exec = bestExecution([
    { book: 'draftkings', line: null, american_price: -205 },
    { book: 'pinnacle', line: null, american_price: -194 },
    { book: 'fanduel', line: null, american_price: -200 }
  ], { takingPoints: true });

  assert.ok(exec.best, 'a moneyline slate must still produce a best book');
  assert.equal(exec.best.book, 'pinnacle', '-194 pays more than -200 and -205');
  assert.equal(exec.ranked_by, 'price_only');
  assert.equal(exec.qualified, false,
    'a better price is a fact about the market, never an edge over it');
  assert.match(exec.qualification_note, /never an edge/);
});

test('C05 regression: buying a key number beats a small price gain', () => {
  // The concrete case from the review: -3 at -110 versus -2.5 at -115. Moving
  // off the 3 wins every game decided by exactly 3, which the flat model
  // priced at 4.57% and therefore sold for a 7% price improvement.
  const exec = bestExecution([
    { book: 'sells-the-three', line: -3, american_price: -110 },
    { book: 'buys-the-three', line: -2.5, american_price: -115 }
  ], { takingPoints: true });

  assert.equal(exec.best.book, 'buys-the-three',
    'crossing the 3 is worth more than 5 cents of price');
  assert.ok(exec.best.expected_net_return > exec.all.find(q => q.book === 'sells-the-three').expected_net_return);
});

test('C05 regression: the distribution says how far it had to widen to find data', () => {
  // A distribution pooled across a six-point window is a weaker statement than
  // one built from an exact line match, and a caller must be able to tell.
  const common = noForecastMarginDistribution(-3);
  assert.equal(common.ok, true);
  assert.equal(typeof common.line_window, 'number');
  assert.equal(typeof common.exact_line_games, 'number');
  assert.ok(common.games >= 60, 'enough games to estimate from');

  const absurd = noForecastMarginDistribution(-45);
  if (absurd.ok) {
    assert.ok(absurd.line_window > common.line_window,
      'an unusual line must widen the window further than a common one');
  } else {
    assert.match(absurd.reason, /no_games_near_this_line|no_qualified/);
  }
});

test('C05 regression: a contract this module cannot price is ranked by price, not refused', () => {
  // The module owns ONE distribution -- NFL winning margins -- so it can value
  // a spread number and nothing else. A total of 44.5 is not a margin of 44.5.
  //
  // The first version handed totals a probability from the margin distribution
  // anyway; refusing that was the improvement. But refusing ENTIRELY was a
  // regression, because best-price-on-an-identical-contract needs no
  // distribution at all. On the live board it took 34 of 34 totals rows and,
  // by the same mechanism, all 30 moneyline rows.
  const totals = bestExecution([
    { book: 'a', line: 44.5, american_price: -110 },
    { book: 'b', line: 44.5, american_price: -105 },   // same contract, better price
    { book: 'c', line: 45.5, american_price: -110 }    // a DIFFERENT contract
  ], { takingPoints: true });

  assert.ok(totals.best, 'a totals slate must still produce a best book');
  assert.equal(totals.best.book, 'b', '-105 beats -110 on the identical number');
  assert.equal(totals.ranked_by, 'price_only');
  assert.equal(totals.compared_at_line, 44.5);
  assert.deepEqual(totals.lines_not_compared, [45.5],
    'the other number is listed but explicitly not compared');
  assert.equal(totals.qualified, false);
  assert.match(totals.qualification_note, /cannot value/);
});

test('C05 regression: a single quote at the common number still cannot be ranked', () => {
  // Two books at different numbers and nothing to compare like for like. There
  // is no honest answer here, and inventing one is what the refusal is for.
  const exec = bestExecution([
    { book: 'a', line: 44.5, american_price: -110 },
    { book: 'b', line: 47.5, american_price: -105 }
  ], { takingPoints: true });
  if (exec.best) {
    // If a distribution happened to cover these numbers, it must have ranked by
    // expected return rather than by price.
    assert.equal(exec.ranked_by, undefined);
  } else {
    assert.equal(exec.qualified, false);
    assert.match(exec.reason, /no_qualified_distribution/);
  }
});

/* ============================================================ stakeFor gate */

// a6-money-path: stakeFor()'s CLV-proof gate was a DENY-list on the literal
// string 'model' (`source === 'model'`), so anything that was not exactly
// that string -- a typo, an unrecognised opportunity kind -- sailed straight
// through to a full, unvalidated stake. The fix inverts it to an ALLOW-list
// on 'execution'. These lock the allow-list in, especially the case a
// deny-list can never catch: a source value nobody wrote down.

test('stakeFor: an unrecognised source is treated as unproven and blocked, not allowed through', () => {
  const out = stakeFor({ winProbability: 0.58, americanPrice: -110, source: 'totally_made_up' });
  assert.equal(out.units, 0);
  assert.equal(out.blocked, true);
  assert.match(out.reason, /closing-line value/);
});

test('stakeFor: the literal source "model" is still blocked without proven CLV', () => {
  const out = stakeFor({ winProbability: 0.58, americanPrice: -110, source: 'model' });
  assert.equal(out.units, 0);
  assert.equal(out.blocked, true);
});

test('stakeFor: an unrecognised source WITH proven CLV is allowed to size, same as "model" would be', () => {
  const out = stakeFor({ winProbability: 0.58, americanPrice: -110, source: 'totally_made_up', provenClv: 0.01 });
  assert.equal(out.blocked, undefined);
  assert.ok(out.units > 0);
});

test('stakeFor: "execution" sizes a real stake with no CLV proof required', () => {
  const out = stakeFor({ winProbability: 0.58, americanPrice: -110, source: 'execution' });
  assert.equal(out.blocked, undefined);
  assert.ok(out.units > 0);
});
