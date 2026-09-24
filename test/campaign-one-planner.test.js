/**
 * ONE-PLANNER: the campaign producer is the one planner.
 *   - ACQ-01's 2-for-1 / 1-for-2 search (PR #267) runs inside search.js#searchTarget,
 *     behind GRIDIRON_TWO_FOR_ONE (default off, on under preview mode).
 *   - FLIP-01's nightly / on-news schedule (PR #265) is produce-plans.mjs --tick;
 *     plans.json's flip_map is the only flip output.
 *   - The nick block: an unreachable manager is never a step, flip leg or target owner.
 * Made-up four-team league (test/fixtures/campaign-league.mjs); no DB, no simulation.
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
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const paths = await import('../server/services/campaign/paths.js');
const { newSearchStats, twoForOneSummary } = await import('../server/services/campaign/search.js');
const { buildPlansFile, twoForOneFlag, decideRun, TWO_FOR_ONE_ENV, NIGHTLY_MINUTES, NEWS_GAP_MINUTES, newsHitsSince } =
  await import('../scripts/campaign/produce-plans.mjs');

const AS_OF = '2026-09-24T00:00:00.000Z';
const UNREACHABLE = { nick: { unreachable: true, contactable: false } };
const produce = async (twoForOne, { objectives = {}, adapterOpts = {} } = {}) => {
  const a = makeAdapter(adapterOpts);
  const file = await buildPlansFile([{ id: 99, load: async () => ({ adapter: a }) }],
    { generated_at: AS_OF, clock: () => 0, twoForOne, objectives });
  return { a, file, entry: file.leagues[0] };
};
const stepsOf = entry => {
  const out = [];
  const walk = x => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.partner != null && Array.isArray(x.give) && Array.isArray(x.get)) out.push(x);
    Object.values(x).forEach(walk);
  };
  walk([entry.next_move, entry.alternatives, entry.risk_modes]);
  return out;
};

test('value bands: pairsInBand finds exactly the screen-fair pairs combos() would, each once', () => {
  const items = [[1, 3000], [2, 2600], [3, 2200], [4, 1400], [5, 1500], [6, 1500], [7, 1300]].map(([id, value]) => ({ id, value }));
  const val = new Map(items.map(x => [x.id, x.value]));
  for (const target of [4200, 2600, 5000, 900]) {
    const band = paths.fairBand(target);
    const got = paths.pairsInBand(items, band).map(p => [...p].sort().join('+')).sort();
    const want = paths.combos(items.map(x => x.id), 2).filter(g => g.length === 2)
      .filter(g => paths.screenFair(g.reduce((s, id) => s + val.get(id), 0), target)).map(g => [...g].sort().join('+')).sort();
    assert.deepEqual(got, want, `target ${target}`);
    const ones = paths.onesInBand(items, band).map(g => g[0]).sort();
    assert.deepEqual(ones, items.filter(x => paths.screenFair(x.value, target)).map(x => x.id).sort());
  }
  assert.equal(paths.fairBand(0), null);
  assert.equal(paths.pairsInBand(items, paths.fairBand(4200), { limit: 2 }).length, 2);
  assert.equal(paths.shapeOf({ give: [1, 2], get: [3] }), '2-for-1');
  assert.equal(paths.oneForOneOnly([{ give: [1], get: [3] }, { give: [2], get: [4, 5] }]), false);
});

test('flag off: the incumbent search is unchanged (same plans with or without the stats sink)', () => {
  const objective = normaliseObjective({ risk_mode: 'balanced' });
  const bare = planLeague(makeAdapter(), { objective });
  const a = makeAdapter();
  a.searchOpts = { twoForOne: false };
  a.searchStats = newSearchStats(false);
  const counted = planLeague(a, { objective });
  for (const k of ['best', 'deck', 'flip', 'targets', 'suggestions', 'candidates_scored']) {
    assert.deepEqual(counted[k], bare[k], k);
  }
  assert.equal(a.searchStats.two_for_one_on, false);
  assert.ok(Object.values(a.searchStats.screened).reduce((s, n) => s + n, 0) > 0, 'screens are counted with the flag off too');
});

test('flag on: 2-for-1 and 1-for-2 candidates are screened inside the producer, the file validates', async () => {
  const { entry, file } = await produce('on');
  assert.deepEqual(validatePlans(file).errors, []);
  assert.equal(file.leagues.length, 1);
  const tf = entry._run.inputs.two_for_one;
  assert.equal(tf.flag, 'on');
  assert.equal(tf.on, true);
  assert.ok(tf.two_for_one_screened > 0, `2-for-1 screened ${tf.two_for_one_screened}`);
  assert.ok((tf.screened['1-for-2'] ?? 0) > 0, '1-for-2 (target plus a filler) screened');
  assert.ok((tf.shortlisted.one_for_one_only ?? 0) > 0, 'the 1-for-1 arm keeps its own shortlist');
  assert.ok((tf.shortlisted.two_side ?? 0) > 0, 'the two-player arm is exact-scored');
  assert.ok(tf.targets > 0 && tf.rows.every(r => typeof r.best_is_two === 'boolean'));
});

test('flag on vs off: the off run keeps its 1-for-1 arm; the on run scores at least as many plans', async () => {
  const off = await produce('off'), on = await produce('on');
  assert.equal('two_for_one' in off.entry._run.inputs, false, 'off: the incumbent entry, no 2-for-1 bookkeeping');
  assert.equal('trigger' in off.entry._run.inputs, false);
  assert.ok(on.entry._run.candidates_scored >= off.entry._run.candidates_scored);
  assert.deepEqual(validatePlans(off.file).errors, []);
});

test('nick block: an unreachable manager is never a step, flip leg or target owner (flag on and off)', async () => {
  for (const flag of ['off', 'on']) {
    for (const objectives of [{}, { 99: { kind: 'player', target: '21' } }]) {
      const { entry, file } = await produce(flag, { objectives, adapterOpts: { managerExtra: { 3: UNREACHABLE } } });
      assert.deepEqual(validatePlans(file).errors, [], flag);
      assert.ok(!entry.error, entry.error);
      for (const s of stepsOf(entry)) assert.notEqual(String(s.partner), '3', `${flag}: step with the unreachable manager`);
      for (const f of entry.flip_map.value ?? []) {
        assert.notEqual(f.buy_from, '3'); assert.notEqual(f.sell_to, '3');
      }
      for (const t of entry.targets.value ?? []) assert.notEqual(t.owner, '3');
      for (const r of entry._run.inputs.two_for_one?.rows ?? []) assert.notEqual(r.owner, '3');
    }
  }
});

test('the flag: default off, GRIDIRON_TWO_FOR_ONE=1 on, preview mode turns it on', () => {
  const saved = { two: process.env[TWO_FOR_ONE_ENV], prev: process.env[PREVIEW_ENV] };
  try {
    delete process.env[TWO_FOR_ONE_ENV]; delete process.env[PREVIEW_ENV];
    assert.equal(twoForOneFlag(), 'off');
    process.env[TWO_FOR_ONE_ENV] = '1';
    assert.equal(twoForOneFlag(), 'on');
    delete process.env[TWO_FOR_ONE_ENV];
    process.env[PREVIEW_ENV] = '1';
    assert.equal(twoForOneFlag(), 'preview');
  } finally {
    for (const [k, v] of [[TWO_FOR_ONE_ENV, saved.two], [PREVIEW_ENV, saved.prev]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('FLIP-01 schedule as the producer runner: nightly, news (gapped), skip', () => {
  const now = Date.parse(AS_OF);
  const ago = min => new Date(now - min * 60_000).toISOString();
  assert.deepEqual(decideRun({ lastAt: null, now }), { run: true, trigger: 'nightly' });
  assert.deepEqual(decideRun({ lastAt: ago(NIGHTLY_MINUTES + 1), now }), { run: true, trigger: 'nightly' });
  assert.deepEqual(decideRun({ lastAt: ago(NEWS_GAP_MINUTES + 1), now, newsHits: 2 }), { run: true, trigger: 'news' });
  assert.equal(decideRun({ lastAt: ago(10), now, newsHits: 2 }).run, false);
  assert.equal(decideRun({ lastAt: ago(120), now }).run, false);
  assert.deepEqual(decideRun({ lastAt: ago(1), now, force: true }), { run: true, trigger: 'manual' });
  const payload = { teams: [{ roster: { entries: [{ playerPoolEntry: { player: { fullName: 'Made Up' } } }] } }] };
  const db = {
    row: () => ({ payload: JSON.stringify(payload) }),
    rows: () => [{ player_name: 'Made Up' }, { player_name: 'Someone Else' }],
  };
  assert.equal(newsHitsSince(db, [99], ago(5), s => String(s ?? '').toLowerCase()), 1);
});

test('one planner, one output: the producer writes plans.json only (no acq or flip file)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/campaign/produce-plans.mjs'), 'utf8');
  assert.equal((src.match(/fs\.writeFileSync\(/g) ?? []).length, 2, 'the tmp plans file and the lock');
  assert.equal((src.match(/fs\.renameSync\(/g) ?? []).length, 1, 'one rename, onto plansPath()');
  assert.doesNotMatch(src, /GRIDIRON_ACQ_PLANS|flip_map_snapshots/);
  const s = newSearchStats(true);
  assert.deepEqual(twoForOneSummary(s).two_for_one_screened, 0);
  assert.equal(twoForOneSummary(null), null);
});
