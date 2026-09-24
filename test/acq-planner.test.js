/**
 * ACQ-01: the "go get player X" planner as a producer.
 *
 * Pure planner + contract on a made-up four-team league (test/fixtures/acq-league.mjs),
 * and the producer's default-off switch. The real-league run is a LOCAL step in the PR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { screenFair, fairBand, onesInBand, pairsInBand, SCREEN_WINDOW } = await import('../server/services/acq/value-band.js');
const { planAcquisition, pathExpectation, backupFor, oneForOneOnly, CLAIM_PARTNER } = await import('../server/services/acq/planner.js');
const { leagueEntry, plansDoc, moveId } = await import('../server/services/acq/contract.js');
const { validatePlans, validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter, players, nameOf } = await import('./fixtures/acq-league.mjs');
const { summary, parseArgs } = await import('../scripts/acq/produce-acq-plans.mjs');

const name = nameOf(players());
const sum = (A, ids) => ids.reduce((s, id) => s + A.value(id), 0);

/* --------------------------------------------------------- value band */

test('pairsInBand returns exactly the pairs a brute force finds, each once', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 25; trial++) {
    const items = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, value: Math.round(rnd() * 3000) }));
    const band = fairBand(500 + rnd() * 4000);
    const brute = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const s = items[i].value + items[j].value;
      if (items[i].value > 0 && items[j].value > 0 && s >= band.lo && s <= band.hi) brute.push([items[i].id, items[j].id].sort((a, b) => a - b).join());
    }
    const got = pairsInBand(items, band).map(p => [...p].sort((a, b) => a - b).join());
    assert.deepEqual([...got].sort(), [...brute].sort(), `trial ${trial}`);
    assert.equal(new Set(got).size, got.length, 'no pair twice');
  }
});

test('every pair and single in band reads screen-fair on his side; the cap keeps the centre', () => {
  const items = [1000, 1500, 1800, 2000, 2100, 2600, 3000].map((value, i) => ({ id: i + 1, value }));
  const V = 4000, band = fairBand(V);
  const val = id => items.find(x => x.id === id).value;
  for (const p of pairsInBand(items, band)) assert.ok(screenFair(val(p[0]) + val(p[1]), V));
  for (const [id] of onesInBand(items, fairBand(2000))) assert.ok(screenFair(val(id), 2000));
  const capped = pairsInBand(items, band, { limit: 2 });
  const mid = (band.lo + band.hi) / 2;
  const dist = p => Math.abs(val(p[0]) + val(p[1]) - mid);
  const all = pairsInBand(items, band).map(dist).sort((a, b) => a - b);
  assert.deepEqual(capped.map(dist).sort((a, b) => a - b), all.slice(0, 2));
  assert.deepEqual(SCREEN_WINDOW, { low: -12, high: 18 });
  assert.equal(fairBand(0), null);
});

/* ------------------------------------------------------------ planner */

test('IDEA-038: the star no single piece reaches is reached by a value-band 2-for-1, and the summary counts the miss', () => {
  const A = makeAdapter();
  const with2 = planAcquisition(A, { target: 11 });
  const only1 = planAcquisition(makeAdapter(), { target: 11, twoForOne: false });
  const t2 = with2.targets[0], t1 = only1.targets[0];
  assert.equal(t2.fair_direct['1-for-1'], 0, 'fixture: no screen-fair 1-for-1 for the star');
  assert.ok(t2.fair_direct['2-for-1'] > 0, 'value-band pairs exist');
  const direct2 = with2.plans.filter(p => p.depth === 1 && p.steps[0].shape === '2-for-1');
  assert.ok(direct2.length > 0, 'a direct 2-for-1 was scored');
  for (const p of direct2) assert.ok(screenFair(sum(A, p.steps[0].give), A.value(11)), 'each 2-for-1 is fair on his screen');
  assert.ok(t2.best && !t2.best.one_for_one_only, 'the best path has a two-player side');
  assert.equal(only1.plans.filter(p => p.depth === 1).length, 0, 'the 1-for-1 search has no direct path');
  assert.ok((t1.best?.expected ?? 0) < t2.best.expected, 'the 1-for-1 arm is worse on the same world');
  const s = with2.stats.two_for_one;
  assert.equal(s.targets, 1);
  assert.equal(s.missed_by_one_for_one, 1);
  assert.equal(s.rows[0].best_is_two, true);
});

test('the 1-for-1 arm is scored on its own, so the comparison is a measurement', () => {
  const r = planAcquisition(makeAdapter(), { target: 12 });
  const t = r.targets[0];
  assert.ok(t.best_one_for_one, 'a 1-for-1-only path to the QB was scored');
  assert.ok(oneForOneOnly(t.best_one_for_one.steps));
  const row = r.stats.two_for_one.rows[0];
  assert.equal(row.best_one_for_one, t.best_one_for_one.expected);
  assert.equal(row.gain, t.best_with_two.expected - t.best_one_for_one.expected);
});

test('the in-run 1-for-1 arm scores exactly what a 1-for-1-only search does, target by target', () => {
  // chipLimit 5, 2, 1: tight chip pools, where pair chips would crowd out 1-for-1 chips if pooled.
  for (const chipLimit of [150, 5, 2, 1]) for (const target of [12, 22, 31]) {
    const inRun = planAcquisition(makeAdapter(), { target, chipLimit }).targets[0].best_one_for_one;
    const alone = planAcquisition(makeAdapter(), { target, chipLimit, twoForOne: false }).targets[0].best;
    assert.equal(inRun?.expected, alone?.expected, `target ${target}, chipLimit ${chipLimit}`);
  }
  // The cap is per shape: with room for one chip, one 1-for-1 chip and one pair chip both survive.
  const one = planAcquisition(makeAdapter(), { target: 12, chipLimit: 1, claims: false });
  const chipShapes = new Set(one.plans.filter(p => p.depth === 2).map(p => p.steps[0].shape));
  assert.deepEqual([...chipShapes].sort(), ['1-for-1', '2-for-1']);
});

test('each step carries P(yes) from his side and the exact title-odds change of the state it leaves Nick in', () => {
  const A = makeAdapter();
  const r = planAcquisition(A, {});
  assert.ok(r.plans.length > 10);
  for (const p of r.plans) {
    let state = new Map();
    for (const s of p.steps) {
      assert.ok(s.p >= 0 && s.p <= 1);
      const me = [...(state.get('1') ?? A.roster('1'))].filter(x => !s.give.includes(x)).concat(s.get);
      state = new Map(state).set('1', me);
      if (s.kind === 'trade') state.set(s.partner, [...(state.get(s.partner) ?? A.roster(s.partner))].filter(x => !s.get.includes(x)).concat(s.give));
      assert.equal(s.delta, A.rescore(state).title_delta, 'delta = rescore of the cumulative state');
      if (s.kind === 'trade') assert.equal(s.p, A.pAccept(s.partner, s.get, s.give).p, 'P(yes) is his side: he gives what Nick gets');
    }
    assert.equal(p.expected, pathExpectation(p.steps).expected);
    assert.equal(p.steps.at(-1).get.includes(p.target), true, 'the path ends holding the target');
  }
});

test('pathExpectation strands a declined later step at the earlier state, not at today', () => {
  const e = pathExpectation([{ p: 0.5, delta: 0.02, se: 0.001 }, { p: 0.5, delta: 0.1, se: 0.001 }]);
  assert.equal(e.p_complete, 0.25);
  assert.ok(Math.abs(e.expected - (0.5 * 0 + 0.25 * 0.02 + 0.25 * 0.1)) < 1e-12);
  assert.ok(Math.abs(e.stranded - 0.25 * 0.02) < 1e-12);
  assert.equal(pathExpectation([{ p: 0.5, delta: 0.1 }], 0.03).expected, 0.5 * 0.03 + 0.5 * 0.1);
});

test('backup if he says no: another scored path to the same target that shares the steps before it', () => {
  const r = planAcquisition(makeAdapter(), {});
  assert.ok(r.deck.length >= 2);
  let seen = 0;
  for (const card of r.deck) {
    card.backups.forEach((b, i) => {
      if (!b) return;
      seen++;
      assert.equal(b.plan.target, card.target);
      assert.notDeepEqual([b.plan.steps[i].partner, b.plan.steps[i].give, b.plan.steps[i].get],
        [card.steps[i].partner, card.steps[i].give, card.steps[i].get], 'the backup is not the declined offer');
      for (let k = 0; k < i; k++) assert.deepEqual(b.plan.steps[k].give, card.steps[k].give, 'shares the steps before');
    });
  }
  assert.ok(seen > 0, 'at least one backup exists on the deck');
  const lone = { target: 99, steps: [{ kind: 'trade', partner: '2', give: [1], get: [99] }] };
  assert.equal(backupFor([lone], lone, 0), null);
});

test('claims and chips: a claim is a step inside a path, and a chained path passes a player through Nick', () => {
  const r = planAcquisition(makeAdapter(), {});
  const claims = r.plans.filter(p => p.steps.some(s => s.kind === 'claim'));
  assert.ok(claims.length > 0, 'a path with a claim was scored');
  for (const p of claims) {
    const c = p.steps.find(s => s.kind === 'claim');
    assert.equal(c.partner, CLAIM_PARTNER);
    assert.equal(c.basis, 'assumed');
  }
  assert.ok(r.plans.some(p => p.chained), 'a chained path was scored');
  const off = planAcquisition(makeAdapter(), { claims: false, chips: false });
  assert.ok(off.plans.every(p => p.depth === 1));
});

test('blocked owners and untouchables are respected', () => {
  const r = planAcquisition(makeAdapter({ blocked: new Set(['2']) }), {});
  assert.ok(r.targets.every(t => t.owner !== '2'));
  assert.ok(r.plans.every(p => p.steps.every(s => s.partner !== '2')));
  const u = planAcquisition(makeAdapter(), { target: 11, untouchables: [3] });
  assert.ok(u.plans.every(p => p.steps.every(s => !s.give.includes(3))));
  const named = planAcquisition(makeAdapter({ blocked: new Set(['2']) }), { target: 11 });
  assert.equal(named.targets[0].error, 'his owner does not trade');
});

test('the budget stops the search cleanly and says so', () => {
  const capped = planAcquisition(makeAdapter(), { maxRescores: 25 });
  assert.match(capped.stats.truncated, /rescore cap 25/);
  assert.ok(capped.stats.rescores <= 25);
  let t = 0;
  const timed = planAcquisition(makeAdapter({ clock: () => (t += 1000) }), { budgetMs: 30_000 });
  assert.match(timed.stats.truncated, /time budget 30000 ms/);
  const full = planAcquisition(makeAdapter(), {});
  assert.equal(full.stats.truncated, null);
});

test('same inputs, same plans', () => {
  const a = planAcquisition(makeAdapter(), {}), b = planAcquisition(makeAdapter(), {});
  const sig = r => JSON.stringify(r.deck.map(p => [p.target, p.expected, p.steps.map(s => [s.partner, s.give, s.get])]));
  assert.equal(sig(a), sig(b));
});

/* ----------------------------------------------------------- contract */

test('the league entry validates against the #238 contract and carries the deck, head, steps and targets', () => {
  const r = planAcquisition(makeAdapter(), {});
  const e = leagueEntry(r, { league: 4, me: '1', name });
  const v = validateLeague(e);
  assert.deepEqual(v.errors, []);
  assert.equal(e.alternatives.status, 'ok');
  assert.equal(e.alternatives.value.length, r.deck.length);
  assert.equal(e.next_move.value.move_id, e.alternatives.value[0].move_id);
  assert.equal(e.alternatives.value[0].move_id, moveId(r.deck[0], 0));
  const step = e.alternatives.value[0].steps[0];
  assert.ok(['ok', 'unknown'].includes(step.p_yes.status));
  assert.equal(step.title_odds_delta.status, 'ok');
  assert.equal(step.title_odds_delta.source, 'sim.title');
  assert.equal(step.reply_table.value.decline.status, 'ok');
  assert.equal(step.message.status, 'unknown', 'Coach writes messages, not ACQ-01');
  const trades = e.alternatives.value.flatMap(m => m.steps).filter(s => s.partner !== CLAIM_PARTNER);
  assert.ok(trades.every(s => s.p_yes.status === 'ok' && s.p_yes_band && s.p_yes_band.low <= s.p_yes.value && s.p_yes.value <= s.p_yes_band.high));
  const claims = e.alternatives.value.flatMap(m => m.steps).filter(s => s.partner === CLAIM_PARTNER);
  for (const c of claims) { assert.equal(c.p_yes.status, 'unknown'); assert.match(c.p_yes.reason, /assumed/); }
  assert.equal(e.targets.status, 'ok');
  assert.equal(e.targets.value.filter(t => t.is_plan_target).length, 1);
  assert.equal(e.flip_map.status, 'unknown');
  assert.match(e.flip_map.reason, /FLIP-01/);
  assert.equal(e.finder_best_expected.status, 'unknown');
  const doc = plansDoc([e]);
  assert.deepEqual(validatePlans(doc).errors, []);
  assert.equal(doc.producer, 'acq-01-planner');
});

test('a decline row names the backup card when the backup is on the deck', () => {
  const r = planAcquisition(makeAdapter(), {});
  const e = leagueEntry(r, { league: 4, me: '1', name });
  const ids = new Set(e.alternatives.value.map(m => m.move_id));
  const declines = e.alternatives.value.flatMap(m => m.steps.map(s => s.reply_table.value.decline.value));
  assert.ok(declines.every(d => typeof d.do === 'string' && d.do.length));
  for (const d of declines) if (d.move_id) assert.ok(ids.has(d.move_id));
});

test('finder baseline, empty and truncated runs are written honestly', () => {
  const r = planAcquisition(makeAdapter(), {});
  const e = leagueEntry(r, { league: 4, me: '1', name, finderBest: { expected: 0.01, se: 0.002 } });
  assert.equal(e.finder_best_expected.status, 'ok');
  assert.equal(e.finder_best_expected.value, 0.01);
  const empty = leagueEntry({ targets: [], plans: [], deck: [], stats: {} }, { league: 4, me: '1', name });
  assert.equal(empty.alternatives.status, 'unknown');
  assert.deepEqual(validateLeague(empty).errors, []);
  const cut = leagueEntry({ targets: [], plans: [], deck: [], stats: { truncated: 'single-player values: rescore cap 1 reached' } }, { league: 4, me: '1', name });
  assert.match(cut.alternatives.reason, /stopped early/);
  const bad = plansDoc([{ ...empty, names: {}, alternatives: { status: 'ok', value: 3, source: 'plan.path' } }]);
  assert.match(bad.leagues[0].error, /failed the contract/);
  assert.deepEqual(validatePlans(bad).errors, []);
});

/* ------------------------------------------------------------ producer */

test('default-off: without the preview switch the producer builds nothing', async () => {
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  const { produceAcq } = await import('../server/services/acq/produce.js');
  let built = 0;
  const adapterFactory = async () => { built++; return { adapter: makeAdapter(), meta: { league: 4, me: '1', name, as_of: null, runs: 1, sanity: true } }; };
  try {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    const off = await produceAcq(4, { adapterFactory });
    assert.equal(off.skipped, true);
    assert.equal(built, 0, 'no world built when off');
    assert.deepEqual(summary(off), { skipped: true, reason: off.reason });
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const on = await produceAcq(4, { adapterFactory });
    assert.equal(built, 1);
    assert.equal(on.preview, true);
    assert.match(on.preview_reason, /unfitted/);
    assert.deepEqual(validateLeague(on.entry).errors, []);
    const s = summary(on);
    assert.equal(s.league, 4);
    assert.equal(typeof s.idea_038.missed_by_one_for_one, 'number');
    assert.ok(!JSON.stringify(s).includes('P1 ('), 'the paste-safe summary carries no names');
  } finally {
    if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved;
  }
});

test('the CLI defaults to league 4 and refuses an unknown flag', () => {
  assert.deepEqual(parseArgs(['node', 'x']).leagues, [4]);
  assert.equal(parseArgs(['node', 'x', '--target', '11', '--finder']).target, 11);
  assert.throws(() => parseArgs(['node', 'x', '--bogus']), /unknown argument/);
});
