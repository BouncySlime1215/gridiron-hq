/**
 * RL-10-1: ESPN's own projection going to 0 feeds SS-01's inactive hook.
 *
 * The rule (server/services/espn-zero-inactive.js): a rostered player whose ESPN projection
 * (league_roster_snapshots.projected_points, written by scripts/collect-roster-snapshots.mjs:92)
 * was >= 5 last week and is 0 this week, and who is not already Out / Doubtful / IR, is flagged
 * "ESPN projects 0: likely inactive". GET /api/trades/:leagueId/lineup serves it through
 * lineupCall().dead_starters, with the source printed on the card.
 *
 * Fixtures follow test/dead-starter-guard.test.js: the asset universe is mocked; roster loading,
 * slot rules, the snapshot table and the producer are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-zero-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';
// The hook is default-off (unconfirmed forward); these fixtures test it switched on, except where a test says otherwise.
process.env.GRIDIRON_ESPN_ZERO_INACTIVE = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');

let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 2 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

const { espnZeroInactive, ESPN_ZERO_SOURCE, ESPN_ZERO_LABEL } = await import('../server/services/espn-zero-inactive.js');
const { lineupCall } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, BENCH: 20, IR: 21 };
let nextId = 1;
/**
 * One rostered player. `slot` is where he is set on ESPN; `prior` / `now` are ESPN's
 * projection for weeks 1 and 2 (null = no snapshot row that week); `espn` his ESPN status.
 */
function player(name, position, slot, week, { espn = 'ACTIVE', prior = week, now = week, onRoster = 1 } = {}) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling: week * 1.5, floor: week * 0.4, active_probability: 0.9, bye: 9, injury_status: null
    },
    entry: {
      lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: espn } }
    },
    snap: { slot, espn, prior, now, onRoster }
  };
}

function snapshot(leagueId, p, period, projected, { source = 'live', onRoster = p.snap.onRoster, espn = p.snap.espn } = {}) {
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
       player_id, player_name, position, lineup_slot_id, lineup_slot, is_starter, injury_status,
       projected_points, on_roster, source, first_seen_at, changed_at)
       VALUES (?, 2026, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20T11:00:00Z', '2026-09-20T11:00:00Z')`,
  leagueId, period, p.asset.espn_id, p.asset.id, p.asset.name, p.asset.position, SLOT_ID[p.snap.slot], p.snap.slot,
  p.snap.slot === 'BENCH' || p.snap.slot === 'IR' ? 0 : 1, espn, projected, onRoster, source);
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 700;
/** A league whose ESPN payload is `mine`, with week-1 (final) and week-2 (live) snapshot rows. */
function league(mine, { snapshots = true } = {}) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'ESPN zero', '1', 10, 1, ?, ?)`,
  id, `ez-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  if (snapshots) {
    for (const p of mine) {
      if (p.snap.prior != null) snapshot(id, p, 1, p.snap.prior, { source: 'final', onRoster: 1, espn: null });
      if (p.snap.now != null) snapshot(id, p, 2, p.snap.now);
    }
  }
  return id;
}

function roster(over = []) {
  return [
    player('Quarterback', 'QB', 'QB', 20),
    player('Back One', 'RB', 'RB', 15),
    player('Back Two', 'RB', 'RB', 12),
    player('Wideout One', 'WR', 'WR', 14),
    player('Wideout Two', 'WR', 'WR', 11),
    player('Tight End', 'TE', 'TE', 8),
    player('Flex Back', 'RB', 'FLEX', 9),
    player('Bench Back', 'RB', 'BENCH', 10),
    player('Bench Wideout', 'WR', 'BENCH', 7),
    ...over
  ];
}

const byName = ds => Object.fromEntries((ds?.items ?? []).map(i => [i.player.name, i]));
const NOW = Date.parse('2026-09-20T12:00:00Z'); // Sunday of week 2, before the 1:00 pm ET games
const idOf = (mine, name) => mine.find(p => p.asset.name === name).asset.id;

test('RED acceptance: prior >= 5 and now 0 is flagged; already Out/Doubtful/IR is not; prior < 5 is not', () => {
  const mine = roster([
    player('Zeroed Starter', 'WR', 'WR', 0, { prior: 14.2, now: 0 }),
    player('Edge Five', 'TE', 'BENCH', 0, { prior: 5, now: 0 }),
    player('Out Zero', 'RB', 'BENCH', 0, { espn: 'OUT', prior: 12, now: 0 }),
    player('Doubtful Zero', 'RB', 'BENCH', 0, { espn: 'DOUBTFUL', prior: 11, now: 0 }),
    player('IR Zero', 'WR', 'BENCH', 0, { espn: 'INJURY_RESERVE', prior: 13, now: 0 }),
    player('Suspended Zero', 'WR', 'BENCH', 0, { espn: 'SUSPENSION', prior: 9, now: 0 }),
    player('Low Prior', 'WR', 'BENCH', 0, { prior: 4.9, now: 0 }),
    player('Not Quite Zero', 'WR', 'BENCH', 0.3, { prior: 12, now: 0.3 }),
    player('No Prior Row', 'WR', 'BENCH', 0, { prior: null, now: 0 }),
    player('Dropped', 'WR', 'BENCH', 0, { prior: 12, now: 0, onRoster: 0 })
  ]);
  const id = league(mine);
  const hook = espnZeroInactive(id, { season: 2026, week: 2 });
  assert.equal(hook.covered, true, 'week-2 and week-1 snapshots exist');
  assert.equal(hook.source, ESPN_ZERO_SOURCE);
  const flagged = new Set([...hook.ids]);
  assert.ok(flagged.has(idOf(mine, 'Zeroed Starter')), 'prior 14.2, now 0, ACTIVE: flagged');
  assert.ok(flagged.has(idOf(mine, 'Edge Five')), 'prior exactly 5 counts');
  for (const n of ['Out Zero', 'Doubtful Zero', 'IR Zero', 'Suspended Zero']) {
    assert.ok(!flagged.has(idOf(mine, n)), `${n}: already Out/Doubtful/IR, not double-flagged`);
  }
  assert.ok(!flagged.has(idOf(mine, 'Low Prior')), 'prior 4.9 is below 5: not flagged');
  assert.ok(!flagged.has(idOf(mine, 'Not Quite Zero')), 'a 0.3 projection is not 0');
  assert.ok(!flagged.has(idOf(mine, 'No Prior Row')), 'no week-1 row: nothing to compare');
  assert.ok(!flagged.has(idOf(mine, 'Dropped')), 'no longer on the roster');
  assert.ok(!flagged.has(idOf(mine, 'Quarterback')), 'a healthy projection is not flagged');
  assert.equal(flagged.size, 2);
});

test('the Start/Sit card flags the zeroed starter with the source named, and swaps in the best bench player', () => {
  const mine = roster([player('Zeroed Starter', 'WR', 'WR', 0, { prior: 14.2, now: 0 })]);
  // Put him in a starting slot instead of Wideout Two.
  mine.splice(mine.findIndex(p => p.asset.name === 'Wideout Two'), 1);
  const id = league(mine);
  const ds = lineupCall(id, { providers: {}, now: NOW }).dead_starters;
  const item = byName(ds)['Zeroed Starter'];
  assert.equal(item?.reason, 'inactive');
  assert.equal(item?.source, ESPN_ZERO_SOURCE);
  assert.match(item.why, /ESPN projects 0: likely inactive/);
  assert.equal(item.replacement?.name, 'Bench Wideout');
  assert.match(item.source_label, /at ESPN's final pregame projection/);
  assert.match(item.source_label, /timing not yet tested/);
  assert.equal(ds.inactive_source.covered, true);
  assert.equal(ds.inactive_source.source, ESPN_ZERO_SOURCE);
});

test('an ESPN-Out starter at 0 is flagged Out, not inactive (no double flag on the card)', () => {
  const mine = roster([player('Out Zero Starter', 'WR', 'WR', 0, { espn: 'OUT', prior: 12, now: 0 })]);
  mine.splice(mine.findIndex(p => p.asset.name === 'Wideout Two'), 1);
  const id = league(mine);
  const items = lineupCall(id, { providers: {}, now: NOW }).dead_starters.items;
  const his = items.filter(i => i.player.name === 'Out Zero Starter');
  assert.equal(his.length, 1);
  assert.equal(his[0].reason, 'out');
});

test('no snapshot for the week: the hook says it is not covered, and nothing is flagged', () => {
  const mine = roster([player('Zeroed Starter', 'WR', 'WR', 0, { prior: 14.2, now: 0 })]);
  const id = league(mine, { snapshots: false });
  const hook = espnZeroInactive(id, { season: 2026, week: 2 });
  assert.equal(hook.covered, false);
  assert.equal(hook.ids.size, 0);
  assert.match(hook.reason, /league_roster_snapshots/);
  const ds = lineupCall(id, { providers: {}, now: NOW }).dead_starters;
  assert.equal(ds.inactive_source.covered, false);
  assert.equal(byName(ds)['Zeroed Starter'], undefined);
});

test('a caller-supplied hook still wins over the ESPN-zero default', () => {
  const mine = roster([player('Zeroed Starter', 'WR', 'WR', 0, { prior: 14.2, now: 0 })]);
  const id = league(mine);
  const ds = lineupCall(id, { providers: {}, now: NOW,
    inactive: { covered: true, source: 'fixture', reason: null, ids: new Set() } }).dead_starters;
  assert.equal(ds.inactive_source.source, 'fixture');
  assert.equal(byName(ds)['Zeroed Starter'], undefined);
});

test('default-off: without GRIDIRON_ESPN_ZERO_INACTIVE=1 nothing is flagged and the source says "unconfirmed forward"', () => {
  const mine = roster([player('Zeroed Starter', 'WR', 'WR', 0, { prior: 14.2, now: 0 })]);
  mine.splice(mine.findIndex(p => p.asset.name === 'Wideout Two'), 1);
  const id = league(mine);
  const saved = process.env.GRIDIRON_ESPN_ZERO_INACTIVE;
  delete process.env.GRIDIRON_ESPN_ZERO_INACTIVE;
  try {
    const hook = espnZeroInactive(id, { season: 2026, week: 2 });
    assert.equal(hook.covered, false);
    assert.equal(hook.ids.size, 0);
    assert.match(hook.reason, /unconfirmed forward/);
    const out = lineupCall(id, { providers: {}, now: NOW });
    assert.equal(byName(out.dead_starters)['Zeroed Starter'], undefined);
    assert.equal(out.dead_starters.inactive_source.covered, false);
    assert.match(out.dead_starters.inactive_source.reason, /unconfirmed forward/);
  } finally {
    process.env.GRIDIRON_ESPN_ZERO_INACTIVE = saved;
  }
});

test('one number: a starter the card calls inactive is not in the solver lineup or warnings, and is listed as unavailable', () => {
  const mine = roster([player('Zeroed Star', 'WR', 'WR', 30, { prior: 14.2, now: 0 }),
    player('Zeroed Depth', 'RB', 'BENCH', 3, { prior: 6, now: 0 })]);
  mine.splice(mine.findIndex(p => p.asset.name === 'Wideout Two'), 1);
  const id = league(mine);
  const out = lineupCall(id, { providers: {}, now: NOW });
  assert.equal(byName(out.dead_starters)['Zeroed Star']?.reason, 'inactive', 'the card flags him');
  assert.ok(!out.lineup.some(c => c.player.name === 'Zeroed Star'), 'the solver does not start him');
  assert.ok(!out.bench.some(b => b.name === 'Zeroed Star'), 'nor offers him from the bench');
  assert.ok(!(out.warnings ?? []).some(w => w.player === 'Zeroed Star'), 'nor warns about him');
  const u = (out.unavailable ?? []).find(x => x.name === 'Zeroed Star');
  assert.ok(u, 'named in unavailable, which the page lists as not considered');
  assert.match(u.why, /ESPN projects 0: likely inactive/);
  assert.ok((out.unavailable ?? []).some(x => x.name === 'Zeroed Depth'),
    'a flagged player is named even when his season average is low (the page says why he is not considered)');
});

test('the source label states the precision of the population the card shows (Friday Questionable/undesignated), not all zeros', () => {
  assert.doesNotMatch(ESPN_ZERO_LABEL, /90%/);
  assert.match(ESPN_ZERO_LABEL, /87%/);
  assert.match(ESPN_ZERO_LABEL, /Questionable or undesignated/);
  assert.match(ESPN_ZERO_LABEL, /unconfirmed forward/);
});
