/**
 * HIS-SCREEN-FIX: his screen never builds the asset universe or runs the sim on the
 * request thread. The producer precomputes every deck move (his-screens.json next to
 * the plans file, one world per league); the route reads it. An off-deck offer runs
 * once in a worker thread and is cached per plan version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'his-screen-fix-'));
process.env.GRIDIRON_WARROOM_PLANS = path.join(dir, 'plans.json');

const {
  precomputeHisScreens, writeHisScreens, hisScreenFor, hisScreensPath, offerKey, deckOffers,
  readHisScreens, _resetHisScreenCache, HIS_SCREENS_SCHEMA,
} = await import('../server/services/campaign/his-screen.js');

const P = {
  1: { id: 1, name: 'Mine RB', position: 'RB', value: 1000 },
  2: { id: 2, name: 'Mine WR', position: 'WR', value: 400 },
  10: { id: 10, name: 'His WR1', position: 'WR', value: 1100 },
  11: { id: 11, name: 'His QB', position: 'QB', value: 700 },
  20: { id: 20, name: 'Other TE', position: 'TE', value: 500 },
};
const a = id => ({ ...P[id] });
const lg = { id: 4, my_team_id: 3, fetched_at: 't1', payload: JSON.stringify({ seasonId: 2026 }) };

function fakeSvc() {
  const calls = { universe: 0, world: 0, impact: 0, worldPassed: 0 };
  return {
    calls,
    svc: {
      engine: {
        assetUniverse: () => { calls.universe++; return new Map(); },
        loadRosters: () => [
          { roster_id: '3', players: [a(1), a(2)] },
          { roster_id: '7', players: [a(10), a(11)] },
          { roster_id: '8', players: [a(20)] },
        ],
      },
      format: { deriveFormat: () => ({ formatKey: 'x' }) },
      week: { leagueCurrentWeek: () => 3 },
      cp: {
        counterpartyLayer: () => new Map([['7', { needs: new Set(['RB']) }]]),
        readDeal: () => ({ their_perceived_give: 1100, their_perceived_get: 1050, perception_informed: true }),
        playerValuation: (_m, p) => ({ their_value: p.value, multiplier: 1, factors: [] }),
      },
      sim: {
        tradeImpactWorld: () => { calls.world++; return { key: {}, prep: {} }; },
        tradeImpact: (_lg, args) => {
          calls.impact++;
          if (args.world) calls.worldPassed++;
          return { them: { title_before: 0.2, title_after: 0.18, title_delta: -0.02, title_delta_se: 0.005 } };
        },
      },
    },
  };
}

const step = (partner, give, get) => ({ partner, give, get });
const plans = {
  generated_at: '2026-09-24T08:00:00.000Z',
  leagues: [
    { league: 4, alternatives: { status: 'ok', value: [
      { move_id: 'm1', steps: [step('7', ['1'], ['10'])] },
      { move_id: 'm2', steps: [step('7', ['2'], ['11']), step('8', ['10'], ['20'])] },
      { move_id: 'm3', steps: [step('7', ['1'], ['10'])] },
    ] } },
    { league: 5, error: 'planner failed' },
  ],
};

test('deckOffers lists every step of every deck move; offerKey is order-free', () => {
  const o = deckOffers(plans);
  assert.equal(o.length, 4);
  assert.deepEqual(o.map(x => `${x.move_id}.${x.step}`), ['m1.1', 'm2.1', 'm2.2', 'm3.1']);
  assert.equal(offerKey({ partner: 7, give: ['2', '1'], get: [10] }), offerKey({ partner: '7', give: [1, 2], get: ['10'] }));
});

test('precompute: every deck move covered, one universe and one sim world per league', async () => {
  const { svc, calls } = fakeSvc();
  const doc = await precomputeHisScreens(plans, { svc, leagueRow: () => lg });
  assert.equal(doc.schema, HIS_SCREENS_SCHEMA);
  assert.equal(doc.plans_generated_at, plans.generated_at);
  const l4 = doc.leagues['4'];
  assert.deepEqual(l4.coverage, { moves: 3, moves_covered: 3, steps: 4, steps_covered: 3 });
  assert.deepEqual(Object.keys(l4.moves).sort(), ['m1', 'm2', 'm3']);
  assert.equal(calls.universe, 1, 'asset universe built once for the league, not per offer');
  assert.equal(calls.world, 1, 'one paired sim world per league');
  assert.equal(calls.impact, 2, 'm3 repeats m1 (computed once); m2 step 2 is refused before the sim');
  assert.equal(calls.worldPassed, 2);
  // The step after a chained first step: player 10 is on his roster today, so it is Nick's future give;
  // the screen says so with a reason rather than inventing a roster.
  const k22 = offerKey(step('8', ['10'], ['20']));
  assert.match(l4.screens[k22].error, /not on your roster: 10/);
  assert.equal(doc.leagues['5'], undefined, 'a failed league has no deck');
});

test('writeHisScreens: off -> nothing written; on -> atomic file next to the plans file', async () => {
  const { svc } = fakeSvc();
  const file = hisScreensPath();
  assert.equal(path.dirname(file), dir);
  const off = await writeHisScreens(plans, { enabled: false, svc, leagueRow: () => lg, log: () => {} });
  assert.equal(off.status, 'off');
  assert.equal(fs.existsSync(file), false);
  const on = await writeHisScreens(plans, { enabled: true, svc, leagueRow: () => lg, log: () => {} });
  assert.equal(on.status, 'ok');
  assert.equal(on.moves_covered, 3);
  assert.equal(on.steps, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema, HIS_SCREENS_SCHEMA);
  const bad = await writeHisScreens(plans, { enabled: true, svc, leagueRow: () => { throw new Error('db gone'); }, log: () => {} });
  assert.equal(bad.status, 'ok', 'a league failure is kept in the file, the step does not throw');
});

test('route: a deck move is a read of the precomputed file (no compute, no sim)', async () => {
  _resetHisScreenCache();
  const { svc } = fakeSvc();
  await writeHisScreens(plans, { enabled: true, svc, leagueRow: () => lg, log: () => {} });
  const compute = () => { throw new Error('must not compute a deck move'); };
  const t0 = performance.now();
  const s = await hisScreenFor(lg, { partner: '7', give: ['1'], get: ['10'], enabled: true, compute });
  const ms = performance.now() - t0;
  assert.equal(s.enabled, true);
  assert.equal(s.fair.status, 'ok');
  assert.equal(s.title_odds.value.delta, -0.02);
  assert.equal(s.precomputed.plans_generated_at, plans.generated_at);
  assert.ok(ms < 200, `read took ${ms} ms`);
  const again = await readHisScreens();
  assert.equal(again, await readHisScreens(), 'parsed once per file version');
});

test('route: an off-deck offer computes once off the request thread, deduped and cached', async () => {
  _resetHisScreenCache();
  let runs = 0;
  const compute = async (id, offer) => { runs++; await new Promise(r => setTimeout(r, 20)); return { partner: offer.partner, computed_for: id }; };
  const args = { partner: '8', give: ['2'], get: ['20'], enabled: true, compute };
  const [x, y] = await Promise.all([hisScreenFor(lg, args), hisScreenFor(lg, args)]);
  assert.equal(runs, 1, 'two concurrent requests share one run');
  assert.equal(x.computed_off_thread, true);
  assert.equal(y.computed_for, 4);
  const z = await hisScreenFor(lg, args);
  assert.equal(runs, 1);
  assert.equal(z.cached, true);
  const failing = await hisScreenFor(lg, { ...args, get: ['99'], compute: async () => { throw new Error('boom'); } });
  assert.match(failing.error, /could not be computed: boom/);
});

test('route: flag off answers the reason without reading anything', async () => {
  const s = await hisScreenFor(lg, { partner: '7', give: ['1'], enabled: false, compute: () => { throw new Error('no'); } });
  assert.equal(s.enabled, false);
  assert.match(s.reason, /default-off/);
});

test('route: the real worker thread answers an unknown league with a sentence, and is reused', async () => {
  _resetHisScreenCache();
  const s = await hisScreenFor({ ...lg, id: 987654 }, { partner: '7', give: ['1'], get: ['10'], enabled: true });
  assert.equal(s.computed_off_thread, true);
  assert.match(s.error, /league missing or not synced/);
  const t0 = performance.now();
  const s2 = await hisScreenFor({ ...lg, id: 987655 }, { partner: '7', give: ['2'], enabled: true });
  assert.match(s2.error, /league missing or not synced/);
  assert.ok(performance.now() - t0 < 2000, 'second offer reuses the warm worker');
  _resetHisScreenCache();
});

/* ------------------------------------------------------------- the War Room renders it */
test('War Room: the deck card has a His screen toggle, and a precomputed screen renders', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadWarRoom, textOf } = await import('./helpers/warroom-tsx.mjs');
  const wr = await loadWarRoom();
  try {
    const { HisScreenView, HisScreenToggle, hisScreenPath } = await wr.mod('HisScreen');
    const { svc } = fakeSvc();
    const doc = await precomputeHisScreens(plans, { svc, leagueRow: () => lg });
    const screen = doc.leagues['4'].screens[offerKey(step('7', ['1'], ['10']))];
    const data = { enabled: true, league: 4, ...screen, precomputed: { as_of: doc.generated_at, plans_generated_at: doc.plans_generated_at } };
    const text = textOf(renderToStaticMarkup(React.createElement(HisScreenView, { data })));
    assert.match(text, /Team 7.s screen/);
    assert.match(text, /on his screen/i);
    assert.match(text, /His roster now/);
    assert.match(text, /After the offer/);
    assert.match(text, /He gives up His WR1/);
    assert.match(text, /20\.0% → 18\.0%/);
    assert.match(text, /Worked out by the planner/);
    const toggle = renderToStaticMarkup(React.createElement(HisScreenToggle, { leagueId: 4, offer: { partner: '7', give: ['1'], get: ['10'] } }));
    assert.match(textOf(toggle), /His screen/);
    assert.match(hisScreenPath(4, { partner: '7', give: ['1'], get: ['10'] }), /^\/trades\/4\/his-screen\?partner=7&give=1&get=10$/);
    // Mounted on the deck card, with the card's own offer (step 1).
    const producer = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/ui-contract-plans.json', import.meta.url), 'utf8'));
    const { buildWarRoomView } = await import('../server/services/war-room-view.js');
    const view = buildWarRoomView(1, { status: 'ok', entries: producer.leagues, as_of: producer.generated_at, id: 'plans@1',
      head: { schema: producer.schema, producer: producer.producer, producer_version: producer.producer_version } }, { enabled: true, preview: false });
    const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');
    const deckHtml = renderToStaticMarkup(React.createElement(NextMoveDeck, { view, big: true, post: async () => ({}) }));
    assert.match(deckHtml, /data-testid="his-screen-toggle"/);
  } finally { wr.cleanup(); }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
