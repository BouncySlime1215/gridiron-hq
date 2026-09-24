/**
 * HIS-SCREEN: an offer as the partner sees it. Pure core on fixtures, the
 * DB wrapper on an injected service bundle, and the flag (site flag + preview).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildHisScreen, fairBadge, titleField, hisScreenFor, hisScreenGate, HIS_SCREEN_ENV, HIS_SCREEN_OFF_REASON,
} = await import('../server/services/campaign/his-screen.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { SCREEN_WINDOW } = await import('../server/services/campaign/paths.js');

const players = new Map([
  ['1', { id: 1, name: 'Mine RB', position: 'RB', value: 1000, ros_ppg: 14.2 }],
  ['2', { id: 2, name: 'Mine WR', position: 'WR', value: 400, ros_ppg: 9 }],
  ['10', { id: 10, name: 'His WR1', position: 'WR', value: 1100, ros_ppg: 16 }],
  ['11', { id: 11, name: 'His QB', position: 'QB', value: 700 }],
  ['12', { id: 12, name: 'His RB', position: 'RB', value: 300 }],
]);
const offer = { partner: '7', give: ['1'], get: ['10'] };
const hisRoster = [10, 11, 12];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('roster before/after: what leaves, what arrives, counts, and a filled need', () => {
  const s = buildHisScreen({ offer, hisRoster, players,
    clone: { deal: { their_perceived_give: 1100, their_perceived_get: 1000, perception_informed: false }, perPlayer: new Map(), needs: ['RB'] } });
  assert.deepEqual(s.roster.before.map(r => [r.id, r.move ?? null]), [['11', null], ['12', null], ['10', 'leaves']]);
  assert.deepEqual(s.roster.after.map(r => [r.id, r.move ?? null]), [['11', null], ['1', 'arrives'], ['12', null]]);
  assert.deepEqual(s.roster.counts_before, { QB: 1, RB: 1, WR: 1 });
  assert.deepEqual(s.roster.counts_after, { QB: 1, RB: 2 });
  assert.deepEqual(s.gives_up.map(r => r.id), ['10']);
  assert.equal(s.gets[0].fills_need, true);
});

test('value view and fair badge come from his clone, not our market values', () => {
  // Market: he gets 1000 for 1100 = -9% (inside the window). His clone rates his WR up: 1300 -> -23%, short.
  const s = buildHisScreen({ offer, hisRoster, players, clone: {
    deal: { their_perceived_give: 1300, their_perceived_get: 1000, perception_informed: true },
    perPlayer: new Map([['10', { their_value: 1300, multiplier: 1.18, factors: [{ why: 'he rates him' }] }]]) } });
  assert.equal(Math.round(s.market.pct), -9);
  assert.equal(s.value_view.status, 'ok');
  assert.equal(Math.round(s.value_view.value.pct), -23);
  assert.equal(s.value_view.value.informed, true);
  assert.equal(s.fair.status, 'ok');
  assert.equal(s.fair.value.verdict, 'short');
  assert.equal(s.fair.source, 'clone.price');
  const wr = s.gives_up[0];
  assert.equal(wr.value_ours, 1100);
  assert.equal(wr.value_his.value, 1300);
  assert.deepEqual(wr.reasons, ['he rates him']);
});

test('no clone: the badge is unknown with a reason, never a market badge', () => {
  const s = buildHisScreen({ offer, hisRoster, players, clone: null });
  assert.equal(s.fair.status, 'unknown');
  assert.match(s.fair.reason, /No clone/);
  assert.equal(s.value_view.status, 'unknown');
  assert.equal(s.gives_up[0].value_his.status, 'unknown');
  assert.equal(Math.round(s.market.pct), -9, 'market % is still shown, labelled market');
});

test('fairBadge window edges', () => {
  assert.equal(fairBadge(SCREEN_WINDOW.low).value.verdict, 'fair');
  assert.equal(fairBadge(SCREEN_WINDOW.high).value.verdict, 'fair');
  assert.equal(fairBadge(SCREEN_WINDOW.low - 0.1).value.verdict, 'short');
  assert.equal(fairBadge(SCREEN_WINDOW.high + 0.1).value.verdict, 'rich');
  assert.equal(fairBadge(null).status, 'unknown');
});

test('his title-odds change: typed, with SE and the 2-SE check; failures are sentences', () => {
  const f = titleField({ them: { title_before: 0.10, title_after: 0.13, title_delta: 0.03, title_delta_se: 0.01 } });
  assert.deepEqual(f.value, { before: 0.10, after: 0.13, delta: 0.03 });
  assert.equal(f.se, 0.01);
  assert.equal(f.clears_2se, true);
  assert.equal(titleField({ them: { title_before: 0.1, title_after: 0.105, title_delta: 0.005, title_delta_se: 0.01 } }).clears_2se, false);
  assert.equal(titleField({ error: 'both teams required' }).status, 'unknown');
  assert.match(titleField({ error: 'both teams required' }).reason, /both teams required/);
  assert.equal(titleField(null).status, 'unknown');
  assert.equal(titleField({ them: { title_before: NaN } }).status, 'unknown');
});

test('an offer asking for a player he does not have is refused, not shown', () => {
  const s = buildHisScreen({ offer: { partner: '7', give: ['1'], get: ['99'] }, hisRoster, players });
  assert.match(s.error, /not on his roster: 99/);
});

/* ------------------------------------------------------------- DB wrapper */
const lg = { id: 4, my_team_id: 3, payload: JSON.stringify({ seasonId: 2026 }) };
const asset = id => ({ ...players.get(String(id)) });
function fakeSvc({ layer = true, simThrows = false } = {}) {
  const calls = { readDeal: null, tradeImpact: null };
  const profile = { needs: new Set(['RB']) };
  return {
    calls,
    svc: {
      engine: {
        assetUniverse: () => new Map(),
        loadRosters: () => [
          { roster_id: '3', players: [asset(1), asset(2)] },
          { roster_id: '7', players: [asset(10), asset(11), asset(12)] },
        ],
      },
      format: { deriveFormat: () => ({ formatKey: 'x' }) },
      week: { leagueCurrentWeek: () => 3 },
      cp: {
        counterpartyLayer: (id, opts) => { calls.layer = { id, opts }; return new Map(layer ? [['7', profile]] : []); },
        readDeal: args => { calls.readDeal = args; return { their_perceived_give: 1100, their_perceived_get: 1050, perception_informed: true }; },
        playerValuation: (_m, p) => ({ their_value: p.value * 1.05, multiplier: 1.05, factors: [] }),
      },
      sim: {
        tradeImpact: (_lg, args) => {
          if (simThrows) throw new Error('world failed');
          calls.tradeImpact = args;
          return { me: {}, them: { title_before: 0.2, title_after: 0.18, title_delta: -0.02, title_delta_se: 0.005 } };
        },
      },
    },
  };
}

test('hisScreenFor: reads his clone and his side of the paired sim for league 4', async () => {
  const { svc, calls } = fakeSvc();
  const s = await hisScreenFor(lg, { partner: '7', give: ['1'], get: ['10'], enabled: true, svc });
  assert.equal(s.enabled, true);
  assert.equal(s.league, 4);
  assert.deepEqual(calls.layer, { id: 4, opts: { season: 2026, week: 3 } });
  // His side of the deal: he gives what Nick gets, he gets what Nick gives.
  assert.deepEqual(calls.readDeal.theirGive.map(p => p.id), [10]);
  assert.deepEqual(calls.readDeal.theirGet.map(p => p.id), [1]);
  assert.deepEqual(calls.tradeImpact, { myTeamId: '3', theirTeamId: '7', iGive: [1], iGet: [10] });
  assert.equal(s.fair.value.verdict, 'fair');
  assert.equal(s.title_odds.value.delta, -0.02);
  assert.equal(s.title_odds.clears_2se, true);
  assert.equal(s.gets[0].fills_need, true);
  assert.equal(s.preview, undefined, 'on by the caller, not by preview');
});

test('hisScreenFor: no clone for him -> unknown badge; sim failure -> unknown title odds', async () => {
  const { svc } = fakeSvc({ layer: false, simThrows: true });
  const s = await hisScreenFor(lg, { partner: '7', give: ['1'], get: ['10'], enabled: true, svc });
  assert.equal(s.fair.status, 'unknown');
  assert.equal(s.title_odds.status, 'unknown');
  assert.match(s.title_odds.reason, /world failed/);
});

test('hisScreenFor refuses bad offers with a reason', async () => {
  const { svc } = fakeSvc();
  assert.match((await hisScreenFor(lg, { partner: '3', give: ['1'], enabled: true, svc })).error, /another team/);
  assert.match((await hisScreenFor(lg, { partner: '9', give: ['1'], enabled: true, svc })).error, /another team/);
  assert.match((await hisScreenFor(lg, { partner: '7', give: ['10'], enabled: true, svc })).error, /not on your roster: 10/);
  assert.match((await hisScreenFor(lg, { partner: '7', get: ['1'], enabled: true, svc })).error, /not on his roster: 1/);
  assert.match((await hisScreenFor(lg, { partner: '7', enabled: true, svc })).error, /names no players/);
});

test('flag: off by default with the reason; site flag on; preview turns it on and says so', async () => {
  const { svc } = fakeSvc();
  const args = { partner: '7', give: ['1'], get: ['10'], svc };
  await withEnv({ [HIS_SCREEN_ENV]: undefined, [PREVIEW_ENV]: undefined }, async () => {
    const off = await hisScreenFor(lg, args);
    assert.deepEqual(off, { enabled: false, reason: HIS_SCREEN_OFF_REASON });
  });
  assert.deepEqual(withEnv({ [HIS_SCREEN_ENV]: '1', [PREVIEW_ENV]: undefined }, () => hisScreenGate()), { on: true, preview: false });
  assert.deepEqual(withEnv({ [HIS_SCREEN_ENV]: undefined, [PREVIEW_ENV]: '1' }, () => hisScreenGate()), { on: true, preview: true });
  assert.deepEqual(withEnv({ [HIS_SCREEN_ENV]: undefined, [PREVIEW_ENV]: '1' }, () => hisScreenGate(false)), { on: false, preview: false });
  // hisScreenGate reads the env synchronously at call time, so the async wrapper is checked under a held env.
  const saved = { a: process.env[HIS_SCREEN_ENV], b: process.env[PREVIEW_ENV] };
  delete process.env[HIS_SCREEN_ENV]; process.env[PREVIEW_ENV] = '1';
  try {
    const on = await hisScreenFor(lg, args);
    assert.equal(on.enabled, true);
    assert.equal(on.preview, true);
    assert.equal(on.preview_reason, HIS_SCREEN_OFF_REASON);
  } finally {
    if (saved.a === undefined) delete process.env[HIS_SCREEN_ENV]; else process.env[HIS_SCREEN_ENV] = saved.a;
    if (saved.b === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved.b;
  }
});
