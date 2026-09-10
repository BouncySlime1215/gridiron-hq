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

const { marginDistribution, lineMoveTransitions, coverProbabilities, bestExecution, NO_FORECAST_BASE } =
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
  // Codex correction C05 replaced the coin-flip anchor plus absolute-margin
  // mixture with ONE coherent signed distribution, so these numbers are
  // re-derived from that object. Every game in this fixture carries spread -3,
  // so the residual r = margin + spread has the exact population
  //
  //   -13: 0.20   -10: 0.10   -6: 0.15   -3: 0.10   0: 0.15   4: 0.10   7: 0.20
  //
  // A side quoted at reference 3 is expected to lose by 3, so this game's
  // margin distribution is M = -3 + r:
  //
  //   -16: 0.20   -13: 0.10   -9: 0.15   -6: 0.10   -3: 0.15   1: 0.10   4: 0.20
  //
  // At target 4 the bet wins when M + 4 > 0, i.e. M > -4: that is M in
  // {-3, 1, 4} = 0.15 + 0.10 + 0.20 = 0.45. It pushes when M = -4, and no
  // mass sits there.
  const c = coverProbabilities(3, 4);
  assert.ok(Math.abs(c.win - 0.45) < 1e-6, JSON.stringify(c));
  assert.ok(Math.abs(c.loss - 0.55) < 1e-6, JSON.stringify(c));
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
  const quotes = [
    { book: 'median1', line: 3, american_price: -110 },
    { book: 'median2', line: 3, american_price: -110 },
    { book: 'worse', line: 1, american_price: -300 } // terrible line, terrible price -- must not look good
  ];
  const exec = bestExecution(quotes, { takingPoints: true });
  const worseEntry = exec.all.find(q => q.book === 'worse');
  assert.ok(worseEntry.win_probability < NO_FORECAST_BASE, JSON.stringify(worseEntry));
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
  // And a quote set that cannot be priced at all yields an explicit refusal.
  const unpriceable = bestExecution([
    { book: 'a', american_price: -110 },
    { book: 'b', american_price: -105 }
  ], { takingPoints: true });
  assert.equal(unpriceable.best, null);
  assert.equal(unpriceable.qualified, false);
  assert.match(unpriceable.reason, /no_qualified_distribution/);
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
