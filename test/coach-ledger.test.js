/**
 * The retrieval ledger: every row Coach looked at, and every number it worked
 * out from those rows, in one place with a name for each cell.
 *
 * This exists so the grounding check in verify.js has something to check
 * against. It also settles the arithmetic question. Nick asked Coach to "run
 * calculations quickly to sense check things", and a language model doing
 * arithmetic in prose is exactly where an ungrounded number comes from — the
 * inputs are real, the output is invented, and nothing downstream can tell.
 * So Coach does not do arithmetic: it either asks SQL for the aggregate, or it
 * calls a whitelisted operation here, which records the result as a cell of
 * its own with its formula and its inputs. Every number in an answer is then
 * either a row the database returned or a computation whose inputs are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { newLedger, LEDGER_OPS, LedgerError } = await import('../server/services/coach/ledger.js');

const queryResult = (rows, tables = ['player_week_usage'], provenance = {}) => ({
  sql: 'SELECT ...', params: [], tables, columns: Object.keys(rows[0] ?? {}),
  rows, row_count: rows.length, truncated: false, max_rows: 200, provenance
});

test('a recorded query gets an id, and each of its cells is addressable', () => {
  const ledger = newLedger();
  const entry = ledger.record(queryResult([
    { name: 'A Player', week: 3, target_share: 0.284 },
    { name: 'B Player', week: 3, target_share: 0.131 }
  ]));
  assert.equal(entry.id, 'r1');
  assert.deepEqual(ledger.cell('r1#0.target_share').value, 0.284);
  assert.deepEqual(ledger.cell('r1#1.name').value, 'B Player');
  assert.equal(ledger.cell('r1#0.week').value, 3);
});

test('ids are handed out in order, so a cite cannot point at the wrong query', () => {
  const ledger = newLedger();
  assert.equal(ledger.record(queryResult([{ a: 1 }])).id, 'r1');
  assert.equal(ledger.record(queryResult([{ a: 2 }])).id, 'r2');
  assert.equal(ledger.cell('r2#0.a').value, 2);
});

test('a cite that points at nothing resolves to null rather than to something nearby', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1 }]));
  for (const bad of ['r2#0.a', 'r1#5.a', 'r1#0.b', 'r1', 'r1#0', 'nonsense', '', null, 7]) {
    assert.equal(ledger.cell(bad), null, `${JSON.stringify(bad)} should not resolve`);
  }
});

test('a derived value records its operation, its inputs and its formula', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ targets: 30 }, { targets: 10 }]));
  const derived = ledger.derive({ op: 'sum', inputs: ['r1#0.targets', 'r1#1.targets'], label: 'total targets' });
  assert.equal(derived.id, 'd1');
  assert.equal(derived.value, 40);
  assert.equal(derived.op, 'sum');
  assert.deepEqual(derived.inputs, ['r1#0.targets', 'r1#1.targets']);
  assert.match(derived.formula, /sum/);
  assert.equal(ledger.cell('d1').value, 40);
});

test('every whitelisted operation computes what it says', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 30, b: 10 }]));
  const of = (op, inputs) => ledger.derive({ op, inputs, label: op }).value;
  assert.equal(of('sum', ['r1#0.a', 'r1#0.b']), 40);
  assert.equal(of('difference', ['r1#0.a', 'r1#0.b']), 20);
  assert.equal(of('product', ['r1#0.a', 'r1#0.b']), 300);
  assert.equal(of('quotient', ['r1#0.a', 'r1#0.b']), 3);
  assert.equal(of('mean', ['r1#0.a', 'r1#0.b']), 20);
  assert.equal(of('min', ['r1#0.a', 'r1#0.b']), 10);
  assert.equal(of('max', ['r1#0.a', 'r1#0.b']), 30);
  assert.equal(of('percent_of', ['r1#0.b', 'r1#0.a']), 100 / 3);
  assert.deepEqual(LEDGER_OPS.slice().sort(),
    ['difference', 'max', 'mean', 'min', 'percent_of', 'product', 'quotient', 'sum']);
});

test('an operation outside the whitelist is refused, not improvised', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1 }]));
  assert.throws(() => ledger.derive({ op: 'regress', inputs: ['r1#0.a'], label: 'x' }), LedgerError);
  assert.throws(() => ledger.derive({ op: 'eval', inputs: ['r1#0.a'], label: 'x' }), LedgerError);
});

test('a derivation whose input does not resolve fails loudly instead of skipping it', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1 }]));
  assert.throws(() => ledger.derive({ op: 'sum', inputs: ['r1#0.a', 'r9#0.a'], label: 'x' }), err => {
    assert.ok(err instanceof LedgerError);
    assert.match(err.message, /r9#0\.a/);
    return true;
  });
});

test('a derivation over a non-numeric cell fails, rather than producing NaN', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ name: 'A Player', a: 1 }]));
  assert.throws(() => ledger.derive({ op: 'sum', inputs: ['r1#0.name', 'r1#0.a'], label: 'x' }),
    /not a number/i);
});

test('dividing by zero is refused rather than returned as Infinity', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1, zero: 0 }]));
  assert.throws(() => ledger.derive({ op: 'quotient', inputs: ['r1#0.a', 'r1#0.zero'], label: 'x' }),
    LedgerError);
  assert.throws(() => ledger.derive({ op: 'percent_of', inputs: ['r1#0.a', 'r1#0.zero'], label: 'x' }),
    LedgerError);
});

test('a derived value can be the input to another, and the chain is readable', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 30, b: 10 }]));
  ledger.derive({ op: 'sum', inputs: ['r1#0.a', 'r1#0.b'], label: 'total' });
  const share = ledger.derive({ op: 'percent_of', inputs: ['r1#0.b', 'd1'], label: 'share' });
  assert.equal(share.id, 'd2');
  assert.equal(share.value, 25);
  assert.deepEqual(ledger.trace('d2').map(c => c.id), ['d2', 'r1#0.b', 'd1', 'r1#0.a', 'r1#0.b']);
});

test('the ledger reports which cited data is hand-collected, so an answer can show its age', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1 }], ['players'], { players: { collection: 'auto', freshness: 'roster sync' } }));
  ledger.record(queryResult([{ b: 2 }], ['scout_reports'],
    { scout_reports: { collection: 'by_hand', freshness: 'generated on demand' } }));
  assert.deepEqual(ledger.handCollected(['r1#0.a']), []);
  assert.deepEqual(ledger.handCollected(['r2#0.b']), ['scout_reports']);
  assert.deepEqual(ledger.handCollected(['r1#0.a', 'r2#0.b']), ['scout_reports']);
});

test('the ledger serialises to JSON with no Map or Set, so it can be shown to the user', () => {
  const ledger = newLedger();
  ledger.record(queryResult([{ a: 1 }]));
  ledger.derive({ op: 'sum', inputs: ['r1#0.a'], label: 'total' });
  const json = JSON.parse(JSON.stringify(ledger.toJson()));
  assert.equal(json.queries.length, 1);
  assert.equal(json.derived.length, 1);
  assert.equal(json.queries[0].id, 'r1');
  assert.equal(json.derived[0].value, 1);
});
