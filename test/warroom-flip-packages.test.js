/**
 * FLIP-LEGS-2: the served flip legs carry the whole packages. #358 prices 2-for-1
 * legs, but give_a / get_b hold one id (the lead player). give_a_ids / get_b_ids
 * are the packages: typed in plans-schema.js, served by view.js#toEntry, and the
 * War Room FlipMap prints them whole ('X + Y'). Made-up ids and names only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));

const wr = await loadWarRoom();
const { default: FlipMap } = await wr.mod('FlipMap');
test.after(() => wr.cleanup());

const entryWithLegs = () => {
  const entry = structuredClone(FIXTURE.leagues.find(e => e.flip_map?.status === 'ok' && e.flip_map.value.some(f => f.legs)));
  assert.ok(entry, 'the producer fixture has a flip with legs');
  return entry;
};

test('schema: give_a_ids / get_b_ids are optional pid arrays', () => {
  const entry = entryWithLegs();
  assert.equal(validateLeague(entry).ok, true, 'the incumbent single-id legs still validate');
  const f = entry.flip_map.value.find(x => x.legs);
  const other = Object.keys(entry.names).find(id => id !== f.legs.give_a && id !== f.legs.get_b);
  f.legs.give_a_ids = [f.legs.give_a, other];
  f.legs.get_b_ids = [f.legs.get_b, other];
  assert.equal(validateLeague(entry).ok, true, JSON.stringify(validateLeague(entry).errors));
  const doc = structuredClone(FIXTURE);
  doc.leagues[doc.leagues.findIndex(e => e.league === entry.league)] = entry;
  assert.equal(validatePlans(doc).ok, true);

  const empty = structuredClone(entry);
  empty.flip_map.value.find(x => x.legs).legs.give_a_ids = [];
  assert.equal(validateLeague(empty).ok, false, 'an empty package is not a package');
  const notPid = structuredClone(entry);
  notPid.flip_map.value.find(x => x.legs).legs.get_b_ids = [{ id: 1 }];
  assert.equal(validateLeague(notPid).ok, false, 'package members are pids');
});

test('view: toEntry serves the planner packages when present, and not when absent', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  const ids = Object.keys(a.names()).slice(0, 5);
  const [player, g1, g2, b1, b2] = ids;
  const legs = { give_a: g1, get_b: b1, p1: 0.5, p2: 0.4, p_complete: 0.2, d2: 0.01, se2: 0.002, clears2: true };
  const top = [{ player, a: 3, b: 4, spread: 0.05, se: 0.01, clears: true, price_a: 100, price_b: 90 }];
  const served = withIds => {
    const realised = [{ player, a: 3, b: 4, legs: withIds ? { ...legs, give_a_ids: [Number(g1), Number(g2)], get_b_ids: [b1, b2] } : legs }];
    const entry = toEntry({ ...res, flip: { ...res.flip, top, realised, pairs: 1 } }, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
    assert.deepEqual(validateLeague(entry).errors, []);
    return entry.flip_map.value[0].legs;
  };
  const on = served(true);
  assert.deepEqual(on.give_a_ids, [g1, g2]);
  assert.deepEqual(on.get_b_ids, [b1, b2]);
  assert.equal(on.give_a, g1, 'give_a stays the lead id');
  const off = served(false);
  assert.equal('give_a_ids' in off, false, 'flag off: no package keys');
  assert.equal('get_b_ids' in off, false);
});

test('FlipMap renders both players of a 2-player leg', () => {
  const p = v => ({ status: 'ok', value: v, source: 'clone.accept', unit: 'probability', guess: true });
  const gap = { status: 'ok', value: 0.05, source: 'sim.title', se: 0.01, clears_2se: true, unit: 'title_odds' };
  const price = { status: 'ok', value: 100, source: 'clone.price', unit: 'market_value' };
  const names = { 1: 'Player 1 (WR)', 11: 'Player 11 (RB)', 12: 'Player 12 (TE)', 21: 'Player 21 (QB)', 22: 'Player 22 (K)' };
  const flip = {
    player: '1', buy_from: '3', sell_to: '4', spread: gap, price_a: price, price_b: price,
    legs: { give_a: '11', get_b: '21', give_a_ids: ['11', '12'], get_b_ids: ['21', '22'], p1: p(0.5), p2: p(0.4), p_both: p(0.2), nick_after: { status: 'ok', value: 0.01, source: 'sim.title', unit: 'title_odds' } },
  };
  for (const big of [true, false]) {
    const text = textOf(renderToStaticMarkup(React.createElement(FlipMap, { field: { status: 'ok', value: [flip], source: 'sim.title' }, names, big })));
    assert.match(text, /give Player 11 \(RB\) \+ Player 12 \(TE\)/, `big=${big}: the whole give package`);
    assert.match(text, /get Player 21 \(QB\) \+ Player 22 \(K\)/, `big=${big}: the whole get package`);
  }
  // No package ids (flag off): the one served id, never a made-up partner.
  const single = structuredClone(flip);
  delete single.legs.give_a_ids; delete single.legs.get_b_ids;
  const text = textOf(renderToStaticMarkup(React.createElement(FlipMap, { field: { status: 'ok', value: [single], source: 'sim.title' }, names, big: false })));
  assert.match(text, /give Player 11 \(RB\) → get Player 21 \(QB\)/);
  assert.doesNotMatch(text, /Player 12|Player 22/);
});

test('Coach plan_read names every player of a served package', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { WARROOM_PLANS_ENV } = await import('../server/services/warroom-flag.js');
  const { planRead } = await import('../server/services/coach/brain-tools.js');
  const doc = structuredClone(FIXTURE);
  const entry = doc.leagues.find(e => e.flip_map?.status === 'ok' && e.flip_map.value.some(f => f.legs));
  // Only the legged flip, so the section fits the column budget.
  entry.flip_map.value = entry.flip_map.value.filter(f => f.legs).slice(0, 1);
  const f = entry.flip_map.value[0];
  const [g2, b2] = Object.keys(entry.names).filter(id => id !== f.legs.give_a && id !== f.legs.get_b);
  f.legs.give_a_ids = [f.legs.give_a, g2];
  f.legs.get_b_ids = [f.legs.get_b, b2];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-packages-'));
  const file = path.join(dir, 'plans.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  const was = process.env[WARROOM_PLANS_ENV];
  process.env[WARROOM_PLANS_ENV] = file;
  try {
    const [row] = planRead({ league_id: entry.league, section: 'flip_map' });
    const cols = Object.entries(row).filter(([k]) => /legs_(give_a|get_b)_ids_\d+_name$/.test(k)).map(([, v]) => v);
    assert.deepEqual(cols.sort(), [entry.names[f.legs.give_a], entry.names[g2], entry.names[f.legs.get_b], entry.names[b2]].sort());
  } finally {
    if (was === undefined) delete process.env[WARROOM_PLANS_ENV]; else process.env[WARROOM_PLANS_ENV] = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
