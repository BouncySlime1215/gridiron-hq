/**
 * SS-01-F1 contract: one producer of "a starter who will score zero this week".
 *
 * The League Hub card (trade-engine.js#lineupDiff `flagged_starters`), the Start/Sit tab
 * (lineup-brain.js#lineupCall `dead_starters`) and the stored manager signal
 * (manager-signals.js#rosterSignals `lineup_dead_starters`) all read dead-starters.js.
 * On the 2026-W3 local copy the first two disagreed (League Hub 0, Start/Sit 2: Doubtful QBs).
 *
 * Fixtures follow test/dead-starter-guard.test.js: the asset universe is mocked; roster
 * loading, slot rules and the kickoff lookup are real, and lineupDiff is the real one.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-dead-one-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';
process.env.NFL_SEASON = '2026';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');

let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 2 })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

const { lineupCall } = await import('../server/services/lineup-brain.js');
const deadMod = await import('../server/services/dead-starters.js');
const signalsMod = await import('../server/services/manager-signals.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, BENCH: 20, IR: 21 };
let nextId = 1;
function player(name, position, slot, week, { espn = 'ACTIVE', report = null, bye = 9, team = 'MID', available = true, adj = week } = {}) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: team, espn_id: 9000 + id, available,
      current_week_ppg: bye === 2 ? 0 : week, adj_ppg: adj, ppg: adj, ros_ppg: adj,
      ceiling: week * 1.5, floor: week * 0.4, active_probability: 0.9, bye, injury_status: report
    },
    entry: {
      lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: espn } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 950;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'One producer', '1', 10, 1, ?, ?)`,
  id, `one-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}
const leagueRow = id => rows('SELECT * FROM leagues WHERE id = ?', id)[0];
const NOW = Date.parse('2026-09-20T12:00:00Z');

/** Every dead-starter reason at once, plus a bench deep enough to replace each. */
function everyKindOfDead() {
  return [
    player('Doubtful Passer', 'QB', 'QB', 20, { report: 'Doubtful' }),
    player('Out Back', 'RB', 'RB', 15, { espn: 'OUT' }),
    player('Season Gone Back', 'RB', 'RB', 12, { available: false }),
    player('Bye Wideout', 'WR', 'WR', 14, { bye: 2 }),
    player('Healthy Wideout', 'WR', 'WR', 11),
    player('Suspended End', 'TE', 'TE', 8, { espn: 'SUSPENSION' }),
    player('IR Status Flex', 'WR', 'FLEX', 9, { espn: 'INJURY_RESERVE' }),
    // bench
    player('Bench Passer', 'QB', 'BENCH', 16),
    player('Bench Back', 'RB', 'BENCH', 10),
    // Higher season value, lower this week: a surface ranking on adj_ppg would pick him.
    player('Bench Back Two', 'RB', 'BENCH', 9.5, { adj: 30 }),
    player('Bench Wideout', 'WR', 'BENCH', 7),
    player('Bench Wideout Two', 'WR', 'BENCH', 6),
    player('Bench End', 'TE', 'BENCH', 5)
  ];
}

const shape = list => list.map(x => ({ id: x.id, reason: x.reason, slot: x.slot, replacement: x.replacement ?? null }))
  .sort((a, b) => a.id - b.id);

test('RED contract: League Hub flagged_starters and Start/Sit dead_starters name the same dead starters for the same roster', () => {
  const id = league(everyKindOfDead());
  const sit = lineupCall(id, { providers: {}, now: NOW });
  assert.ifError(sit.error);
  const hub = realTradeEngine.lineupDiff(leagueRow(id), '1', { assets, now: NOW });
  assert.ifError(hub.error);

  const sitItems = sit.dead_starters.items.map(i => ({ id: i.player.id, reason: i.reason, slot: i.slot,
    replacement: i.replacement?.id ?? null }));
  const hubItems = hub.flagged_starters.map(f => ({ id: f.id, reason: f.dead_reason, slot: f.slot,
    replacement: f.replacement?.id ?? null }));
  // Known-nonzero: every one of the six dead starters is found by Start/Sit.
  assert.equal(sitItems.length, 6, 'Start/Sit finds all six dead starters');
  assert.deepEqual(shape(hubItems), shape(sitItems), 'League Hub names the same players, reasons, slots and replacements');
  const doubtfulQb = hub.flagged_starters.find(f => f.position === 'QB');
  assert.equal(doubtfulQb?.dead_reason, 'doubtful', 'the Doubtful QB the live W3 card missed is on the League Hub card');
});

test('the League Hub keeps the fields MyTeam.tsx reads (reason text, espn_status, espn_disagrees)', () => {
  const id = league(everyKindOfDead());
  const hub = realTradeEngine.lineupDiff(leagueRow(id), '1', { assets, now: NOW });
  const gone = hub.flagged_starters.find(f => f.name === 'Season Gone Back');
  assert.equal(gone.reason, 'flagged out for the season or released');
  assert.equal(gone.espn_status, 'ACTIVE');
  assert.equal(gone.espn_disagrees, true, 'news scan says out, ESPN says active: check before benching');
  assert.equal(hub.flagged_starters.find(f => f.name === 'Out Back').espn_disagrees, false);
  assert.match(hub.flagged_starters.find(f => f.name === 'Out Back').why, /Start Bench Back instead/);
});

test('a starter whose game has kicked off is on neither surface', () => {
  const id = league(everyKindOfDead());
  // Every game started: nothing can be swapped, so nothing is flagged on either page.
  run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 2, 'MID', '2026-09-20', '13:00')`);
  try {
    const later = Date.parse('2026-09-20T18:00:00Z');
    const sit = lineupCall(id, { providers: {}, now: later }).dead_starters.items;
    const hub = realTradeEngine.lineupDiff(leagueRow(id), '1', { assets, now: later }).flagged_starters;
    assert.equal(sit.length, 0);
    assert.equal(hub.length, 0);
    // Control, same rows: before the 1 pm kickoff both surfaces flag all six. The instant
    // comes from the caller (`now`), not the wall clock, on both.
    const before = Date.parse('2026-09-20T16:00:00Z');
    assert.equal(lineupCall(id, { providers: {}, now: before }).dead_starters.items.length, 6);
    assert.equal(realTradeEngine.lineupDiff(leagueRow(id), '1', { assets, now: before }).flagged_starters.length, 6);
  } finally {
    run(`DELETE FROM game_lines WHERE season = 2026 AND week = 2 AND team = 'MID'`);
  }
});

test('manager-signals counts dead starters through the same producer: SUSPENSION counts, QUESTIONABLE does not', () => {
  const mine = [
    player('Sig Out', 'RB', 'RB', 10, { espn: 'OUT' }),
    player('Sig Suspended', 'WR', 'WR', 10, { espn: 'SUSPENSION' }),
    player('Sig Doubtful', 'TE', 'TE', 10, { espn: 'DOUBTFUL' }),
    player('Sig IR', 'WR', 'FLEX', 10, { espn: 'INJURY_RESERVE' }),
    player('Sig Questionable', 'QB', 'QB', 10, { espn: 'QUESTIONABLE' }),
    player('Sig Bench Out', 'RB', 'BENCH', 10, { espn: 'OUT' })
  ];
  const payload = { teams: [{ id: 1, roster: { entries: mine.map(p => p.entry) } }] };
  assert.equal(typeof signalsMod.rosterSignals, 'function', 'rosterSignals is exported for this contract');
  const metric = signalsMod.rosterSignals(payload, 1).find(s => s.metric === 'lineup_dead_starters');
  assert.equal(metric.value, 4, 'OUT, SUSPENSION, DOUBTFUL, INJURY_RESERVE starters; not QUESTIONABLE, not the bench');
  for (const status of ['OUT', 'SUSPENSION', 'DOUBTFUL', 'INJURY_RESERVE', 'QUESTIONABLE', 'ACTIVE']) {
    const viaProducer = deadMod.deadReason({ id: 1 }, { week: null, espnStatus: status }) != null;
    assert.equal(deadMod.espnDeadReason(status) != null, viaProducer, `${status}: the signal's rule is deadReason's rule`);
  }
});

test('the card text rounds the replacement projection to one decimal', () => {
  const mine = [player('Round Out', 'RB', 'RB', 10, { espn: 'OUT' }), player('Round Bench', 'RB', 'BENCH', 10.3749)];
  const id = league(mine);
  const sit = lineupCall(id, { providers: {}, now: NOW }).dead_starters.items[0];
  assert.match(sit.why, /\(10\.4 projected\)/);
  assert.equal(sit.replacement.week_points, 10.37, 'the payload number keeps its precision; only the sentence rounds');
});
