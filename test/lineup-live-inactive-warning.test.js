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
function player(name, position, week, { prob = 0.85, slot = 20, espn = 'QUESTIONABLE' } = {}) {
  const id = nextId++;
  run('INSERT INTO players (id, name, position, team_id) VALUES (?,?,?,911)', id, name, position);
  return {
    asset: { id, name, position, team_abbr: 'NOY', espn_id: 90000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week, ceiling: week * 1.5, floor: week * 0.4,
      active_probability: prob, bye: 9 },
    entry: { lineupSlotId: slot,
      playerPoolEntry: { player: { id: 90000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: espn } } }
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
// FIX-184-5c: `backProb` below 0.75 puts Questionable Back in the probability/bye `risky`
// list too, so test 1's one-warning-per-starter assert fails if the de-dup breaks (at 0.85,
// the default, it could not: there was nothing to duplicate).
const roster = (tag = '', { backProb = 0.85 } = {}) => [
  player(`Starter Quarterback${tag}`, 'QB', 21), player(`Backup Quarterback${tag}`, 'QB', 12),
  player(`Questionable Back${tag}`, 'RB', 16, { prob: backProb }), player(`Back Two${tag}`, 'RB', 13), player(`Back Three${tag}`, 'RB', 8),
  player(`Wideout One${tag}`, 'WR', 15), player(`Wideout Two${tag}`, 'WR', 12), player(`Wideout Three${tag}`, 'WR', 9),
  player(`Tight End${tag}`, 'TE', 9)
];
const post = (text, rkey, time) => ({ $type: 'message', payload: {
  $type: 'network.bsky.jetstream.subscribeEvents#commit', did: 'did:plc:lbe3b7ce6n7oa6cbl5jwoifo',
  seq: 1, time, operation: 'create', collection: 'app.bsky.feed.post', rkey,
  record: { $type: 'app.bsky.feed.post', text, createdAt: time } } });

// Rule (b): the warning ships default-off until the W3-W5 forward test passes, so the
// two tests below turn it on explicitly and the third pins the default.
test('a starter in a pre-kickoff inactive post is flagged before kickoff', (t) => {
  process.env.LIVE_INACTIVE_WARNINGS = '1';
  t.after(() => { delete process.env.LIVE_INACTIVE_WARNINGS; });
  const id = league(roster('', { backProb: 0.6 }), 9301);
  monitor?.ingestJetstreamEvent(post('Saints RB Questionable Back (ankle) is officially inactive for Week 3.', 'li1', '2026-09-27T15:31:00Z'),
    { season: 2026, week: 3 });
  const call = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(call.error);
  assert.ok(call.lineup.some(c => c.player.name === 'Questionable Back'),
    'fixture: he is a starter, and at 0.6 to play he would also get the probability warning without the de-dup');
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

test('no claim, or a later active claim, means no live warning (control)', (t) => {
  process.env.LIVE_INACTIVE_WARNINGS = '1';
  t.after(() => { delete process.env.LIVE_INACTIVE_WARNINGS; });
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

test('default off: without LIVE_INACTIVE_WARNINGS=1 the claim is recorded but no live warning is shown', () => {
  delete process.env.LIVE_INACTIVE_WARNINGS;
  const id = league(roster(' Cee'), 9303);
  monitor?.ingestJetstreamEvent(post('Saints RB Questionable Back Cee is inactive.', 'li4', '2026-09-27T15:05:00Z'), { season: 2026, week: 3 });
  assert.ok(monitor?.liveInactiveClaims({ season: 2026, week: 3 }).size > 0, 'known-nonzero control: the listener still recorded him');
  const off = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(off.error);
  assert.equal(off.warnings.some(x => x.kind === 'live_inactive'), false, 'unconfirmed forward: off by default');
  process.env.LIVE_INACTIVE_WARNINGS = '1';
  try {
    const on = lineupCall(id, { objective: 'mean', providers: {} });
    assert.ok(on.warnings.some(x => x.player === 'Questionable Back Cee' && x.kind === 'live_inactive'), 'the flag turns it on');
  } finally { delete process.env.LIVE_INACTIVE_WARNINGS; }
});

// FIX-184-2: the SS-01 dead-starter guard and the Start/Sit warning read ONE inactive set.
// Before, the guard's `inactive` hook had only espn-zero-inactive.js, so a starter SET on
// ESPN with a pre-kickoff inactive post and no Friday designation got a Start/Sit warning
// and no dead-starter card.
test('FIX-184-2: a starter set on ESPN with a pre-kickoff inactive claim and no designation gets a dead-starter alert', (t) => {
  process.env.LIVE_INACTIVE_WARNINGS = '1';
  t.after(() => { delete process.env.LIVE_INACTIVE_WARNINGS; });
  const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23 };
  const mine = [
    player('Starter Quarterback Dee', 'QB', 21, { slot: SLOT.QB, espn: 'ACTIVE' }),
    player('Back One Dee', 'RB', 16, { slot: SLOT.RB, espn: 'ACTIVE' }), player('Back Two Dee', 'RB', 13, { slot: SLOT.RB, espn: 'ACTIVE' }),
    player('Wideout One Dee', 'WR', 15, { slot: SLOT.WR, espn: 'ACTIVE' }), player('Wideout Two Dee', 'WR', 12, { slot: SLOT.WR, espn: 'ACTIVE' }),
    player('Tight End Dee', 'TE', 9, { slot: SLOT.TE, espn: 'ACTIVE' }), player('Back Three Dee', 'RB', 8, { slot: SLOT.FLEX, espn: 'ACTIVE' }),
    player('Wideout Three Dee', 'WR', 9, { espn: 'ACTIVE' })
  ];
  const id = league(mine, 9304);
  const quiet = lineupCall(id, { objective: 'mean', providers: {} });
  assert.equal(quiet.dead_starters.items.length, 0, 'control: no claim, no designation, nothing flagged');

  monitor?.ingestJetstreamEvent(post('Saints WR Wideout One Dee is inactive.', 'li5', '2026-09-27T15:10:00Z'), { season: 2026, week: 3 });
  const call = lineupCall(id, { objective: 'mean', providers: {} });
  const item = call.dead_starters.items.find(i => i.player.name === 'Wideout One Dee');
  assert.ok(item, `no dead-starter alert; items = ${JSON.stringify(call.dead_starters.items)}`);
  assert.equal(item.reason, 'inactive');
  assert.equal(item.source, 'live_inactive_claims');
  assert.match(item.why, /rotoworld-fb\.bsky\.social/, 'the card names the post source');
  assert.equal(item.replacement?.name, 'Wideout Three Dee');
  assert.equal(call.dead_starters.inactive_source.covered, true);
  assert.ok(call.warnings.some(w => w.player === 'Wideout One Dee' && w.kind === 'live_inactive'),
    'the Start/Sit warning names the same player from the same set');

  delete process.env.LIVE_INACTIVE_WARNINGS;
  const off = lineupCall(id, { objective: 'mean', providers: {} });
  assert.equal(off.dead_starters.items.some(i => i.player.name === 'Wideout One Dee'), false, 'default-off: the card is off too');
});

// FIX-184-3: preview mode turns the warning on and labels it, like every converted site.
test('FIX-184-3: preview mode turns the live warning on, stamped preview / preview_reason', (t) => {
  delete process.env.LIVE_INACTIVE_WARNINGS;
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  t.after(() => { if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved; });
  const id = league(roster(' Eff'), 9305);
  monitor?.ingestJetstreamEvent(post('Saints RB Questionable Back Eff is inactive.', 'li6', '2026-09-27T15:12:00Z'), { season: 2026, week: 3 });
  const call = lineupCall(id, { objective: 'mean', providers: {} });
  const w = call.warnings.find(x => x.player === 'Questionable Back Eff' && x.kind === 'live_inactive');
  assert.ok(w, 'preview mode turns the warning on');
  assert.equal(w.preview, true);
  assert.match(w.preview_reason, /default-off, unconfirmed forward/);
});
