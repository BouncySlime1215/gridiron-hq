/**
 * RL-15-3: tagDeal() must read the DIRECTION of detectRoleChange()'s status
 * (role-changepoint.js:32), not its truthiness. A confirmed role decrease is a
 * caution, never "Buy Low"; a confirmed increase is "Role Rising".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-tag-role-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { tagDeal } = await import('../server/services/trade-engine.js');

// ev chosen so neither 'Fair & Clean' nor 'Value Win' fires.
const ev = { their_value_pct: 50, me: { ppg_delta: 0 } };
const player = (id, extra = {}) => ({ id, age: 26, injury: null, role_change: null, ...extra });
const role = status => ({ status, through_week: 3 });

test('control: no role change -> Straight Upgrade, no role tag', () => {
  assert.deepEqual(tagDeal([player(1)], [player(2)], ev), ['Straight Upgrade']);
});

test('confirmed_role_decrease is never "Buy Low" and carries a caution tag', () => {
  const tags = tagDeal([player(1)], [player(2, { role_change: role('confirmed_role_decrease') })], ev);
  assert.ok(!tags.includes('Buy Low'), `got ${JSON.stringify(tags)}`);
  assert.ok(tags.includes('Role Shrinking'), `got ${JSON.stringify(tags)}`);
});

test('confirmed_role_increase is "Role Rising", not "Buy Low"', () => {
  const tags = tagDeal([player(1)], [player(2, { role_change: role('confirmed_role_increase') })], ev);
  assert.ok(!tags.includes('Buy Low'), `got ${JSON.stringify(tags)}`);
  assert.ok(tags.includes('Role Rising'), `got ${JSON.stringify(tags)}`);
});

test('the caution survives the two-tag cap when other tags also fire', () => {
  // Blockbuster (4 players), Youth Play and Sell the Veteran all fire first.
  const give = [player(1, { age: 31 }), player(3, { age: 30 })];
  const get = [player(2, { age: 22, role_change: role('confirmed_role_decrease') }), player(4, { age: 25 })];
  const tags = tagDeal(give, get, ev);
  assert.equal(tags.length, 2);
  assert.ok(tags.includes('Role Shrinking'), `got ${JSON.stringify(tags)}`);
});

test('a role change on the GIVE side does not tag the deal', () => {
  const tags = tagDeal([player(1, { role_change: role('confirmed_role_decrease') })], [player(2)], ev);
  assert.deepEqual(tags, ['Straight Upgrade']);
});
