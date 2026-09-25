/**
 * PLAN-BASELINE: the top strip's "title odds now -> this week's plan" and `ground_lost`
 * compare against a previous plan only when that plan was made under the SAME model.
 *
 * The producer stamps each run with a model key (producer version + model flags + a
 * hash of the title-odds code: sim, availability, adapter, planner). A previous
 * trajectory stamped with another key, or with none (a file written before the stamp),
 * is not compared with: the plan restarts at title_now (planned = actual at this week)
 * and ground_lost is typed unknown with the "model changed" reason. Same-model re-runs
 * still compare.
 *
 * Made-up league (test/fixtures/campaign-league.mjs); no DB, no names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-plan-baseline-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const producer = await import('../scripts/campaign/produce-plans.mjs');
const { buildPlansFile } = producer;
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });

const FIRST_AT = '2026-09-24T05:00:00.000Z';
const SECOND_AT = '2026-09-24T06:00:00.000Z';
const leagues = [{ id: 4, load: async () => { const a = makeAdapter(); a.league = { ...a.league, id: 4 }; return { adapter: a }; } }];
const OPTS = { objectives: {}, clock: () => 0 };

/**
 * Two refreshes. The first run's plan for this week is overwritten with `stalePlanned`
 * (the TITLE-ZERO shape: a plan made by a model that priced title odds at 0), so a
 * compare always has a nonzero gap to show. model1/model2: each run's model key.
 */
async function twoRuns({ model1, model2, stalePlanned = 0, stripModel = false }) {
  const first = await buildPlansFile(leagues, { ...OPTS, generated_at: FIRST_AT, model: model1 });
  const prev = structuredClone(first.leagues[0]);
  const w = prev._run.week;
  prev._run.trajectory = prev._run.trajectory.map(p => (p.week === w ? { ...p, planned: stalePlanned } : p));
  if (stripModel) delete prev._run.inputs.model;
  const second = await buildPlansFile(leagues, { ...OPTS, generated_at: SECOND_AT, model: model2,
    previous: new Map([['4', prev]]) });
  return { first, second, entry: second.leagues[0], w };
}

test('a previous plan from a different model is not compared with: the plan restarts at title_now', async () => {
  const { entry, second, w } = await twoRuns({ model1: 'm-old', model2: 'm-new' });
  const d = entry.destination.value;
  assert.equal(d.ground_lost.status, 'unknown', `ground_lost must not compare across models: ${JSON.stringify(d.ground_lost)}`);
  assert.match(d.ground_lost.reason, /plan restarted: the model changed/i);
  assert.equal(d.title_planned_now.status, 'ok');
  assert.equal(d.title_planned_now.value, d.title_now.value, 'a fresh trajectory starts at title_now');
  const here = d.path.value.find(p => p.week === w);
  assert.equal(here.planned, here.actual, 'planned = actual at this week');
  assert.equal(entry._run.inputs.model, 'm-new', 'the run is stamped with its own model');
  assert.equal(entry._run.trajectory.find(p => p.week === w).planned, d.title_now.value, 'the stored trajectory is the fresh one');
  assert.deepEqual(validatePlans(second).errors, []);
});

test('a previous plan with no model stamp (written before the stamp) also restarts', async () => {
  const { entry } = await twoRuns({ model1: 'm-1', model2: 'm-1', stripModel: true });
  const d = entry.destination.value;
  assert.equal(d.ground_lost.status, 'unknown');
  assert.match(d.ground_lost.reason, /plan restarted: the model changed/i);
  assert.equal(d.title_planned_now.value, d.title_now.value);
});

test('a same-model re-run still compares against the earlier plan', async () => {
  const { entry, second, w } = await twoRuns({ model1: 'm-1', model2: 'm-1', stalePlanned: 0 });
  const d = entry.destination.value;
  assert.equal(d.ground_lost.status, 'ok');
  assert.ok(d.ground_lost.value !== 0, 'the stale plan leaves a gap');
  assert.equal(d.ground_lost.value, 0 - d.title_now.value);
  assert.equal(d.title_planned_now.value, 0, 'this week\'s plan is the earlier run\'s');
  assert.equal(d.path.value.find(p => p.week === w).planned, 0);
  assert.equal(entry._run.trajectory.find(p => p.week === w).planned, 0, 'the earlier trajectory is kept');
  assert.equal(entry._run.inputs.model, 'm-1');
  assert.deepEqual(validatePlans(second).errors, []);
});

test('a restarted plan becomes the baseline the next same-model run compares with', async () => {
  const { second, w } = await twoRuns({ model1: 'm-old', model2: 'm-new' });
  const prev = structuredClone(second.leagues[0]);
  prev._run.trajectory = prev._run.trajectory.map(p => (p.week === w ? { ...p, planned: p.planned + 0.05 } : p));
  const third = await buildPlansFile(leagues, { ...OPTS, generated_at: SECOND_AT, model: 'm-new', previous: new Map([['4', prev]]) });
  const d = third.leagues[0].destination.value;
  assert.equal(d.ground_lost.status, 'ok');
  assert.ok(Math.abs(d.ground_lost.value - 0.05) < 1e-12, JSON.stringify(d.ground_lost));
});

test('with no model key on either side (tests, the contract fixture) the incumbent compare is unchanged', async () => {
  const { entry } = await twoRuns({ model1: undefined, model2: undefined });
  assert.equal(entry.destination.value.ground_lost.status, 'ok');
  assert.equal('model' in entry._run.inputs, false, 'no stamp is written without a key');
});

test('the model key changes when the title-odds code or a model flag changes', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'code-'));
  const a = path.join(dir, 'sim.js'), b = path.join(dir, 'avail.js');
  fs.writeFileSync(a, 'export const x = 1;'); fs.writeFileSync(b, 'export const y = 1;');
  const flags = { rl16_1: 'off', rl17_3: 'off', title_mutual: 'off', preview: 'off' };
  const k1 = producer.planModelKey({ flags, files: [a, b] });
  assert.equal(producer.planModelKey({ flags, files: [a, b] }), k1, 'stable');
  fs.writeFileSync(b, 'export const y = 2;');
  const k2 = producer.planModelKey({ flags, files: [a, b] });
  assert.notEqual(k2, k1, 'an availability code change is a new model');
  assert.notEqual(producer.planModelKey({ flags: { ...flags, preview: 'on' }, files: [a, b] }), k2, 'a flag change is a new model');
  assert.notEqual(producer.planModelKey({ flags, files: [a, path.join(dir, 'missing.js')] }), k2, 'a missing file is named, not skipped');
  for (const f of producer.PLAN_MODEL_FILES) assert.ok(fs.existsSync(f), `${f} exists in the repo`);
});

test('the top strip labels the comparison "vs this week\'s plan" and says when the plan restarted', async () => {
  const { default: TopStrip } = await wr.mod('TopStrip');
  const strip = entry => textOf(renderToStaticMarkup(React.createElement(TopStrip, {
    view: { destination: entry.destination }, leagues: [{ id: 4, name: 'League 4' }], activeId: 4,
    onLeague() {}, onExit() {}, theme: 'light', onTheme() {} })));
  const same = await twoRuns({ model1: 'm-1', model2: 'm-1' });
  assert.match(strip(same.entry), /→ plan 0\.0% [-−]?\d+\.\d pts vs this week's plan/);
  const changed = await twoRuns({ model1: 'm-old', model2: 'm-new' });
  const t = strip(changed.entry);
  assert.match(t, /plan restarted: the model changed/i);
  assert.doesNotMatch(t, /pts vs this week's plan/);
});
