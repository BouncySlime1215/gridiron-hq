/**
 * MSG-WIRE-2: with Coach messages on (GRIDIRON_COACH_MESSAGES / preview), every
 * step of every deck card carries its playbook (reply table, walk-away, send-when),
 * not only step 0; off, the producer output is the incumbent's byte for byte.
 * Made-up league in test/fixtures/campaign-league.mjs, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeProducerPlans } = await import('./fixtures/warroom-contract/make-producer-plans.mjs');

const AS_OF = '2026-09-24T00:00:00.000Z';
const FLAGS = ['GRIDIRON_COACH_MESSAGES', 'GRIDIRON_PREVIEW_UNCONFIRMED'];
const withEnv = (vals, fn) => {
  const saved = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, vals);
  try { return fn(); } finally {
    for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};
const run = (obj = {}) => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', ...obj }) });
  return { res, entry: toEntry(res, { names: a.names(), as_of: AS_OF }) };
};
const OBJECTIVES = [{}, { risk_mode: 'all_in' }];

test('flag off: the committed producer fixture is reproduced byte for byte', async () => {
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json'), 'utf8'));
  const doc = await withEnv({}, () => makeProducerPlans());
  assert.equal(JSON.stringify(doc), JSON.stringify(committed));
});

test('flag off: deck cards carry no per-step playbooks and later alternative steps keep the first-only reason', () => {
  withEnv({}, () => {
    for (const obj of OBJECTIVES) {
      const { res, entry } = run(obj);
      for (const c of res.deck) assert.equal('playbooks' in c, false);
      const later = (entry.alternatives.value ?? []).flatMap(m => m.steps.slice(1));
      assert.ok(later.length > 0, 'fixture has multi-step alternatives');
      assert.ok(later.some(s => s.reply_table.status === 'unknown'), 'some later step keeps the first-only reason');
    }
  });
});

for (const vals of [{ GRIDIRON_COACH_MESSAGES: '1' }, { GRIDIRON_PREVIEW_UNCONFIRMED: '1' }]) {
  test(`flag on (${Object.keys(vals)[0]}): every step of every card has a playbook and a reply table`, () => {
    withEnv(vals, () => {
      for (const obj of OBJECTIVES) {
        const { res, entry } = run(obj);
        for (const c of res.deck) {
          assert.equal(c.playbooks.length, c.plan.steps.length);
          c.playbooks.forEach((pb, i) => { assert.ok(pb, `step ${i}`); assert.equal(pb.step_index, i); });
          assert.equal(c.playbook, c.playbooks[0]);
        }
        assert.deepEqual(validateLeague(entry).errors, []);
        const moves = [entry.next_move.value, ...(entry.alternatives.value ?? [])].filter(Boolean);
        const later = moves.flatMap(m => m.steps.slice(1));
        assert.ok(later.length > 0);
        for (const s of moves.flatMap(m => m.steps)) assert.equal(s.reply_table.status, 'ok', JSON.stringify(obj));
      }
    });
  });
}

test('flag on changes only later steps: same move ids, same step-0 playbooks', () => {
  for (const obj of OBJECTIVES) {
    const off = withEnv({}, () => run(obj));
    const on = withEnv({ GRIDIRON_COACH_MESSAGES: '1' }, () => run(obj));
    assert.deepEqual(on.entry.alternatives.value.map(m => m.move_id), off.entry.alternatives.value.map(m => m.move_id));
    assert.equal(on.entry.next_move.value.move_id, off.entry.next_move.value.move_id);
    assert.deepEqual(on.res.deck.map(c => c.playbook), off.res.deck.map(c => c.playbook));
    on.entry.alternatives.value.forEach((m, j) =>
      assert.deepEqual(m.steps[0], off.entry.alternatives.value[j].steps[0]));
  }
});

test('flag on: a later step of an alternative card falls back to its own backup branch', () => {
  withEnv({ GRIDIRON_COACH_MESSAGES: '1' }, () => {
    const later = OBJECTIVES.flatMap(obj => run(obj).res.deck.slice(1).flatMap(c => c.playbooks.slice(1)));
    const declines = later.map(pb => pb.replies.find(r => r.kind === 'decline'));
    assert.ok(declines.length > 0);
    assert.ok(declines.some(r => r.next && /offer Team/.test(r.do)), 'some later step names a backup branch');
  });
});
