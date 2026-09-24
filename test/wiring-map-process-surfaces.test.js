/**
 * Processes are surfaces (RULINGS 9, FIX-279-1).
 *
 * The refresh loop and the engine daemon are long-running processes of their own;
 * the web server never runs producers. The map used to count only routes, scheduler
 * jobs and pages as served, so everything those processes run (the campaign producer
 * the loop launches, the daemon's producers) was reported as reaching no surface and
 * had to be hand-listed as an accepted orphan. These pin the rule in the checker:
 * the two roots are process surfaces, a script they launch by path is one too, a
 * dynamic import inside a process is real reach, and a table a process writes is
 * not "hand-fed".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { build, findings, annotations } = await import('../scripts/wiring-map.mjs');
const model = build();
const { surfaces, reach } = model;
const processes = new Set(surfaces.filter(s => s.kind === 'process').map(s => s.file));

test('the refresh loop and the engine daemon are process surfaces', () => {
  for (const f of ['scripts/refresh-live-data.mjs', 'scripts/engine-daemon.mjs']) {
    assert.ok(processes.has(f), `${f} is not a process surface; processes: ${[...processes].join(', ')}`);
  }
});

test("a script the loop launches by path is a process too (warroom_plans -> produce-plans.mjs)", () => {
  assert.ok(processes.has('scripts/campaign/produce-plans.mjs'));
  assert.ok(processes.has('scripts/eval/run-graders.mjs'));
});

test('a path named only in a comment does not make a process', () => {
  // start-all.mjs names the loop and the daemon in its header comment AND in code;
  // it is the supervisor, not a root, and nothing launches it by path.
  assert.ok(!processes.has('scripts/start-all.mjs'));
});

test("modules the producer imports dynamically are reached by a process, so they are served", () => {
  for (const f of ['server/services/campaign/planner.js', 'server/services/campaign/paths.js',
    'server/services/campaign/view.js']) {
    assert.ok(reach.get(f)?.has('process'), `${f} is not reached by any process`);
  }
});

test('the daemon reaches its producers, so engine tables are not reported as hand-fed', () => {
  assert.ok(reach.get('server/services/engine/daemon/tick.js')?.has('process'));
  const found = findings(model, annotations('docs/wiring/annotations.json'));
  const handFed = found.filter(f => f.rule === 'table-hand-fed' && /^engine_/.test(f.subject)).map(f => f.subject);
  assert.deepEqual(handFed, [], `engine tables reported as hand-fed: ${handFed.join(', ')}`);
  // plans-schema.js (#238) is excluded: nothing the producer runs imports it until FIX-03,
  // so it is still an accepted orphan, honestly.
  const campaign = found.filter(f => f.rule === 'module-reaches-no-surface' && f.subject.startsWith('server/services/campaign/')
    && f.subject !== 'server/services/campaign/plans-schema.js');
  assert.deepEqual(campaign.map(f => f.subject), []);
});
