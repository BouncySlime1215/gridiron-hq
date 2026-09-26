/**
 * BENCH-CONSOLIDATION FINDER (item 46) + ROSTER-SPOT VALUE (item 43), shadow.
 * Made-up leagues only (a tiny linear world, and test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { consolidationFlag, rosterSpotValue, findConsolidations, CONSOLIDATION_PASS_BAR, CONSOLIDATION_BUDGET } =
  await import('../server/services/campaign/consolidation.js');
const { makeScorer, boardOf, BLUE_CHIP_SCORE, DEPTH_PREMIUM_MAX, overpayPct } = await import('../server/services/campaign/search.js');
const { ruleVerdict } = await import('../server/services/campaign/never-give.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

/* ---------------------------------------------------------------- the flag */

test('flag: shadow only with GRIDIRON_CONSOLIDATION=1 or shadow; never through preview; there is no on', () => {
  assert.equal(consolidationFlag({ GRIDIRON_CONSOLIDATION: '1' }), 'shadow');
  assert.equal(consolidationFlag({ GRIDIRON_CONSOLIDATION: 'shadow' }), 'shadow');
  assert.equal(consolidationFlag({ GRIDIRON_CONSOLIDATION: 'on' }), 'off');
  assert.equal(consolidationFlag({ GRIDIRON_CONSOLIDATION: '0' }), 'off');
  assert.equal(consolidationFlag({}), 'off');
  assert.equal(consolidationFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(CONSOLIDATION_PASS_BAR.rules_failures, 0);
  assert.ok(CONSOLIDATION_BUDGET.candidates > 0);
});

/* ------------------------------------------------------------ roster-spot value */

// A 3-slot lineup (QB, WR, FLEX RB/WR) on ros_ppg, like the adapter's startersOf.
const lineupPpg = list => {
  const pool = [...list].sort((a, b) => b.ros_ppg - a.ros_ppg);
  const used = new Set();
  let pts = 0;
  for (const [ok] of [[['QB']], [['WR']], [['RB', 'WR']]]) {
    const p = pool.find(x => !used.has(x.id) && ok.includes(x.position));
    if (p) { used.add(p.id); pts += p.ros_ppg; }
  }
  return pts;
};
const pl = (id, position, ros_ppg) => ({ id, position, ros_ppg });

test('roster spot: the free agent who raises the lineup most, not the highest rate', () => {
  const roster = [pl(1, 'QB', 20), pl(2, 'WR', 12), pl(3, 'RB', 4)];
  const wire = [pl(41, 'QB', 15), pl(42, 'RB', 9), pl(43, 'TE', 30)];
  const v = rosterSpotValue({ roster, freeAgents: wire, lineupPpg, spots: 1 });
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.fills.map(f => f.id), ['42'], 'the RB starts at FLEX (+5); the QB sits; a TE has no slot here');
  assert.equal(v.lineup_ppg_gain, 5);
  assert.equal(v.bench_ppg, 9);
});

test('roster spot: nobody starts -> the highest rate fills it, gain 0; ties to the id', () => {
  const roster = [pl(1, 'QB', 20), pl(2, 'WR', 12), pl(3, 'WR', 11)];
  const v = rosterSpotValue({ roster, freeAgents: [pl(42, 'RB', 3), pl(41, 'QB', 8), pl(40, 'QB', 8)], lineupPpg });
  assert.deepEqual(v.fills.map(f => f.id), ['40']);
  assert.equal(v.lineup_ppg_gain, 0);
});

test('roster spot: two spots fill two players; blocked ids, empty wire and no lineup fail closed', () => {
  const roster = [pl(1, 'QB', 20)];
  const wire = [pl(41, 'WR', 10), pl(42, 'WR', 8), pl(43, 'WR', 30)];
  const two = rosterSpotValue({ roster, freeAgents: wire, lineupPpg, spots: 2, blocked: new Set(['43']) });
  assert.deepEqual(two.fills.map(f => f.id), ['41', '42'], 'a blocked free agent (a player Nick sold) is never picked');
  assert.equal(two.lineup_ppg_gain, 18);
  assert.equal(rosterSpotValue({ roster, freeAgents: [], lineupPpg }).status, 'empty_wire');
  assert.equal(rosterSpotValue({ roster, freeAgents: wire }).status, 'no_lineup');
  assert.equal(rosterSpotValue({ roster, freeAgents: wire, lineupPpg, spots: 0 }).status, 'no_spot');
});

/* ------------------------------------------------ a tiny linear world */

// Nick = team 1. Depth: 11 12 13 14 18 (board < 83). 16 is his Blue chip; 160 and 277 are pinned (never given).
// Team 2: 21 (Blue chip 88) and 22 (80, under the floor). Team 3: 290 (pinned never-get). Team 4: blocked manager.
// Team 5: 25, a player Nick sold this season.
const VALUES = { 11: 60, 12: 50, 13: 45, 14: 35, 18: 20, 16: 60, 160: 40, 277: 30, 21: 100, 22: 100, 290: 95, 31: 100, 25: 100 };
const POINTS = { 11: 1, 12: 1, 13: 1, 14: 1, 18: 0, 16: 1, 160: 1, 277: 1, 21: 10, 22: 10, 290: 10, 31: 10, 25: 10 };
const BOARD = { 11: 70, 12: 60, 13: 65, 14: 50, 18: 40, 16: 90, 160: 60, 277: 70, 21: 88, 22: 80, 290: 90, 31: 90, 25: 90 };
const ROSTERS = () => new Map([[1, [11, 12, 13, 14, 18, 16, 160, 277]], [2, [21, 22]], [3, [290]], [4, [31]], [5, [25]]]);

function world({ values = VALUES, points = POINTS, board = BOARD, titleOf = null, confirmTitleOf = null } = {}) {
  const rosters = ROSTERS();
  const players = new Map(Object.entries(values).map(([id, value]) => [Number(id), { id: Number(id), position: 'WR', value, ros_ppg: points[id] }]));
  const adapter = {
    league: { me: 1 }, players, rosters, untouchable: new Set(['160', '277', '290']),
    managers: new Map([[2, {}], [3, {}], [4, { blocked: true }], [5, {}]]),
    freeAgents: [{ id: 51, position: 'WR', ros_ppg: 6 }, { id: 52, position: 'WR', ros_ppg: 4 }],
    lineupPpg: list => list.map(p => p.ros_ppg ?? 0).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0),
  };
  const d = (team, ids, per) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += per[id];
    for (const id of base) if (!ids.includes(id)) s -= per[id];
    return s;
  };
  const scorer = tf => makeScorer({ rescore: (state, a, b) => {
    const blk = t => {
      if (t == null) return null;
      const ids = state.get(t) ?? rosters.get(t);
      const pts = d(t, ids, points);
      const title = tf ? tf(ids, pts) : pts * 1e-3;
      return { title_delta: title, title_delta_se: 0.001, points_delta: pts, points_delta_se: 0.1 };
    };
    return { me: blk(a), them: blk(b) };
  } }, adapter);
  return { adapter, values, S: scorer(titleOf), S2: scorer(confirmTitleOf ?? titleOf), board: boardOf({ board }) };
}
const run = (w, extra = {}) => findConsolidations({ adapter: w.adapter, S: w.S, S2: w.S2, board: w.board,
  vals: { addN: new Map(), lossN: new Map() }, maxOverpay: 0, depthPremium: DEPTH_PREMIUM_MAX,
  excludedTeam: m => !!m?.blocked, soldOut: id => String(id) === '25', budget: { candidates: 200, rows: 50 }, ...extra });

const rulesFor = w => ({
  neverGive: new Set(['160', '80', '277']), neverGet: new Set(['290']), sold: new Set(['25']),
  fc: new Map(Object.entries(w.values).map(([k, v]) => [k, v])), scoreOf: id => w.board.get(String(id)) ?? null, closed: null,
});

test('finder: a depth-only 2-for-1 at +10% rides the premium; every row passes the one rule gate', () => {
  const w = world();
  const r = run(w);
  assert.equal(r.status, 'ok');
  assert.ok(r.rows.length > 0);
  const prem = r.rows.find(x => x.give.join() === '11,12');
  assert.ok(prem, '11 + 12 (110) for 21 (100) is found');
  assert.equal(prem.premium, true);
  assert.equal(prem.overpay_pct, 0.1);
  assert.equal(prem.shape, '2-for-1');
  for (const x of r.rows) {
    const v = ruleVerdict(rulesFor(w), { give: x.give, get: x.get, premium: { points_delta: x.points_delta, title_delta: x.title_delta } });
    assert.equal(v.ok, true, `${x.give} -> ${x.get}: ${v.reasons}`);
  }
});

test('finder: Nick\'s rules are never broken (never-give, blue chips, never-get, sold, blocked, under the floor)', () => {
  const r = run(world());
  const gives = new Set(r.rows.flatMap(x => x.give));
  const gets = new Set(r.rows.flatMap(x => x.get));
  for (const id of ['160', '277', '16']) assert.ok(!gives.has(id), `${id} is never given`);
  for (const id of ['290', '31', '25', '22']) assert.ok(!gets.has(id), `${id} is never a get`);
  assert.deepEqual([...gets], ['21']);
  for (const x of r.rows) {
    assert.ok(x.give.length >= 2 && x.get.length === 1);
    assert.ok(x.points_delta > 0 && x.title_delta > 0 && x.confirm.points_delta > 0 && x.confirm.title_delta > 0);
  }
});

test('finder: a 3-for-1 never overpays (no premium past 2-for-1); an even 3-for-1 is allowed', () => {
  const r = run(world());
  const threes = r.rows.filter(x => x.shape === '3-for-1');
  assert.ok(threes.length > 0, '13 + 14 + 18 = 100 for 21 = 100 is even');
  for (const x of threes) { assert.ok(x.overpay_pct <= 0); assert.equal(x.premium, false); }
  assert.ok(r.dropped.overpay > 0, '12 + 14 + 18 = 105 (+5%) as a 3-for-1 is turned away');
});

test('finder: premium 0 turns the +10% 2-for-1 away', () => {
  const r = run(world(), { depthPremium: 0 });
  assert.ok(!r.rows.some(x => x.overpay_pct > 0));
});

test('finder: a looser max_overpay setting never loosens Nick\'s cap', () => {
  const r = run(world(), { maxOverpay: 0.5, depthPremium: 0 });
  assert.ok(!r.rows.some(x => x.overpay_pct > 0));
});

test('finder: lineup points must rise (a starter in the give that costs more than the get adds is dropped)', () => {
  const r = run(world({ points: { ...POINTS, 14: 12 } }));
  assert.ok(!r.rows.some(x => x.give.includes('14')));
  assert.ok(r.dropped.lineup_points > 0);
});

test('finder: title odds must rise on the planner dice AND on the confirm dice', () => {
  const noTitle = run(world({ titleOf: ids => (ids.includes(21) && !ids.includes(13) ? -0.001 : 0.001) }));
  assert.ok(noTitle.rows.length > 0 && noTitle.rows.every(x => !x.give.includes('13')), 'a package that gives 13 loses title odds here, so none is kept');
  assert.ok(noTitle.dropped.title_odds > 0);
  const confirm = run(world({ confirmTitleOf: ids => (ids.includes(21) && !ids.includes(12) ? -0.001 : 0.001) }));
  assert.ok(confirm.rows.length > 0 && confirm.rows.every(x => !x.give.includes('12')), 'every package that fails on fresh dice is gone');
  assert.ok(confirm.dropped.confirm_title_odds > 0);
});

test('finder: trade memory (a reversal or buy-back) drops the step before any dice', () => {
  const r = run(world(), { stepOk: s => !s.give.includes(11) });
  assert.ok(!r.rows.some(x => x.give.includes('11')));
  assert.ok(r.dropped.trade_memory > 0);
});

test('finder: fails closed with no board, an unread trade ledger or no confirm dice', () => {
  const w = world();
  assert.equal(run({ ...w, board: null }).status, 'no_board');
  assert.equal(run({ ...w, board: null }).rows.length, 0);
  assert.equal(run(w, { ledgerMissing: true }).status, 'ledger_missing');
  assert.equal(run({ ...w, S2: null }).status, 'no_confirm_dice');
  assert.equal(run({ ...w, S2: null }).rows.length, 0);
});

test('finder: each row fills its freed spots from the wire (43) and today\'s roster gets one open-spot value', () => {
  const r = run(world());
  const two = r.rows.find(x => x.shape === '2-for-1');
  assert.equal(two.roster_spot.spots, 1);
  assert.deepEqual(two.roster_spot.fills.map(f => f.id), ['51']);
  const three = r.rows.find(x => x.shape === '3-for-1');
  assert.equal(three.roster_spot.spots, 2);
  assert.deepEqual(three.roster_spot.fills.map(f => f.id), ['51', '52']);
  assert.equal(r.roster_spot_now.status, 'ok');
  assert.equal(r.roster_spot_now.spots, 1);
});

test('finder: ids only in the report (public repo)', () => {
  const s = JSON.stringify(run(world()));
  assert.ok(!/"name"/.test(s));
});

/* ------------------------------------------------ property: random made-up worlds */

test('property: 300 random worlds, every row passes the rule gate, the depth give and both dice', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let rows = 0;
  for (let k = 0; k < 300; k++) {
    const values = {}, board = {}, points = {};
    for (const id of Object.keys(VALUES)) { values[id] = 10 + Math.round(rnd() * 100); board[id] = Math.round(40 + rnd() * 60); points[id] = Math.round(rnd() * 12); }
    const w = world({ values, points, board });
    const r = run(w, { depthPremium: rnd() < 0.5 ? DEPTH_PREMIUM_MAX : 0 });
    for (const x of r.rows) {
      rows++;
      const v = ruleVerdict(rulesFor(w), { give: x.give, get: x.get, premium: { points_delta: x.points_delta, title_delta: x.title_delta } });
      assert.equal(v.ok, true, `world ${k}: ${x.give} -> ${x.get}: ${v.reasons}`);
      for (const id of x.give) assert.ok(board[id] < BLUE_CHIP_SCORE && !['160', '80', '277'].includes(id));
      assert.ok(board[x.get[0]] >= BLUE_CHIP_SCORE);
      const over = overpayPct(x.give.reduce((s, id) => s + values[id], 0), values[x.get[0]]);
      assert.ok(over <= 1e-9 || (x.give.length === 2 && over <= DEPTH_PREMIUM_MAX + 1e-9));
      assert.ok(x.confirm.points_delta > 0 && x.confirm.title_delta > 0);
    }
  }
  assert.ok(rows > 10, `the worlds produced rows to check (${rows})`);
});

/* ------------------------------------------------ the planner: off is unchanged, on is shadow */

const OBJ = { kind: 'title', goal: 'title', risk_mode: 'balanced', stops: [], tolerances: {}, version: 1 };
const strip = res => { const { consolidation, rescores, runtime_ms, phases_ms, ...rest } = res; return rest; };
const withBoard = a => ({ ...a, board: Object.fromEntries([...a.players.keys()].map(id => [id, id < 10 ? 70 : 90])),
  lineupPpg: list => list.map(p => p.ros_ppg ?? 0).sort((x, y) => y - x).slice(0, 5).reduce((s, x) => s + x, 0) });

test('planner: flag off -> no consolidation key; flag on -> a shadow report and the served plan unchanged', () => {
  const off = planLeague(withBoard(makeAdapter()), { objective: OBJ, env: {} });
  assert.equal(off.error, undefined);
  assert.equal('consolidation' in off, false);
  const on = planLeague(withBoard(makeAdapter()), { objective: OBJ, env: { GRIDIRON_CONSOLIDATION: '1' } });
  assert.equal(on.consolidation.mode, 'shadow');
  assert.equal(on.consolidation.status, 'ok');
  assert.deepEqual(strip(on), strip(off), 'nothing served moves with the flag on');
  assert.ok(on.consolidation.rows.length > 0, 'the made-up league has depth-for-star packages to report');
  assert.equal(on.consolidation.dropped.rules.overpay ?? 0, 0, 'the fixture plans uncapped, but the finder keeps Nick\'s 0 cap');
  for (const x of on.consolidation.rows) {
    assert.ok(x.give.every(id => Number(id) < 10), 'only Nick\'s depth is given');
    assert.ok(x.overpay_pct <= 0 || (x.shape === '2-for-1' && x.overpay_pct <= DEPTH_PREMIUM_MAX));
    assert.ok(x.confirm.title_delta > 0 && x.confirm.points_delta > 0);
  }
});

test('planner: flag on with no board -> no_board, nothing found', () => {
  const on = planLeague(makeAdapter(), { objective: OBJ, env: { GRIDIRON_CONSOLIDATION: '1' } });
  assert.equal(on.consolidation.status, 'no_board');
  assert.equal(on.consolidation.rows.length, 0);
});
