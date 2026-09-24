/**
 * FEAS-140-ESPN-WIRE: the served 140 card priced on ESPN's projected lineup. The producer's
 * ESPN context (league-adapter.mjs#espnContext) + the internal -> ESPN id map (espn-id-map.js)
 * + the planner's roster_after. The four-team fixture league and a made-up ESPN payload; no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../server/services/campaign/feasibility.js');
const E = await import('../server/services/campaign/espn-lineup.js');
const M = await import('../server/services/campaign/espn-id-map.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { espnContext } = await import('../scripts/campaign/league-adapter.mjs');

const ON = { [F.POINTS_FEASIBILITY_ENV]: '1' };
const OFF = { [F.POINTS_FEASIBILITY_ENV]: '0' };
const SEASON = 2026;
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, 'D/ST': 16 };
const ESPN = id => 1000 + id;             // the fixture's ESPN ids: internal id + 1000
const ROSTERS = { 1: [1, 2, 3, 4, 5, 6, 7], 2: [11, 12, 13, 14, 15], 3: [21, 22, 23, 24, 25], 4: [31, 32, 33, 34, 35] };

const players = makePlayers();
const entry = (espnId, pos, ros, name) => ({ playerId: espnId, playerPoolEntry: { player: {
  id: espnId, fullName: name, defaultPositionId: POS_ID[pos], proTeamId: 1, injuryStatus: 'ACTIVE',
  stats: [{ seasonId: SEASON, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedAverage: ros }] } } });
function payload() {
  const teams = Object.entries(ROSTERS).map(([t, ids]) => ({ id: Number(t), roster: { entries: ids.map(id => {
    const p = players.get(id);
    return entry(ESPN(id), p.position, p.power * 1.6, p.name);
  }) } }));
  // Nick's K and D/ST: on ESPN's roster, never in the sim's (no internal asset).
  teams[0].roster.entries.push(entry(901, 'K', 8, 'Kicker'), entry(902, 'D/ST', 6, 'Defense'));
  return { seasonId: SEASON, scoringPeriodId: 4, teams };
}
const assets = new Map([...players].map(([id, p]) => [id, { ...p, espn_id: ESPN(id) }]));
// The trade-engine resolver's contract: pl -> { asset, match }.
const resolver = (drop = new Set()) => pl => {
  const a = [...assets.values()].find(x => String(x.espn_id) === String(pl?.id) && !drop.has(x.id));
  return a ? { asset: a, match: 'espn_id' } : { asset: null, match: null };
};
const espnFor = ({ drop = new Set() } = {}) => {
  const p = payload();
  const kept = new Map([...assets].filter(([id]) => !drop.has(id)));
  return { ctx: E.espnLineupContext(p), map: M.buildEspnIdMap(p, resolver(drop), kept), load_ms: 3 };
};
const title = () => normaliseObjective({ risk_mode: 'balanced' });

test('id map: every rostered ESPN entry with an asset maps; K and D/ST without one are unresolved and counted', () => {
  const { map } = espnFor();
  assert.equal(map.coverage.rostered, 24);
  assert.equal(map.coverage.mapped, 22);
  assert.equal(map.coverage.by_espn_id, 22);
  assert.deepEqual(map.coverage.unresolved, ['901', '902']);
  assert.equal(map.coverage.share, 22 / 24);
  assert.equal(map.toEspn.get('21'), '1021');
  assert.deepEqual(map.rosterOf.get('1'), ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '901', '902']);
});

test('roster after: ESPN roster minus what Nick gives plus what he gets; K and D/ST stay', () => {
  const { map } = espnFor();
  const r = M.espnRosterAfter(map, '1', ROSTERS[1], [1, 2, 3, 4, 5, 6, 21]);
  assert.deepEqual(r.ids, ['1001', '1002', '1003', '1004', '1005', '1006', '901', '902', '1021']);
  const miss = M.espnRosterAfter(espnFor({ drop: new Set([21]) }).map, '1', ROSTERS[1], [1, 2, 3, 4, 5, 6, 21]);
  assert.equal(miss.ids, null);
  assert.deepEqual(miss.missing, ['21']);
  assert.match(miss.reason, /internal player id\(s\) 21/);
  assert.match(M.espnRosterAfter(map, '9', [], []).reason, /team 9 has no ESPN roster/);
});

test('served: with the ESPN context every deck move and every option is priced on the ESPN lineup', () => {
  const a = { ...makeAdapter(), espn: espnFor() };
  const res = planLeague(a, { objective: title(), env: ON });
  const f = res.feasibility_points;
  assert.equal(f.scale, E.ESPN_SCALE);
  assert.ok(f.options.length >= 1);
  for (const o of f.options) assert.equal(o.priced, true, o.label);
  const w = f.espn_wire;
  assert.equal(w.status, 'on');
  assert.equal(w.load_ms, 3);
  assert.equal(w.map.share, 22 / 24);
  assert.equal(w.priced, f.options.length);
  assert.deepEqual(w.unpriced, []);
  assert.equal(w.deck.length, res.deck.length);
  for (const d of w.deck) { assert.equal(d.priced, true, `deck ${d.rank}`); assert.ok(Number.isFinite(d.espn_mean_after)); }
  // Today's lineup is Nick's ESPN roster, K and D/ST included (7 skill players fill 7 of the 8 skill slots).
  assert.deepEqual(E.espnLineupContext(payload()).forTeam('1').weeks([4])[0].starters.filter(s => ['K', 'D/ST'].includes(s.slot)).map(s => s.id), [901, 902]);
  const e = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(e).errors, []);
  assert.equal(e.feasibility_points.status, 'ok');
  assert.equal(e._run.feasibility_points_detail.espn_wire.deck.length, res.deck.length);
});

test('served: a moved player with no ESPN id leaves that plan unpriced, with the exact missing id', () => {
  const probe = planLeague({ ...makeAdapter(), espn: espnFor() }, { objective: title(), env: ON });
  const got = probe.deck[0].plan.steps.flatMap(s => s.get).map(Number);
  assert.ok(got.length >= 1);
  const res = planLeague({ ...makeAdapter(), espn: espnFor({ drop: new Set([got[0]]) }) }, { objective: title(), env: ON });
  const w = res.feasibility_points.espn_wire;
  const d0 = w.deck[0];
  assert.equal(d0.priced, false);
  assert.deepEqual(d0.missing_ids, [String(got[0])]);
  assert.match(d0.reason, new RegExp(`internal player id\\(s\\) ${got[0]}`));
  assert.ok(w.unpriced.some(u => u.missing_ids.includes(String(got[0]))));
  for (const o of res.feasibility_points.options.filter(x => x.priced === false)) assert.ok(w.unpriced.some(u => u.label === o.label));
});

test('off: flag off, no espn read and no card; a fixture adapter without espn keeps the incumbent card', () => {
  const svc = { db: { row: () => { throw new Error('read the DB with the flag off'); } } };
  assert.equal(espnContext(svc, 4, {}, new Map(), OFF), null);
  assert.equal(planLeague({ ...makeAdapter(), espn: espnFor() }, { objective: title(), env: OFF }).feasibility_points, null);
  const inc = planLeague(makeAdapter(), { objective: title(), env: ON }).feasibility_points;
  assert.equal(inc.scale, undefined);
  assert.equal(inc.espn_wire, undefined);
  const none = planLeague({ ...makeAdapter(), espn: null }, { objective: title(), env: ON }).feasibility_points;
  assert.equal(none.scale, undefined);
  assert.equal(none.espn_wire.status, 'off');
});

test('producer: espnContext loads once through loadEspnLineup and maps with the engine resolver', () => {
  const p = payload();
  let reads = 0;
  const svc = {
    db: { row: () => { reads++; return { platform: 'espn', season: SEASON, current_week: 4, payload: JSON.stringify(p) }; }, rows: () => [] },
    engine: { espnPlayerResolver: () => resolver() },
  };
  const c = espnContext(svc, 4, p, assets, ON);
  assert.equal(reads, 1);
  assert.equal(c.map.coverage.mapped, 22);
  assert.ok(Number.isInteger(c.load_ms));
  assert.equal(c.ctx.forTeam('1').weeks([4])[0].starters.length, 9);
});
