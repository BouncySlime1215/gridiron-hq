import test from 'node:test';
import assert from 'node:assert/strict';

// nfl-devig.js's job: turn two real American prices into a fair probability
// pair with the bookmaker's margin actually removed. The naive/legacy method
// (proportionalDevig) just splits the vig evenly; Shin's method (Hyun Song
// Shin, 1992) corrects for the favorite-longshot bias a skewed line carries —
// see the module header for the math. These tests check both methods agree
// on a normal near-even line, diverge on a heavily skewed one in the
// direction the literature predicts (Shin pushes the favorite's fair
// probability UP relative to the naive split), and that Shin's output is
// always a valid probability distribution.
const {
  americanToProb, proportionalDevig, shinDevig, shinNoVig, proportionalNoVig, noVig
} = await import('../server/services/nfl-devig.js');

test('americanToProb converts both sides of a standard -110/-110 line to 0.5238', () => {
  assert.ok(Math.abs(americanToProb(-110) - 110 / 210) < 1e-12);
  assert.ok(Math.abs(americanToProb(+150) - 100 / 250) < 1e-12);
});

test('a near-even line: Shin and the naive proportional split agree exactly', () => {
  const shin = shinDevig(-110, -110);
  const prop = proportionalDevig(-110, -110);
  assert.equal(shin.probA, 0.5);
  assert.equal(shin.probB, 0.5);
  assert.equal(prop.probA, 0.5);
  assert.equal(prop.probB, 0.5);
});

test('a mildly juiced prop line (-115/-105): Shin and proportional stay very close', () => {
  const shin = shinNoVig(-115, -105);
  const prop = proportionalNoVig(-115, -105);
  assert.ok(Math.abs(shin - prop) < 0.005, `expected Shin and proportional within half a point, got ${shin} vs ${prop}`);
});

test('a heavily skewed favorite moneyline (-900/+600): Shin and proportional diverge', () => {
  const shin = shinDevig(-900, 600);
  const prop = proportionalDevig(-900, 600);
  // Naive proportional splitting is documented to overstate the longshot's
  // true win probability on a skewed line; Shin corrects toward the
  // favorite, so Shin's favorite probability must be strictly higher.
  assert.ok(shin.probA > prop.probA,
    `Shin should push the favorite's fair probability above the naive split (${shin.probA} vs ${prop.probA})`);
  // The divergence should be real, not a rounding artifact — at this skew the
  // literature's effect size is on the order of a percentage point or more.
  assert.ok(shin.probA - prop.probA > 0.005,
    `expected a real divergence on a heavy favorite, got ${shin.probA - prop.probA}`);
});

test("Shin's output is always a valid probability distribution", () => {
  const cases = [[-110, -110], [-200, 170], [-900, 600], [-115, -105], [+120, -140], [-1400, 900]];
  for (const [a, b] of cases) {
    const { probA, probB } = shinDevig(a, b);
    assert.ok(probA > 0 && probA < 1, `probA out of range for ${a}/${b}: ${probA}`);
    assert.ok(probB > 0 && probB < 1, `probB out of range for ${a}/${b}: ${probB}`);
    assert.ok(Math.abs(probA + probB - 1) < 1e-9, `probabilities must sum to one for ${a}/${b}, got ${probA + probB}`);
  }
});

test('shinNoVig is antisymmetric: swapping side order swaps the answer and still sums to one', () => {
  const a = shinNoVig(-200, 170), b = shinNoVig(170, -200);
  assert.ok(Math.abs(a + b - 1) < 1e-9);
});

test('a missing price returns null rather than a fabricated probability', () => {
  assert.equal(shinNoVig(null, -110), null);
  assert.equal(shinNoVig(-110, undefined), null);
  assert.equal(proportionalNoVig(NaN, -110), null);
});

test('a fair (no-overround) pair falls back to the proportional split rather than dividing by a degenerate bracket', () => {
  // Two-way prices with S <= 1 (no real vig to correct for) — synthetic, but
  // a real arbitrage-priced pair looks exactly like this.
  const fair = shinDevig(+100, +105); // S = 0.5 + 0.4878 = 0.9878 < 1
  assert.ok(fair.probA > 0 && fair.probA < 1);
  assert.ok(Math.abs(fair.probA + fair.probB - 1) < 1e-9);
});

test('noVig is the Shin-based default export', () => {
  assert.equal(noVig, shinNoVig);
});
