/*
 * THE FLAKY-TEST REGISTER (plan item 37), and the rules that keep it honest.
 *
 * test/flaky-register.json is the one list of tests that have failed somewhere they
 * should have passed. It exists because this project twice wrote a real defect down as
 * environmental: `Connection error.` read as a missing API key for weeks (PR #7 found a
 * mis-keyed mock.module), and route-deletion-impact test 6 recorded as "pre-existing,
 * not touched" in two TDD records while it was a macOS regex difference (item 37).
 *
 * So the register is strict about the one thing that matters: a test may only be
 * quarantined once its flakiness is PROVEN, with a named cause, an owner and a date to
 * look again. And quarantine is its own flag, GRIDIRON_QUARANTINE, off by default: with
 * it off every registered test still runs, so CI never gets greener by registering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegister, quarantine, validateRegister } from './helpers/quarantine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = (over = {}) => ({
  id: 'x', file: 'test/flaky-register.test.js', test: 't', symptom: 's',
  status: 'suspected', cause: '', owner: 'o', quarantined: false, review_by: '2026-10-10',
  evidence: 'e', ...over,
});

test('the committed register passes its own rules', () => {
  const reg = loadRegister();
  assert.ok(reg.entries.length >= 2, 'it starts with the two known cases');
  assert.deepEqual(validateRegister(reg, { root: ROOT }), []);
});

test('every entry names a file that exists and an owner', () => {
  const errs = validateRegister({ entries: [entry({ file: 'test/nope.test.js', owner: '' })] }, { root: ROOT });
  assert.ok(errs.some(e => /test\/nope\.test\.js does not exist/.test(e)), errs.join('\n'));
  assert.ok(errs.some(e => /no owner/.test(e)), errs.join('\n'));
});

test('only a PROVEN flake with a cause and a review date can be quarantined', () => {
  const suspected = validateRegister({ entries: [entry({ quarantined: true })] }, { root: ROOT });
  assert.ok(suspected.some(e => /quarantined but status is suspected/.test(e)), suspected.join('\n'));
  const noCause = validateRegister({ entries: [entry({ status: 'proven-flaky', quarantined: true, cause: '' })] }, { root: ROOT });
  assert.ok(noCause.some(e => /needs a cause/.test(e)), noCause.join('\n'));
  const noDate = validateRegister({ entries: [entry({ status: 'proven-flaky', quarantined: true, cause: 'port race', review_by: '' })] }, { root: ROOT });
  assert.ok(noDate.some(e => /review_by/.test(e)), noDate.join('\n'));
  assert.deepEqual(validateRegister({ entries: [entry({ status: 'proven-flaky', quarantined: true, cause: 'port race' })] }, { root: ROOT }), []);
});

test('"flake", "flaky" and "no API key" are not causes', () => {
  for (const cause of ['flake', 'flaky on CI', 'no API key', 'missing ANTHROPIC_API_KEY']) {
    const errs = validateRegister({ entries: [entry({ status: 'proven-flaky', cause })] }, { root: ROOT });
    assert.ok(errs.some(e => /not a cause/.test(e)), `${cause}: ${errs.join('\n')}`);
  }
});

test('ids are unique and statuses are from the list', () => {
  const errs = validateRegister({ entries: [entry(), entry({ status: 'meh' })] }, { root: ROOT });
  assert.ok(errs.some(e => /duplicate id x/.test(e)), errs.join('\n'));
  assert.ok(errs.some(e => /status meh/.test(e)), errs.join('\n'));
});

test('quarantine() skips nothing while GRIDIRON_QUARANTINE is off', () => {
  const reg = { entries: [entry({ status: 'proven-flaky', quarantined: true, cause: 'port race' })] };
  assert.deepEqual(quarantine('x', { register: reg, env: {} }), {});
  assert.deepEqual(quarantine('x', { register: reg, env: { GRIDIRON_QUARANTINE: '0' } }), {});
});

test('quarantine() skips a quarantined entry when the flag is on, and names its owner', () => {
  const reg = { entries: [entry({ status: 'proven-flaky', quarantined: true, cause: 'port race', owner: 'cloud 37' })] };
  const opt = quarantine('x', { register: reg, env: { GRIDIRON_QUARANTINE: '1' } });
  assert.match(opt.skip, /quarantined/);
  assert.match(opt.skip, /cloud 37/);
  assert.match(opt.skip, /port race/);
  // registered but not quarantined runs even with the flag on
  const running = { entries: [entry()] };
  assert.deepEqual(quarantine('x', { register: running, env: { GRIDIRON_QUARANTINE: '1' } }), {});
});

test('quarantine() of an unregistered id throws, so nothing is skipped off the books', () => {
  assert.throws(() => quarantine('nobody', { register: { entries: [] }, env: { GRIDIRON_QUARANTINE: '1' } }),
    /not in test\/flaky-register\.json/);
});

test('every quarantine() call in the suite names a registered id', () => {
  const ids = new Set(loadRegister().entries.map(e => e.id));
  const dir = path.join(ROOT, 'test');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f !== 'flaky-register.test.js')) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/\bquarantine\(\s*['"]([^'"]+)['"]/g))
      assert.ok(ids.has(m[1]), `test/${f} quarantines ${m[1]}, which is not in the register`);
  }
});
