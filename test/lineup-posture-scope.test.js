/**
 * The scope sentence on the posture card has to describe the number beside it.
 *
 * `win_probability_scope` reads "modelled skill slots only (N of M ...); K and
 * DEF excluded". N comes from `lineupSlots()`, which filters roster_positions to
 * the skill slots — so BENCH and IR were never in N. M was the RAW
 * `roster_positions.length`. While ESPN's roster_positions held starters only,
 * M − N really was K and DEF and the sentence was true.
 *
 * Once BENCH/IR/OP land in roster_positions, M grows and N does not, so the gap
 * becomes mostly bench and the sentence attributes it to K and DEF: a sixteen
 * entry roster renders "7 of 16" and claims nine unmodelled STARTING slots. The
 * figure quietly changes meaning while the prose around it does not.
 *
 * Two rules pinned here. The denominator counts slots the league actually
 * STARTS — the same notion trade-engine.js:2596 already uses ("a starter is ...
 * minus BENCH/IR"), across both vocabularies (BENCH/BN/IR/TAXI). And the
 * excluded slots are NAMED from the data rather than asserted, so an IDP league
 * does not get told its DL/LB/DB starters are "K and DEF", and a roster with no
 * kicker is not told it has one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { winProbabilityScope } = await import('../server/services/lineup-posture.js');
const { lineupSlots } = await import('../server/services/trade-engine.js');

const league = positions => ({ roster_positions: JSON.stringify(positions) });
const scopeFor = positions => {
  const lg = league(positions);
  return winProbabilityScope(lg, lineupSlots(lg));
};

const STARTERS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const BENCH = ['BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'IR'];

test('bench and IR do not inflate the denominator', () => {
  const withBench = scopeFor([...STARTERS, ...BENCH]);
  const withoutBench = scopeFor(STARTERS);
  assert.match(withBench, /7 of 9/,
    'the denominator counted bench and IR entries as slots the league starts');
  assert.equal(withBench, withoutBench,
    'adding bench rows to roster_positions changed a sentence about starting slots');
});

test('the excluded slots are named from the data, not asserted', () => {
  assert.match(scopeFor(STARTERS), /K, DEF excluded|K and DEF excluded/,
    'the standard roster does not name K and DEF as what is excluded');
});

test('an IDP league is not told its defensive starters are K and DEF', () => {
  const idp = scopeFor(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'DL', 'LB', 'DB', 'BENCH']);
  assert.match(idp, /DL/, 'DL is a started, unmodelled slot and is not named');
  assert.match(idp, /LB/);
  assert.match(idp, /DB/);
  assert.match(idp, /7 of 12/, 'the IDP denominator is wrong');
});

test('a roster with no kicker is not told it has one', () => {
  const skillOnly = scopeFor(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BENCH', 'BENCH']);
  assert.doesNotMatch(skillOnly, /\bK\b|DEF/, 'a roster with no K or DEF still claims they are excluded');
  assert.match(skillOnly, /nothing excluded/, 'a fully modelled starting lineup does not say so');
});

test("Sleeper's own bench vocabulary is excluded too", () => {
  const sleeper = scopeFor(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'TAXI', 'IR']);
  assert.match(sleeper, /7 of 9/, 'BN or TAXI was counted as a starting slot');
});

test('a superflex slot counts as modelled, not as an exclusion', () => {
  const sf = scopeFor(['QB', 'OP', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF', 'BENCH']);
  assert.match(sf, /7 of 9/, 'OP was not counted among the modelled slots');
  assert.doesNotMatch(sf, /OP/, 'OP is priced by lineupSlots but named as excluded');
});

test('a league with no roster slots on file says so instead of claiming nothing is excluded', () => {
  const lg = { roster_positions: null };
  const s = winProbabilityScope(lg, lineupSlots(lg));
  assert.doesNotMatch(s, /nothing excluded/,
    'with no roster data the card asserts nothing is excluded, which it cannot know');
  assert.match(s, /not on file|unknown/, 'the absent roster is not explained');
});
