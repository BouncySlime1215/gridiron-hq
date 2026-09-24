/**
 * COACH-01a Step 0: the people gate, re-run on population tells with SEPARATE
 * windows and graded against outcomes (RL-18-3).
 *
 * The r18 critique ("the gate passes noise": 232 passes, precision 0.116)
 * compared overlapping cumulative windows, so it measured the overlap as much
 * as the gate. These pin the three things the rerun has to get right before
 * any number from it means anything:
 *
 *   1. the early and late windows of a team-season share no week and no
 *      event, including an event that straddles the cut;
 *   2. precision is reported next to the base rate, with a league-clustered
 *      bootstrap, and is only claimed when the interval clears the base rate;
 *   3. an outcome with no confirmed tell is "no replicated signal", never
 *      "predicts nothing".
 *
 * The fixtures are synthetic: cluster and unit ids are opaque numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-gate-rerun-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'app.sqlite');

const {
  WINDOW_MODES, teamSeasonWindows, splitEvents, emulateGate, templateLabels, gateRerun
} = await import('../server/services/coach/people/gate-rerun.js');

const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

test('70/30 per team-season: weeks 1-8 early, 9-12 late, nothing shared', () => {
  const w = teamSeasonWindows(WEEKS, WINDOW_MODES.PRIMARY);
  assert.deepEqual(w.early, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(w.late, [9, 10, 11, 12]);
  assert.equal(w.early.filter(x => w.late.includes(x)).length, 0);
});

test('sensitivity windows are weeks 1-5 vs 6-11, and week 12 is in neither', () => {
  const w = teamSeasonWindows(WEEKS, WINDOW_MODES.SENSITIVITY);
  assert.deepEqual(w.early, [1, 2, 3, 4, 5]);
  assert.deepEqual(w.late, [6, 7, 8, 9, 10, 11]);
});

test('a team-season missing weeks splits its own weeks, not the calendar', () => {
  // Ten weeks played: 70% is seven of them, whatever their numbers are.
  const w = teamSeasonWindows([1, 2, 3, 5, 6, 7, 8, 10, 11, 12], WINDOW_MODES.PRIMARY);
  assert.deepEqual(w.early, [1, 2, 3, 5, 6, 7, 8]);
  assert.deepEqual(w.late, [10, 11, 12]);
});

test('early and late windows share no event, and a straddling event goes to neither', () => {
  const windows = teamSeasonWindows(WEEKS, WINDOW_MODES.PRIMARY);
  const events = [
    { id: 'a', week: 2 },
    { id: 'b', week: 8 },
    { id: 'c', week: 9 },
    // A lineup change is measured against the week before: week 9's change
    // reads week 8's lineup, so it straddles the cut and belongs to neither.
    { id: 'straddle', from_week: 8, to_week: 9 },
    { id: 'inside', from_week: 10, to_week: 11 },
    { id: 'outside', week: 13 }
  ];
  const split = splitEvents(events, windows);
  const early = split.early.map(e => e.id);
  const late = split.late.map(e => e.id);
  assert.deepEqual(early, ['a', 'b']);
  assert.deepEqual(late, ['c', 'inside']);
  assert.deepEqual(split.straddling.map(e => e.id), ['straddle']);
  assert.equal(early.filter(id => late.includes(id)).length, 0, 'an event landed in both windows');
});

/**
 * Twenty league-seasons of ten team-seasons each. STABLE is the same number
 * in both windows for every unit (with a little noise), so the gate passes
 * it everywhere; NOISE is independent between windows, so it fails nearly
 * everywhere. Which of them the screen confirmed is set per test.
 */
function panel({ clusters = 20, units = 10, templates = { STABLE: 'stable', NOISE: 'noise' } } = {}) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = [];
  for (let c = 0; c < clusters; c++) {
    for (let u = 0; u < units; u++) {
      for (const [template, kind] of Object.entries(templates)) {
        const base = u + rnd() * 0.1;
        rows.push({ cluster: c, unit: `${c}-${u}`, template,
          early: kind === 'stable' ? base : rnd(),
          late: kind === 'stable' ? base + rnd() * 0.1 : rnd() });
      }
    }
  }
  return rows;
}

function screenOf(confirmed) {
  // One tell per (template, window, outcome), as the factory writes them.
  const tells = [];
  for (const template of ['STABLE', 'NOISE', 'OTHER_A', 'OTHER_B', 'OTHER_C']) {
    for (const outcome of ['adds', 'checkout', 'trade']) {
      const hit = confirmed.some(([t, o]) => t === template && o === outcome);
      tells.push({ arm: 'A', id: `${template}|w16`, outcome, verdict: hit ? 'confirmed' : 'dead',
        support_chains: 500 });
    }
  }
  return { tells };
}

test('the gate emulation grades each league-season on its own people', () => {
  const gate = emulateGate(panel());
  assert.equal(gate.get('STABLE').pass, true);
  assert.equal(gate.get('NOISE').pass, false);
  assert.equal(gate.get('STABLE').clusters_graded, 20);
});

test('a league-season with fewer than the minimum people is not graded', () => {
  const gate = emulateGate(panel({ units: 5 }));
  assert.equal(gate.get('STABLE').clusters_graded, 0);
  assert.equal(gate.get('STABLE').pass, false);
  assert.match(gate.get('STABLE').reason, /league-season|people/);
});

test('labels come from the screen, per outcome, by template', () => {
  const labels = templateLabels(screenOf([['STABLE', 'adds']]));
  assert.deepEqual([...labels.get('STABLE')], ['adds']);
  assert.equal(labels.get('NOISE').size, 0);
});

test('precision is reported next to the base rate, with recall and a clustered CI', () => {
  const report = gateRerun({ panel: panel(), screen: screenOf([['STABLE', 'adds']]), reps: 200 });
  const adds = report.outcomes.adds;
  // Two templates in the universe, one confirmed: the base rate is 1/2.
  assert.equal(adds.base_rate, 0.5);
  assert.equal(adds.passes, 1);
  assert.equal(adds.precision, 1);
  assert.equal(adds.recall, 1);
  assert.ok(Array.isArray(adds.ci90) && adds.ci90.length === 2);
  assert.equal(report.clusters, 20);
  assert.equal(report.bootstrap.unit, 'league-season');
});

test('precision is only claimed when the CI clears the base rate', () => {
  // STABLE passes and is NOT confirmed; NOISE fails and is. Precision 0 < base.
  const report = gateRerun({ panel: panel(), screen: screenOf([['NOISE', 'checkout']]), reps: 200 });
  const checkout = report.outcomes.checkout;
  assert.equal(checkout.precision, 0);
  assert.equal(checkout.beats_base, false);
  assert.equal(report.gate_claim, 'repeatability_only');
  assert.match(checkout.statement, /repeatab/i);
});

test('no confirmed trade tell reads "no replicated trade-next-week signal", never "predicts nothing"', () => {
  const report = gateRerun({ panel: panel(), screen: screenOf([['STABLE', 'adds']]), reps: 50 });
  const trade = report.outcomes.trade;
  assert.equal(trade.confirmed, 0);
  assert.equal(trade.precision, 0);
  assert.match(trade.statement, /no replicated trade-next-week signal/);
  for (const outcome of Object.values(report.outcomes)) {
    assert.doesNotMatch(outcome.statement, /predicts nothing/i);
  }
  assert.doesNotMatch(JSON.stringify(report), /predicts nothing/i);
});

test('the bootstrap is deterministic for a seed', () => {
  const a = gateRerun({ panel: panel(), screen: screenOf([['STABLE', 'adds']]), reps: 100, seed: 3 });
  const b = gateRerun({ panel: panel(), screen: screenOf([['STABLE', 'adds']]), reps: 100, seed: 3 });
  assert.deepEqual(a.outcomes, b.outcomes);
});

test('templates in the panel but not in the screen are outside the universe, and counted', () => {
  const report = gateRerun({
    panel: panel({ templates: { STABLE: 'stable', NOISE: 'noise', UNSCREENED: 'stable' } }),
    screen: screenOf([['STABLE', 'adds']]), reps: 50
  });
  assert.equal(report.templates, 2);
  assert.equal(report.templates_unscreened, 1);
});
