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

test('coverProbabilities: hand-derived exact numbers for reference=3, target=4 (push-to-win case)', () => {
  // pushAtReference = pmf(3)/2 = 0.15 (HALF the magnitude-3 mass -- the
  // earlier, buggy version of this function used the full 0.30, which this
  // test would catch). decided = 0.85, winRef = lossRef = 0.425.
  // lineMoveTransitions(3,4) = {push_to_win: 0.15, others 0}.
  const c = coverProbabilities(3, 4);
  assert.ok(Math.abs(c.win - 0.575) < 1e-6, JSON.stringify(c));   // 0.425 + 0.15
  assert.ok(Math.abs(c.loss - 0.425) < 1e-6, JSON.stringify(c));  // unchanged
  assert.ok(Math.abs(c.push - 0) < 1e-6, JSON.stringify(c));      // 0.15 - 0.15
});

test('coverProbabilities: moving to a WORSE line correctly reduces win probability below the coin-flip baseline', () => {
  // reference=4 (no push mass there), target=3 is WORSE: some of the
  // reference's win mass (the -3 signed half that only wins because 4 > 3)
  // must move back to loss/push at the worse target line.
  const c = coverProbabilities(4, 3);
  assert.ok(c.win < NO_FORECAST_BASE, `moving to a worse line must not increase win probability: ${JSON.stringify(c)}`);
  assert.ok(c.push > 0, 'the worse (integer) line must show real push mass the better line did not have');
});

test('coverProbabilities: equal lines return the reference baseline directly (no migration needed); non-finite inputs refuse rather than fabricate', () => {
  const equal = coverProbabilities(3, 3);
  assert.ok(Math.abs(equal.win + equal.loss + equal.push - 1) < 1e-6);
  assert.ok(equal.push > 0, 'line 3 is an integer -- its own baseline must show real push mass');
  assert.equal(coverProbabilities(NaN, 4), null);
  assert.equal(coverProbabilities(3, undefined), null);
});

test('bestExecution attaches the exact three-state breakdown to its best quote, and it sums to 1', () => {
  // Three books on the same side: 3 (median), 3.5, and a much worse 1 --
  // the best book by total_edge should be 3.5 (a real key-number cross).
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
  // Book 'b' (3.5) is strictly better than the median (3), so its win
  // probability must exceed the no-forecast baseline.
  assert.ok(exec.best.win_probability > NO_FORECAST_BASE);
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
