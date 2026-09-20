/**
 * The grounding check: an answer ships only if every number in it came back
 * from the database.
 *
 * This is the part of Coach that makes "doesn't hallucinate" a property rather
 * than an instruction. Today's assistant asks the model not to invent numbers
 * (nfl-page-explain.js:60) and then returns whatever comes back
 * (nfl-page-explain.js:88-133). The sibling that got it right is
 * /trades/:leagueId/sense-check (server/routes/trades.js:705-887): it checks
 * the model's verdict against a simulation and retries once when they
 * disagree. This is that shape, made deterministic — no second model call, no
 * judgement, just: is this number in the ledger or is it not.
 *
 * What counts as grounded: the exact value of a cited cell, the same value at
 * the precision the claim states it to, or that value expressed as a
 * percentage (0.284 written as 28.4%). Anything else is a violation and the
 * answer does not ship.
 *
 * What is a warning rather than a violation, stated honestly because it is a
 * real limit: a number spelled out in words, and a proper noun that appears in
 * no cited row. Both are recorded in the audit; neither blocks. Digits block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer, VIOLATIONS } = await import('../server/services/coach/verify.js');

const queryResult = (rows, tables = ['player_week_usage'], provenance = {}) => ({
  sql: 'SELECT ...', params: [], tables, columns: Object.keys(rows[0] ?? {}),
  rows, row_count: rows.length, truncated: false, max_rows: 200, provenance
});

function ledgerWithUsage() {
  const ledger = newLedger();
  ledger.record(queryResult([
    { name: 'A Player', week: 3, targets: 11, target_share: 0.284, fantasy_points: 18.4 }
  ], ['player_week_usage'], { player_week_usage: { collection: 'auto', freshness: 'nflverse weekly' } }));
  return ledger;
}

test('a claim whose numbers are all cited cells passes', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger,
    answer: { claims: [{ text: 'He saw 11 targets in week 3 for 18.4 points.',
      cites: ['r1#0.targets', 'r1#0.week', 'r1#0.fantasy_points'] }] }
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.deepEqual(result.violations, []);
  assert.equal(result.numbers_checked, 3);
});

test('a number that is in no cited cell is a violation, and the violation names it', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger,
    answer: { claims: [{ text: 'He saw 11 targets and ran 14 routes.', cites: ['r1#0.targets'] }] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].kind, VIOLATIONS.UNGROUNDED_NUMBER);
  assert.equal(result.violations[0].number, '14');
  assert.equal(result.violations[0].claim_index, 0);
});

test('a cell cited by another claim does not ground this one', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger,
    // The first claim cites the cell that holds 18.4. The second states 18.4
    // and cites something else. If citations pooled, the first claim's
    // evidence would launder the second — which is the whole reason a cite
    // belongs to a claim rather than to an answer.
    answer: { claims: [
      { text: 'He scored 18.4 points.', cites: ['r1#0.fantasy_points'] },
      { text: 'He saw 18.4 targets.', cites: ['r1#0.targets'] }
    ] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
  assert.equal(result.violations[0].claim_index, 1);
  assert.equal(result.violations[0].number, '18.4');
});

test('a value stated to fewer decimals than the row holds is grounded', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'His target share is 0.28.', cites: ['r1#0.target_share'] }] }
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a share written as a percentage is grounded against the fraction it came from', () => {
  const ledger = ledgerWithUsage();
  for (const text of ['His target share is 28.4%.', 'He took 28% of the targets.']) {
    const result = verifyAnswer({ ledger, answer: { claims: [{ text, cites: ['r1#0.target_share'] }] } });
    assert.equal(result.ok, true, `${text} → ${JSON.stringify(result.violations)}`);
  }
});

test('a percentage that is not the cited value is still caught', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'His target share is 41%.', cites: ['r1#0.target_share'] }] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].number, '41');
});

test('a number one away from the cited cell is not grounded — close is not cited', () => {
  // The precision rule says a claim may state a cell to fewer decimals than
  // the row holds: 0.284 written as 0.28 is the same number, rounded. That is
  // a rounding allowance, not a tolerance, and the difference matters. If it
  // ever became a tolerance — "within one at the stated precision" — then 12
  // targets would pass against a row holding 11, and Coach would ship a wrong
  // number with a citation attached, which is worse than an uncited one.
  const ledger = ledgerWithUsage();
  const wrong = [
    ['He saw 12 targets.', '12', 'r1#0.targets'],            // 11 stated as 12
    ['His target share is 0.29.', '0.29', 'r1#0.target_share'], // 0.284 rounds to 0.28
    ['His target share is 29.4%.', '29.4', 'r1#0.target_share'] // 28.4% stated as 29.4%
  ];
  for (const [text, number, cite] of wrong) {
    const result = verifyAnswer({ ledger, answer: { claims: [{ text, cites: [cite] }] } });
    assert.equal(result.ok, false, `${text} was accepted`);
    assert.equal(result.violations.length, 1, `${text} → ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations[0].kind, VIOLATIONS.UNGROUNDED_NUMBER, text);
    assert.equal(result.violations[0].number, number, text);
  }
});

test('a claim with no cites is a violation even when it contains no number', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'He is trending up.', cites: [] }] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, VIOLATIONS.UNCITED_CLAIM);
});

test('a cite that resolves to nothing is a violation naming the cite', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'He saw 11 targets.', cites: ['r9#0.targets'] }] }
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.kind === VIOLATIONS.BAD_CITE && v.cite === 'r9#0.targets'));
});

test('a number worked out by the ledger grounds the claim that states it', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ targets: 30 }, { targets: 10 }]));
  ledger.derive({ op: 'sum', inputs: ['r1#0.targets', 'r1#1.targets'], label: 'total targets' });
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'The two of them saw 40 targets.', cites: ['d1'] }] }
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('arithmetic the model did in its head is not grounded, however right it is', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ targets: 30 }, { targets: 10 }]));
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'The two of them saw 40 targets.',
      cites: ['r1#0.targets', 'r1#1.targets'] }] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].number, '40');
  assert.match(result.violations[0].detail, /ledger|derive/i);
});

test('a thousands separator, a leading plus and a minus sign are all read as the number', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ rows: 1349, spread: -3.5, swing: 2 }]));
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'There are 1,349 rows, the spread is -3.5 and the swing is +2.',
      cites: ['r1#0.rows', 'r1#0.spread', 'r1#0.swing'] }] }
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('hand-collected data obliges the answer to state its age', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ verdict: 'weak', n: 4 }], ['slot_weakness'],
    { slot_weakness: { collection: 'by_hand', freshness: 'generated on demand' } }));
  const uncaveated = verifyAnswer({
    ledger, answer: { claims: [{ text: 'That slot is weak on 4 looks.', cites: ['r1#0.n', 'r1#0.verdict'] }] }
  });
  assert.equal(uncaveated.ok, false);
  assert.ok(uncaveated.violations.some(v => v.kind === VIOLATIONS.MISSING_AS_OF));
  assert.ok(uncaveated.violations.find(v => v.kind === VIOLATIONS.MISSING_AS_OF).tables.includes('slot_weakness'));

  const caveated = verifyAnswer({
    ledger,
    answer: {
      claims: [{ text: 'That slot is weak on 4 looks.', cites: ['r1#0.n', 'r1#0.verdict'] }],
      as_of: 'slot_weakness is written only when someone asks for it; this row was generated on demand.'
    }
  });
  assert.equal(caveated.ok, true, JSON.stringify(caveated.violations));
});

test('an answer with no claims is a violation, not a pass by vacuum', () => {
  const ledger = ledgerWithUsage();
  for (const answer of [{ claims: [] }, {}, { claims: null }]) {
    const result = verifyAnswer({ ledger, answer });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(v => v.kind === VIOLATIONS.EMPTY_ANSWER));
  }
});

test('a refusal is a legitimate answer and needs no cites', () => {
  const ledger = newLedger();
  const result = verifyAnswer({
    ledger,
    answer: { claims: [], refusals: ['Coach does not read league_transactions_raw, so it cannot say.'] }
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a number spelled out in words is a warning, not a block, and the warning says so', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'He led the team in three of the last four weeks.',
      cites: ['r1#0.targets'] }] }
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.kind === 'spelled_number'));
});

test('the check reports how many numbers it examined, so an empty check is visible', () => {
  const ledger = ledgerWithUsage();
  const result = verifyAnswer({
    ledger, answer: { claims: [{ text: 'He is the WR1 by usage.', cites: ['r1#0.name'] }] }
  });
  assert.equal(result.numbers_checked, 1);
  assert.equal(result.ok, false, 'WR1 contains a 1 that is in no cited cell');
});
