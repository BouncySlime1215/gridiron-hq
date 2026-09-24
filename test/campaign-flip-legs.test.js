/**
 * FLIP-LEGS: the flip radar's candidates are players Nick can reach, and a leg may be a
 * two-player package on either side (the one planner's fairBand / pairsInBand / screenFair).
 * Behind GRIDIRON_FLIP_LEGS (default off; on under preview mode; =0 vetoes preview).
 * Made-up four-team league with a linear world; no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeScorer, flipMap, flipLegs, flipReach, flipLegsFlag, FLIP_LEGS_ENV } =
  await import('../server/services/campaign/search.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

// Team 1 = Nick. Team 2 (A) holds the star S, team 3 (B) wants him, team 4 holds a star F beyond reach.
const PLAYERS = {
  11: 50, 12: 50, 13: 10,          // Nick: no single player is worth S; 11 + 12 is.
  21: 100, 22: 5,                  // A: S = 21
  31: 55, 32: 50, 33: 5,           // B: no single player is worth S; 31 + 32 is.
  41: 200, 42: 5,                  // F = 41: past Nick's best two (band floor 176 > 100)
};
// How much each team's title odds move per value point of a player (B loves S and F; A is lukewarm).
const LIKES = { 3: { 21: 3, 41: 3 }, 2: { 21: 0.2 }, 4: { 41: 0.2 } };
const w = (team, id) => PLAYERS[id] * (LIKES[team]?.[id] ?? 1) * 1e-4;

function league({ nickNotes = null } = {}) {
  const rosters = new Map([[1, [11, 12, 13]], [2, [21, 22]], [3, [31, 32, 33]], [4, [41, 42]]]);
  const players = new Map(Object.entries(PLAYERS).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const managers = new Map([...rosters.keys()].map(t => [t, { nick: nickNotes?.[t] ?? null }]));
  const adapter = {
    league: { me: 1 }, players, rosters, managers, untouchable: new Set(),
    priceOf: () => ({ price: 1, mult: 1 }),
    priceStep: () => ({ p: 0.5 }),
  };
  const delta = (team, ids) => {
    const base = new Set(rosters.get(team)), now = new Set(ids);
    let d = 0;
    for (const id of now) if (!base.has(id)) d += w(team, id);
    for (const id of base) if (!now.has(id)) d -= w(team, id);
    return d;
  };
  const block = (state, t) => {
    if (t == null) return null;
    const d = delta(t, state.get(t) ?? rosters.get(t));
    return { title_delta: d, title_delta_se: 0.001, title_delta_clears_noise: Math.abs(d) > 0.002 };
  };
  const W = { rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) };
  const S = makeScorer(W, adapter);
  const vals = {
    tradable: id => (players.get(id)?.value ?? 0) > 0,
    lossN: new Map([[11, -0.004], [12, -0.005], [13, -0.001]]),
    addN: new Map([[31, 0.006], [32, 0.005], [33, 0.0005]]),
  };
  return { adapter, S, vals };
}

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};
const legsOn = a => { a.searchOpts = { flipLegs: true }; return a; };

test('flag: default off, =1 on, preview turns it on, =0 vetoes preview', () => {
  withEnv({ [FLIP_LEGS_ENV]: null, [PREVIEW_ENV]: null }, () => assert.equal(flipLegsFlag(), 'off'));
  withEnv({ [FLIP_LEGS_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.equal(flipLegsFlag(), 'on'));
  withEnv({ [FLIP_LEGS_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.equal(flipLegsFlag(), 'preview'));
  withEnv({ [FLIP_LEGS_ENV]: '0', [PREVIEW_ENV]: '1' }, () => assert.equal(flipLegsFlag(), 'off'));
});

test('reach: a player is in reach when his fair band floor is at or under Nick\'s best two', () => {
  const r = flipReach([50, 50, 10]);
  assert.equal(r.package_value, 100);
  assert.equal(r.reaches(100), true);
  assert.equal(r.reaches(113), true);   // floor 99.4
  assert.equal(r.reaches(114), false);  // floor 100.3
  assert.equal(r.reaches(200), false);
});

test('flag off: the incumbent says no fair one-player leg (control)', () => {
  const { adapter, S, vals } = league();
  const out = withEnv({ [FLIP_LEGS_ENV]: null, [PREVIEW_ENV]: null }, () => flipMap(S, adapter, vals));
  const f = out.realised.find(x => x.player === 21 && x.b === 3);
  assert.ok(f, 'S from A to B is attempted');
  assert.equal(f.legs, null);
  assert.equal(f.why, 'no fair one-player leg on both screens');
  assert.ok(out.top.some(x => x.player === 41), 'off: the star beyond reach is still a candidate');
});

test('only a 2-for-1 leg is fair on both screens: the flip realises with both packages', () => {
  const { adapter, S, vals } = league();
  const out = flipMap(S, legsOn(adapter), vals);
  const f = out.realised.find(x => x.player === 21 && x.a === 2 && x.b === 3);
  assert.ok(f?.legs, `realised: ${f?.why}`);
  assert.deepEqual([...f.legs.give_a_ids].sort(), [11, 12]);
  assert.deepEqual([...f.legs.get_b_ids].sort(), [31, 32]);
  assert.equal(f.legs.shape_1, '2-for-1');
  assert.equal(f.legs.shape_2, '1-for-2');
  for (const k of ['p1', 'p2', 'd1', 'd2', 'se2']) assert.ok(Number.isFinite(f.legs[k]), k);
  assert.equal(typeof f.legs.clears2, 'boolean');
  assert.ok([11, 12].includes(f.legs.give_a) && [31, 32].includes(f.legs.get_b), 'served ids stay single players');
  // The legs are the exact scored states: Nick ends with B's two and without his two.
  assert.ok(Math.abs(f.legs.d2 - (w(1, 31) + w(1, 32) - w(1, 11) - w(1, 12))) < 1e-12);
  // The served map (top 10) leads with the realised flip: an unpriced pair's P = 1 does not outrank it.
  const first = out.top[0];
  assert.deepEqual([first.player, first.a, first.b], [21, 2, 3]);
});

test('a star beyond Nick\'s reach is not a candidate', () => {
  const { adapter, S, vals } = league();
  const out = flipMap(S, legsOn(adapter), vals);
  assert.equal(out.reach_value, 100);
  assert.ok(!out.top.some(x => x.player === 41) && !out.realised.some(x => x.player === 41));
  assert.ok(out.top.some(x => x.player === 21));
});

test('untouchables in any nick block are never a flip player or a leg', () => {
  const { adapter, S, vals } = league({ nickNotes: { 2: { untouchable: ['21'] }, 3: { untouchable: ['31'] } } });
  const out = flipMap(S, legsOn(adapter), vals);
  const all = [...out.top, ...out.realised];
  assert.ok(!all.some(x => x.player === 21), 'S is untouchable on A');
  for (const f of out.realised.filter(x => x.legs)) {
    assert.ok(![...f.legs.give_a_ids, ...f.legs.get_b_ids].includes(31));
  }
});

test('a flip that still does not realise names the missing leg', () => {
  const { adapter, S, vals } = league();
  adapter.rosters.set(3, [33]); // B has nothing near S's value
  const out = flipMap(S, legsOn(adapter), vals);
  const f = out.realised.find(x => x.player === 21 && x.b === 3);
  assert.equal(f.legs, null);
  assert.equal(f.why_code, 'no_leg_b');
  assert.match(f.why, /Team 3's players/);
});

test('flipLegs: a single fair player beats a pair when it costs Nick less', () => {
  const val = id => ({ 1: 95, 2: 50, 3: 50, 9: 100, 7: 100 })[id] ?? 0;
  const legs = flipLegs({ player: 9, myIds: [1, 2, 3], bIds: [7], val,
    lossN: new Map([[1, -0.001], [2, -0.004], [3, -0.004]]), addN: new Map([[7, 0.01]]) });
  assert.deepEqual(legs.legX, [1]);
  assert.deepEqual(legs.legY, [7]);
});
