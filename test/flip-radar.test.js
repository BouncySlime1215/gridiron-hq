/**
 * FLIP-01: the flip radar as a nightly + on-news producer for league 4, writing
 * the `flip_map` section of the War Room plans contract (plans-schema.js, #238).
 *
 * The world is injected (a four-team fixture with known spreads, prices and
 * P(accept)s), so every ranking and filter is checked against numbers worked
 * by hand. The real world (flip-world.js: tradeImpactWorld + counterparty
 * model) is the prototype's harness, run on the real league by the LOCAL line
 * in the PR body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-flip01-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const score = await import('../server/services/flip-radar/flip-score.js');
const { computeFlipMap } = await import('../server/services/flip-radar/flip-map.js');
const { toFlipMapSection } = await import('../server/services/flip-radar/flip-section.js');
const radar = await import('../server/services/flip-radar/flip-radar.js');
const { validateLeague, SECTIONS } = await import('../server/services/campaign/plans-schema.js');

/* ------------------------------------------------------------- fixture world */

const VAL = { m1: 100, m2: 50, a1: 100, a2: 40, b1: 95, b2: 30, c1: 100, c2: 20 };
const MULT = { 2: 0.9, 3: 1, 4: 1 };
const P = { 2: 0.6, 3: 0.5, 4: 0.2 };
// Moves that clear: a1 -> 3 and a1 -> 4 (same spread 0.04), a2 -> 3 (no fair leg), c1 -> 2 (B prices him lower than A).
const MOVES = {
  'a1>3': { dB: 0.05, dA: -0.01 }, 'a1>4': { dB: 0.045, dA: -0.005 },
  'a2>3': { dB: 0.06, dA: -0.03 }, 'c1>2': { dB: 0.07, dA: -0.01 }
};
function fixture({ blocked = [], days = null } = {}) {
  const calls = { pAccept: [] };
  const ctx = {
    me: '1',
    teams: new Map([['1', ['m1', 'm2']], ['2', ['a1', 'a2']], ['3', ['b1', 'b2']], ['4', ['c1', 'c2']]]),
    tradable: () => true,
    val: id => VAL[id],
    move: (pid, a, b) => ({ dB: 0, dA: 0, ...MOVES[`${pid}>${b}`], seB: 0.01, seA: 0.01 }),
    priceOf: (team, pid) => ({ mult: MULT[team] ?? 1, price: VAL[pid] * (MULT[team] ?? 1) }),
    pAccept: (team, give, get) => { calls.pAccept.push([team, give, get]); return P[team]; },
    nickAdd: new Map(), nickLoss: new Map(),
    legs: () => ({ d1: 0.01, d2: 0.03, se2: 0.01, clears2: true }),
    blocked: new Set(blocked), days
  };
  return { ctx, calls };
}
const world = (opts = {}) => ({ ctx: fixture(opts).ctx, names: id => `${id} (WR)`, rescores: () => 7 });

function entryWith(flip_map, names) {
  return { league: 4, me: '1', names,
    ...Object.fromEntries(Object.keys(SECTIONS).map(k => [k, { status: 'unknown', reason: 'not this producer', source: 'campaign.plan' }])),
    flip_map };
}

/* --------------------------------------------------------------- pure parts */

test('screen fairness is the trade finder window on his own screen', () => {
  assert.equal(score.screenFair(100, 100), true);
  assert.equal(score.screenFair(118, 100), true);
  assert.equal(score.screenFair(119, 100), false);
  assert.equal(score.screenFair(87, 100), false);
  assert.equal(score.screenFair(50, 0), false, 'nothing given is not a screen');
});

test('spread = dB + dA, clears only past 2 SE', () => {
  const s = score.flipSpread(0.05, 0.01, -0.01, 0.01);
  assert.ok(Math.abs(s.spread - 0.04) < 1e-12);
  assert.ok(Math.abs(s.se - Math.SQRT2 * 0.01) < 1e-12);
  assert.equal(s.clears, true);
  assert.equal(score.flipSpread(0.02, 0.01, 0, 0.01).clears, false);
});

test('rank = spread x P(A) x P(B) x days; unknown deadline is x1, passed is 0', () => {
  assert.ok(Math.abs(score.rankScore({ spread: 0.04, p1: 0.6, p2: 0.5, days: 10 }) - 0.12) < 1e-12);
  assert.ok(Math.abs(score.rankScore({ spread: 0.04, p1: 0.6, p2: 0.5, days: null }) - 0.012) < 1e-12);
  assert.equal(score.rankScore({ spread: 0.04, p1: 0.6, p2: 0.5, days: 0 }), 0);
  assert.equal(score.rankScore({ spread: -0.01, p1: 1, p2: 1, days: 5 }), 0);
});

test('days to deadline reads ESPN tradeSettings.deadlineDate', () => {
  const now = Date.UTC(2026, 8, 24);
  const payload = JSON.stringify({ settings: { tradeSettings: { deadlineDate: now + 10.5 * 86_400_000 } } });
  assert.equal(score.daysToDeadline(payload, now), 10);
  assert.equal(score.daysToDeadline({ settings: { tradeSettings: { deadlineDate: now - 1 } } }, now), 0);
  assert.equal(score.daysToDeadline({ settings: {} }, now), null);
  assert.equal(score.daysToDeadline('not json', now), null);
});

test('a declined second leg strands the first in the expectation', () => {
  const e = score.twoLegExpectation(0.6, 0.01, 0.5, 0.03);
  assert.ok(Math.abs(e.p_both - 0.3) < 1e-12);
  assert.ok(Math.abs(e.expected - (0.6 * 0.5 * 0.01 + 0.3 * 0.03)) < 1e-12);
});

/* ------------------------------------------------------------ the flip map */

test('flip map: ranked by spread x P(A) x P(B), both legs fair on each screen', () => {
  const { ctx, calls } = fixture({ days: 10 });
  const r = computeFlipMap(ctx);
  assert.equal(r.pairs.length, 3 * 2 * 2, '3 league-mates x 2 players x 2 buyers');
  const keys = r.flips.map(f => `${f.player}>${f.b}`);
  // c1 -> 2 clears but team 2 prices him below team 4 (90 < 100): not a flip.
  assert.deepEqual(keys, ['a1>3', 'a1>4', 'a2>3']);
  const [top, second, noLeg] = r.flips;
  assert.equal(top.legs.give_a, 'm1', 'Nick pays A with m1 (100 for 100: fair on A\'s screen); m2 (50) is not');
  assert.equal(top.legs.get_b, 'b1', 'B pays with b1 (95 for 100: +5.3% on B\'s screen)');
  assert.ok(score.screenFair(VAL[top.legs.give_a], VAL.a1) && score.screenFair(VAL.a1, VAL[top.legs.get_b]));
  assert.equal(top.legs.p1, 0.6); assert.equal(top.legs.p2, 0.5);
  assert.ok(Math.abs(top.rank_score - 0.04 * 0.6 * 0.5 * 10) < 1e-9);
  assert.ok(top.rank_score > second.rank_score, 'same spread; team 4 says yes less often, so it ranks lower');
  assert.equal(noLeg.legs, null);
  assert.match(noLeg.legs_why_not, /fair on both screens/);
  // P(accept) is asked from each manager's side: A gives p, gets Nick's player.
  assert.deepEqual(calls.pAccept[0], ['2', ['a1'], ['m1']]);
  assert.deepEqual(calls.pAccept[1], ['3', ['b1'], ['a1']]);
});

test('flip map: a manager marked never-trade is skipped as either side', () => {
  const r = computeFlipMap(fixture({ blocked: ['4'] }).ctx);
  assert.deepEqual(r.flips.map(f => `${f.player}>${f.b}`), ['a1>3', 'a2>3']);
});

test('per manager: his clone price vs his title value for his key players', () => {
  const r = computeFlipMap(fixture().ctx);
  const a1 = r.managers['2'].find(x => x.player === 'a1');
  assert.equal(a1.price, 90);
  assert.equal(a1.mult, 0.9);
  assert.ok(Math.abs(a1.title_value - (0.01 + 0.005) / 2) < 1e-12, 'mean -dA over both buyers');
});

/* ------------------------------------------------------------ the contract */

test('flip_map section validates against the plans contract (#238)', () => {
  const r = computeFlipMap(fixture({ days: 10 }).ctx);
  const { section, ids } = toFlipMapSection(r, { asOf: '2026-09-24T03:00:00.000Z' });
  const names = Object.fromEntries(ids.map(id => [id, `${id} (WR)`]));
  const v = validateLeague(entryWith(section, names));
  assert.deepEqual(v.errors, []);
  assert.equal(section.value[0].spread.source, 'sim.title');
  assert.equal(section.value[0].spread.clears_2se, true);
  assert.equal(section.value[0].price_a.source, 'clone.price');
  assert.equal(section.value[0].legs.p_both.status, 'ok');
  assert.equal(section.value[0].legs.p_both.source, 'clone.accept');
  assert.equal(section.value[2].legs, null);
  // A missing name is caught: the section's ids must all be in names.
  const bad = validateLeague(entryWith(section, {}));
  assert.ok(bad.errors.some(e => /not in this league's names/.test(e.message)));
});

test('a number that is not finite is written unknown with a reason, never 0', () => {
  const r = computeFlipMap({ ...fixture().ctx, pAccept: () => NaN });
  const { section, ids } = toFlipMapSection(r, {});
  const legs = section.value[0].legs;
  assert.equal(legs.p1.status, 'unknown');
  assert.ok(legs.p1.reason);
  assert.ok(!('value' in legs.p1));
  assert.match(section.reason, /no trade deadline/);
  assert.deepEqual(validateLeague(entryWith(section, Object.fromEntries(ids.map(id => [id, id])))).errors, []);
});

/* ------------------------------------------------------- schedule and news */

test('decideRun: nightly, on news (an hour apart), otherwise nothing', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const ago = min => new Date(now - min * 60_000).toISOString();
  assert.deepEqual(radar.decideRun({ lastAt: null, now }), { run: true, trigger: 'nightly' });
  assert.equal(radar.decideRun({ lastAt: ago(24 * 60), now }).trigger, 'nightly');
  assert.equal(radar.decideRun({ lastAt: ago(90), now, newsHits: 2 }).trigger, 'news');
  assert.equal(radar.decideRun({ lastAt: ago(30), now, newsHits: 2 }).run, false);
  assert.equal(radar.decideRun({ lastAt: ago(90), now }).run, false);
  assert.equal(radar.decideRun({ lastAt: ago(1), now, force: true }).trigger, 'manual');
});

const PAYLOAD = JSON.stringify({
  settings: { tradeSettings: { deadlineDate: Date.parse('2026-11-20T00:00:00Z') } },
  teams: [{ id: 2, roster: { entries: [{ playerPoolEntry: { player: { fullName: "Ja'Marr Example" } } }] } }]
});
run(`INSERT INTO leagues (id, platform, league_id, season, my_team_id, payload) VALUES (4, 'espn', 'x', 2026, '1', ?)`, PAYLOAD);
function addNews(name, createdAt) {
  run(`INSERT INTO nfl_news_signals (news_id, player_key, player_name, signal_type, confidence, published_at,
    evidence_span, extractor_version, created_at) VALUES (?, ?, ?, 'injury', 0.9, ?, 'x', 'test', ?)`,
  Math.floor(Math.random() * 1e9), name.toLowerCase(), name, createdAt, createdAt);
}

test('flag off: the tick does nothing and the section says why', async () => {
  delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  const r = await radar.flipRadarTick({ world: world() });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /default-off/);
  assert.equal(rows('SELECT * FROM flip_map_snapshots').length, 0);
  const e = radar.flipMapEntry();
  assert.equal(e.flip_map.status, 'unknown');
  assert.match(e.flip_map.reason, /default-off/);
});

test('flag on: nightly run, then quiet, then a news run for a rostered player only', async () => {
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.equal(radar.flipMapEntry().flip_map.reason, 'flip radar has not run yet');
    const t0 = Date.parse('2026-09-24T03:00:00Z');
    const r1 = await radar.flipRadarTick({ now: t0, world: world() });
    assert.equal(r1.trigger, 'nightly');
    assert.equal(r1.days, 56, 'deadline read from the league payload');
    assert.equal(r1.realised, 2);

    const r2 = await radar.flipRadarTick({ now: t0 + 90 * 60_000, world: world() });
    assert.equal(r2.skipped, true, 'fresh and no news');

    addNews('Somebody Unrostered', '2026-09-24 04:00:00');
    assert.equal((await radar.flipRadarTick({ now: t0 + 91 * 60_000, world: world() })).skipped, true,
      'news on a player nobody in the league rosters does not trigger');

    addNews('JaMarr Example', '2026-09-24 04:10:00');
    const r3 = await radar.flipRadarTick({ now: t0 + 92 * 60_000, world: world() });
    assert.equal(r3.trigger, 'news', 'the name matches through normalisation');
    const snaps = rows('SELECT trigger, trigger_ref, flips_n, pairs_n, rescores, error FROM flip_map_snapshots ORDER BY id');
    assert.deepEqual(snaps.map(s => s.trigger), ['nightly', 'news']);
    assert.equal(JSON.parse(snaps[1].trigger_ref).length, 1);
    assert.equal(snaps[0].flips_n, 3);
    assert.equal(snaps[0].rescores, 7);

    const e = radar.flipMapEntry();
    assert.equal(e.flip_map.status, 'ok');
    assert.deepEqual(validateLeague(entryWith(e.flip_map, e.names)).errors, []);
  } finally {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  }
});

test('a failed world is a snapshot row with the error, and the section says failed', async () => {
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    run('DELETE FROM flip_map_snapshots');
    const r = await radar.runFlipRadar({ world: { error: 'title-odds world failed' } });
    assert.equal(r.ok, false);
    const e = radar.flipMapEntry();
    assert.equal(e.flip_map.status, 'failed');
    assert.match(e.flip_map.reason, /world failed/);
    await assert.rejects(radar.runFlipRadar({ world: { ...world(), ctx: { ...fixture().ctx, move: () => { throw new Error('boom'); } } } }), /boom/);
    assert.match(rows('SELECT error FROM flip_map_snapshots ORDER BY id DESC LIMIT 1')[0].error, /flip map threw: boom/);
  } finally {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  }
});

test('scheduler: flip_radar is a worker-thread job on the live refresh loop', async () => {
  const { JOBS } = await import('../server/services/scheduler.js');
  assert.equal(JOBS.flip_radar.offThread, true);
  assert.equal(JOBS.flip_radar.tier, 'growth');
  const { FANTASY_LIVE_JOBS } = await import('../scripts/refresh-live-data.mjs');
  assert.ok(FANTASY_LIVE_JOBS.includes('flip_radar'));
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '';
  const r = await JOBS.flip_radar.run();
  assert.equal(r.skipped, true, 'the real job is a no-op with the flag off');
});
