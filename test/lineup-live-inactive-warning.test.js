/**
 * RL-3-2 acceptance: a starter named in a live pre-kickoff inactive post raises a
 * Start/Sit "Check before kickoff" warning.
 *
 * Before this unit the page's warnings came only from active_probability < 0.75 or a
 * bye. A starter who was Questionable on Friday (active_probability 0.85 here) and then
 * declared inactive at T-90 got nothing, because main had no live inactive source (the
 * only one, nflverse weekly rosters, posts after the week).
 *
 * Fixtures follow test/lineup-floor-objective.test.js: the asset universe is mocked;
 * the solver, roster loading, the monitor's parser and the claim table are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-live-inactive-lineup-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '3';

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
    tradeWeekContext: () => ({ season: 2026, week: 3 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

const { lineupCall } = await import('../server/services/lineup-brain.js');
// Absent before this unit. Only a missing module is tolerated, so the RED run fails on
// the warning assertion (today's behaviour) rather than on the import.
let monitor = null;
try { monitor = await import('../server/services/live-inactive-monitor.js'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (911, 'NOY', 'New Orleans Saints', 'NFC', 'South')`);
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 7101;
function player(name, position, week) {
  const id = nextId++;
  run('INSERT INTO players (id, name, position, team_id) VALUES (?,?,?,911)', id, name, position);
  return {
    asset: { id, name, position, team_abbr: 'NOY', espn_id: 90000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week, ceiling: week * 1.5, floor: week * 0.4,
      active_probability: 0.85, bye: 9 },
    entry: { lineupSlotId: 20,
      playerPoolEntry: { player: { id: 90000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'QUESTIONABLE' } } }
  };
}
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
function league(mine, id) {
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Live inactive', '1', 10, 1, ?, ?)`, id, `li-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}
// Names are unique per league (a shared name would be refused as ambiguous, by design).
const roster = (tag = '') => [
  player(`Starter Quarterback${tag}`, 'QB', 21), player(`Backup Quarterback${tag}`, 'QB', 12),
  player(`Questionable Back${tag}`, 'RB', 16), player(`Back Two${tag}`, 'RB', 13), player(`Back Three${tag}`, 'RB', 8),
  player(`Wideout One${tag}`, 'WR', 15), player(`Wideout Two${tag}`, 'WR', 12), player(`Wideout Three${tag}`, 'WR', 9),
  player(`Tight End${tag}`, 'TE', 9)
];
const post = (text, rkey, time) => ({ $type: 'message', payload: {
  $type: 'network.bsky.jetstream.subscribeEvents#commit', did: 'did:plc:lbe3b7ce6n7oa6cbl5jwoifo',
  seq: 1, time, operation: 'create', collection: 'app.bsky.feed.post', rkey,
  record: { $type: 'app.bsky.feed.post', text, createdAt: time } } });

test('a starter in a pre-kickoff inactive post is flagged before kickoff', () => {
  const id = league(roster(), 9301);
  monitor?.ingestJetstreamEvent(post('Saints RB Questionable Back (ankle) is officially inactive for Week 3.', 'li1', '2026-09-27T15:31:00Z'),
    { season: 2026, week: 3 });
  const call = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(call.error);
  assert.ok(call.lineup.some(c => c.player.name === 'Questionable Back'), 'fixture: he is a starter (0.85 to play, no probability warning)');
  const w = call.warnings.find(x => x.player === 'Questionable Back');
  assert.ok(w, `no warning for the inactive starter; warnings = ${JSON.stringify(call.warnings)}`);
  assert.equal(w.kind, 'live_inactive');
  assert.match(w.issue, /inactive/i);
  assert.match(w.issue, /rotoworld-fb\.bsky\.social/, 'names its source');
  assert.equal(w.issue.endsWith('.'), false, 'the page appends the full stop');
  assert.match(w.source_url, /^https:\/\/bsky\.app\/profile\/did:plc:lbe3b7ce6n7oa6cbl5jwoifo\/post\/li1$/, 'links out, no post text');
  assert.equal(w.reported_at, '2026-09-27T15:31:00Z');
  assert.match(w.issue, /at Sun 11:31 AM ET/, 'a plain Eastern clock time, not an ISO stamp');
  assert.equal(w.confirmation, 'unconfirmed forward');
  assert.equal(call.warnings.filter(x => x.player === 'Questionable Back').length, 1, 'one warning per starter');
});

test('no claim, or a later active claim, means no live warning (control)', () => {
  const id = league(roster(' Bee'), 9302);
  const quiet = lineupCall(id, { objective: 'mean', providers: {} });
  assert.equal(quiet.warnings.some(x => x.kind === 'live_inactive'), false, 'nothing posted, nothing flagged');

  monitor?.ingestJetstreamEvent(post('Saints WR Wideout One Bee is inactive.', 'li2', '2026-09-27T15:00:00Z'), { season: 2026, week: 3 });
  const flagged = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ok(flagged.warnings.some(x => x.player === 'Wideout One Bee' && x.kind === 'live_inactive'),
    'known-nonzero control: the inactive claim alone flags him');
  monitor?.ingestJetstreamEvent(post('Correction: Saints WR Wideout One Bee is active.', 'li3', '2026-09-27T15:20:00Z'), { season: 2026, week: 3 });
  const after = lineupCall(id, { objective: 'mean', providers: {} });
  assert.equal(after.warnings.some(x => x.player === 'Wideout One Bee' && x.kind === 'live_inactive'), false, 'the later active claim wins');
});
