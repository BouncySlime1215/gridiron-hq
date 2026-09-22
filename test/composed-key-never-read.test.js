/**
 * A key computed into a composed record and read by nothing.
 *
 * The map could see modules, routes, tables and columns. It could not see a
 * KEY: a name that exists only as a property of an object this repository
 * builds. `payloadKeys` comes closest and deliberately stops short — its own
 * comment says keys written inline in a returned object literal "are
 * deliberately not flagged", because an API response is allowed to carry a
 * field nobody reads back; the reader is a person looking at JSON.
 *
 * That exemption is right for a response and wrong for a COMPONENT. When a
 * function's result is spread into another object (`...gameContext(...)`), it
 * is not something a person reads: it is machine input, assembled to be read
 * by name. If no name reads it, the computation is dead work that runs on
 * every call.
 *
 * WHAT THIS RULE MUST NOT DO, and the reason it exists in this shape. The
 * finding that prompted it was `opp_adj_def_epa`
 * (server/services/nfl-features.js:445), reported by hand as computed and
 * unreachable. It is NOT an instance of this rule: it is read, at
 * server/services/nfl-ai-replay.js:112, through `FEATURE_KEYS.filter(k =>
 * f[k] != null)` — a name list in a string array, indexed dynamically. A rule
 * that looks for `.opp_adj_def_epa` and finds nothing would call live code
 * dead, which is this project's most-repeated failure. The last test below is
 * that guard, and it runs against the real files rather than a fixture,
 * because a fixture would only prove that the fixture was written to pass.
 *
 * The reproduction targets, both found by hand first (grep, 2026-09-22):
 * `division_game` (server/services/nfl-spread-context.js:244, also :218 and
 * :355) and `flat_units`/`tiered_units` (server/services/staking.js:429-430).
 * Each is written more than once and read nowhere in the tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { scan, composedKeysNeverRead } = await import('../scripts/wiring-map.mjs');

const file = (path, tree, src) => {
  const { code, strings } = scan(src);
  return { path, tree, code, strings };
};
const keys = (rows) => rows.map((r) => r.key).sort();

test('a key returned by a spread-called function and read nowhere is reported', () => {
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { return { zz_dead_key: 1 }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
  ]);
  assert.deepEqual(keys(out), ['zz_dead_key']);
  assert.equal(out[0].fn, 'zzParts');
  assert.equal(out[0].site, 'server/services/zz.js:2');
});

test('a key read by member access anywhere in the tree is not reported', () => {
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { return { zz_live_key: 1 }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
    file('server/routes/zz.js', 'server', `
      import { zzVector } from '../services/zz.js';
      export const h = () => zzVector().zz_live_key;
    `),
  ]);
  assert.deepEqual(keys(out), []);
});

test('a key named only inside a string list counts as read', () => {
  // The opp_adj_def_epa shape, in miniature: the consumer never writes the key
  // as a property at all, it holds the name in an array and indexes with it.
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { return { zz_listed_key: 1 }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
    file('server/services/zz-consumer.js', 'server', `
      const KEYS = ['zz_listed_key'];
      export const slim = (f) => KEYS.filter((k) => f[k] != null);
    `),
  ]);
  assert.deepEqual(keys(out), []);
});

test('a function whose result is never spread is left alone', () => {
  // An API response may carry a field this repository never reads back. That
  // is payloadKeys' documented exemption and it still holds here.
  const out = composedKeysNeverRead([
    file('server/routes/zz.js', 'server', `
      function zzResponse() { return { zz_response_only: 1 }; }
      export const h = (req, res) => res.json(zzResponse());
    `),
  ]);
  assert.deepEqual(keys(out), []);
});

test('only the top level of the returned literal is examined', () => {
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { return { zz_outer: { zz_nested_key: 1 } }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
  ]);
  assert.deepEqual(keys(out), ['zz_outer']);
});

test('a shorthand property is out of scope and reported as such', () => {
  // `{ feature_games }` takes its value from a variable of the same name, so
  // the variable's own usage rules apply and this rule would double-count it.
  // Stated as a test so the limit is a decision on the record, not a gap.
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { const zz_shorthand = 1; return { zz_shorthand }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
  ]);
  assert.deepEqual(keys(out), []);
});

test('a key written at two return sites is reported once, at the first', () => {
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts(x) {
        if (!x) return { zz_twice_key: null };
        return { zz_twice_key: 1 };
      }
      export function zzVector() { return { ...zzParts(1) }; }
    `),
  ]);
  assert.deepEqual(keys(out), ['zz_twice_key']);
  assert.equal(out[0].site, 'server/services/zz.js:3');
  assert.deepEqual(out[0].sites, ['server/services/zz.js:3', 'server/services/zz.js:4']);
});

test('a test tree neither contributes findings nor counts as a reader', () => {
  const out = composedKeysNeverRead([
    file('server/services/zz.js', 'server', `
      function zzParts() { return { zz_test_only_read: 1 }; }
      export function zzVector() { return { ...zzParts() }; }
    `),
    file('test/zz.test.js', 'test', `
      import { zzVector } from '../server/services/zz.js';
      assert.equal(zzVector().zz_test_only_read, 1);
    `),
  ]);
  assert.deepEqual(keys(out), ['zz_test_only_read']);
});

test('the rule reproduces two findings made by hand on the real tree', async () => {
  const paths = [
    'server/services/nfl-spread-context.js',
    'server/services/staking.js',
  ];
  const files = await Promise.all(paths.map(async (p) =>
    file(p, 'server', await readFile(new URL(`../${p}`, import.meta.url), 'utf8'))));
  const out = composedKeysNeverRead(files);
  for (const k of ['division_game', 'home_implied_points', 'flat_units', 'tiered_units']) {
    assert.ok(keys(out).includes(k), `${k} should be reported`);
  }
});

test('opp_adj_def_epa is NOT reported: a name list is a reader', async () => {
  const paths = [
    'server/services/nfl-features.js',
    'server/services/nfl-ai-replay.js',
  ];
  const files = await Promise.all(paths.map(async (p) =>
    file(p, 'server', await readFile(new URL(`../${p}`, import.meta.url), 'utf8'))));
  const out = composedKeysNeverRead(files);
  assert.ok(!keys(out).includes('opp_adj_def_epa'),
    'opp_adj_def_epa is read at nfl-ai-replay.js:112 through FEATURE_KEYS');
});
