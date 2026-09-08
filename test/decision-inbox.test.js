import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated-DB pattern shared with the other suites (see test/props-saved-tickets.test.js,
// test/evidence-dataset.test.js) — a fresh temp SQLite file with migrations run against
// it, never the real server/data.sqlite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-inbox-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const applied = await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();

// Side-effect imports: assetUniverse() (trade-engine.js) reads tables created
// ad-hoc at import time by these route files, exactly like test/post-draft-plan.test.js.
await import('../server/routes/stats.js');       // player_season_stats
await import('../server/routes/aggregates.js');  // player_metrics
await import('../server/routes/tradelab.js');    // trending_players
await import('../server/routes/nfldata.js');     // roster_players

const { default: decisionInboxRouter, publishRecommendation } = await import('../server/routes/decision-inbox.js');
const { lineupDiff } = await import('../server/services/trade-engine.js');
const { waiverUpgrades } = await import('../server/services/waiver-brain.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/decision-inbox', decisionInboxRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/decision-inbox`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('020_decision_recommendations ran and created the table', () => {
  assert.ok(applied.includes('020_decision_recommendations'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='decision_recommendations'`));
});

/* ------------------------------------------------------------- basic CRUD */

test('a fresh install has no open recommendations', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

const post = body => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('publishing a recommendation over HTTP persists it and echoes the shape the client expects', async () => {
  const res = await post({
    dedupKey: 'test:trade:1', sport: 'NFL', type: 'trade', title: 'Sell high on Player X',
    rationale: 'Market value is diverging from role.', urgency: 'medium',
    sourceModel: 'trade-engine', link: '/trade-lab'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'Sell high on Player X');
  assert.equal(body.status, 'open');
  assert.equal(body.urgency, 'medium');
  assert.deepEqual(body.subjectIds, []);
});

test('rejects a publish missing required fields', async () => {
  const noTitle = await post({ dedupKey: 'x', sport: 'NFL', type: 'trade', sourceModel: 'x' });
  assert.equal(noTitle.status, 400);
  const badSport = await post({ dedupKey: 'x', sport: 'NHL', type: 'trade', title: 'x', sourceModel: 'x' });
  assert.equal(badSport.status, 400);
  const noDedup = await post({ sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x' });
  assert.equal(noDedup.status, 400);
});

test('an invalid urgency value falls back to medium rather than rejecting the publish', async () => {
  const res = await post({ dedupKey: 'test:urgency', sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x', urgency: 'critical' });
  const body = await res.json();
  assert.equal(body.urgency, 'medium');
});

test('list is sorted by urgency first, then soonest expiry', async () => {
  await run('DELETE FROM decision_recommendations');
  const soon = new Date(Date.now() + 3600 * 1000).toISOString();
  const later = new Date(Date.now() + 7200 * 1000).toISOString();
  await post({ dedupKey: 'a', sport: 'NFL', type: 'x', title: 'low urgency', sourceModel: 'x', urgency: 'low' });
  await post({ dedupKey: 'b', sport: 'NFL', type: 'x', title: 'high, expires later', sourceModel: 'x', urgency: 'high', expiresAt: later });
  await post({ dedupKey: 'c', sport: 'NFL', type: 'x', title: 'high, expires soon', sourceModel: 'x', urgency: 'high', expiresAt: soon });
  await post({ dedupKey: 'd', sport: 'NFL', type: 'x', title: 'medium', sourceModel: 'x', urgency: 'medium' });

  const list = await (await fetch(base)).json();
  assert.deepEqual(list.map(r => r.title), [
    'high, expires soon', 'high, expires later', 'medium', 'low urgency'
  ]);
});

test('publishing the same dedupKey again refreshes the open row instead of duplicating it', async () => {
  await run('DELETE FROM decision_recommendations');
  const first = await (await post({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v1', sourceModel: 'x', expectedValue: 1 })).json();
  const second = await (await post({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v2', sourceModel: 'x', expectedValue: 2 })).json();
  assert.equal(second.id, first.id, 'same dedup key while open must update in place, not create a new id');

  const list = await (await fetch(base)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'v2');
  assert.equal(list[0].expectedValue, 2);
});

test('resolving with dedupKey still open lets a later publish reopen a fresh row', async () => {
  const opened = await (await post({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'first occurrence', sourceModel: 'x' })).json();
  await fetch(`${base}/${opened.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'actioned' }) });

  const reopened = await (await post({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'second occurrence', sourceModel: 'x' })).json();
  assert.notEqual(reopened.id, opened.id, 'a resolved recommendation must not be silently reopened/overwritten');

  const resolvedRow = await (await fetch(base)).json(); // only open rows list
  assert.equal(resolvedRow.filter(r => r.id === opened.id).length, 0, 'the actioned row must not appear in the open list');
});

test('resolve requires a real recommendation id', async () => {
  const res = await fetch(`${base}/does-not-exist/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) });
  assert.equal(res.status, 404);
});

test('resolve records outcome and resolved_at, and defaults to dismissed when no status is given', async () => {
  const created = await (await post({ dedupKey: 'resolve-outcome', sport: 'NFL', type: 'x', title: 'x', sourceModel: 'x' })).json();
  const res = await fetch(`${base}/${created.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'user ignored it' }) });
  const body = await res.json();
  assert.equal(body.status, 'dismissed');
  assert.equal(body.outcome, 'user ignored it');
  assert.ok(body.resolvedAt);
});

test('summary counts open recommendations by urgency', async () => {
  await run('DELETE FROM decision_recommendations');
  await post({ dedupKey: 's1', sport: 'NFL', type: 'x', title: 'x', sourceModel: 'x', urgency: 'high' });
  await post({ dedupKey: 's2', sport: 'NFL', type: 'x', title: 'x', sourceModel: 'x', urgency: 'high' });
  await post({ dedupKey: 's3', sport: 'NFL', type: 'x', title: 'x', sourceModel: 'x', urgency: 'low' });
  const summary = await (await fetch(`${base}/summary`)).json();
  assert.deepEqual(summary, { total: 3, high: 2, medium: 0, low: 1 });
});

test('a recommendation past its expiry is lazily marked expired and drops out of the open list/summary', async () => {
  await run('DELETE FROM decision_recommendations');
  publishRecommendation({
    dedupKey: 'expired-1', sport: 'NFL', type: 'x', title: 'stale by now', sourceModel: 'x',
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  const list = await (await fetch(base)).json();
  assert.equal(list.length, 0);
  const stored = row(`SELECT status FROM decision_recommendations WHERE dedup_key = 'expired-1'`);
  assert.equal(stored.status, 'expired');
});

/* ---------------------------------------------- wired-in engine #1: lineup */
// server/services/trade-engine.js's lineupDiff() — "Start Player A over Player B"
// is the audit's own lead Decision Inbox example.

function fakeQb(id, espnId, name) { return { lineupSlotId: 0, playerPoolEntry: { player: { id: espnId, fullName: name, defaultPositionId: 1 } } }; }
function fakeRb(espnId, name, slot) { return { lineupSlotId: slot, playerPoolEntry: { player: { id: espnId, fullName: name, defaultPositionId: 2 } } }; }
function fakeWr(espnId, name) { return { lineupSlotId: 4, playerPoolEntry: { player: { id: espnId, fullName: name, defaultPositionId: 3 } } }; }
function fakeTe(espnId, name) { return { lineupSlotId: 6, playerPoolEntry: { player: { id: espnId, fullName: name, defaultPositionId: 4 } } }; }

function insertLeague(leagueId, payload, rosterPositions) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Decision Inbox Test League', ?, 2, '1', ?, 'x', 'y', 'connected')`,
    leagueId, `decision-inbox-${leagueId}`, JSON.stringify(payload), JSON.stringify(rosterPositions));
}

test('lineupDiff() publishes a "start X over Y" recommendation when a real gap exists, and does not change its own return value', async () => {
  await run('DELETE FROM decision_recommendations');
  await run('DELETE FROM player_season_stats');

  const [strong, weak] = rows(`SELECT id, name FROM players WHERE position = 'RB' AND fantasy_relevant = 1 ORDER BY id LIMIT 2`);
  const qb = row(`SELECT id, name FROM players WHERE position = 'QB' AND fantasy_relevant = 1 LIMIT 1`);
  const wr = row(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 LIMIT 1`);
  const te = row(`SELECT id, name FROM players WHERE position = 'TE' AND fantasy_relevant = 1 LIMIT 1`);

  // A real, large, controlled projection gap driven through the actual pipeline
  // (assetUniverse reads player_season_stats — see server/routes/edge.js's
  // vorBoard) rather than mocked, so this exercises the real lineupDiff() code.
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',300,17)`, strong.id);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',50,17)`, weak.id);
  // lineupDiff() matches the ESPN submitted-roster entries by players.espn_id,
  // separately from loadRosters()'s own name+position fallback matching.
  for (const [id, espnId] of [[qb.id, 8001], [weak.id, 8002], [wr.id, 8003], [te.id, 8004], [strong.id, 8005]]) {
    run('UPDATE players SET espn_id = ? WHERE id = ?', espnId, id);
  }

  insertLeague(201, {
    teams: [{
      id: 1, name: 'My Team',
      roster: { entries: [
        fakeQb(qb.id, 8001, qb.name),
        fakeRb(8002, weak.name, 2),   // started at RB — the weaker of the two
        fakeWr(8003, wr.name),
        fakeTe(8004, te.name),
        fakeRb(8005, strong.name, 20) // benched (lineupSlotId 20 = BENCH) despite being much stronger
      ] }
    }]
  }, ['QB', 'RB', 'WR', 'TE']);

  const lg = row('SELECT * FROM leagues WHERE id = 201');
  const diff = lineupDiff(lg, '1');

  // Existing return contract is untouched — this is the "additive only" check.
  assert.equal(diff.matches, false);
  assert.equal(diff.swap_in[0].player.name, strong.name);
  assert.equal(diff.swap_out[0].name, weak.name);
  assert.ok(diff.gain > 1, `expected a real gain, got ${diff.gain}`);

  const list = await (await fetch(base)).json();
  const reco = list.find(r => r.type === 'lineup' && r.leagueId === 201);
  assert.ok(reco, 'lineupDiff() must publish a decision_recommendations row for a real swap');
  assert.equal(reco.title, `Start ${strong.name} over ${weak.name}`);
  assert.equal(reco.sourceModel, 'lineup-brain');
  assert.equal(reco.link, '/lineup');
  assert.deepEqual(reco.subjectIds.sort(), [strong.id, weak.id].sort());
  assert.equal(reco.urgency, 'high', 'an 11+ point gain should be urgency high (>= 4pt threshold)');

  // Recomputing (e.g. the page reloading) must refresh the same row, not spam a duplicate.
  lineupDiff(lg, '1');
  const listAgain = await (await fetch(base)).json();
  assert.equal(listAgain.filter(r => r.type === 'lineup' && r.leagueId === 201).length, 1, 're-running lineupDiff() must not duplicate the open recommendation');
});

test('lineupDiff() does not publish when the submitted lineup already matches optimal', async () => {
  await run('DELETE FROM decision_recommendations');
  await run('DELETE FROM player_season_stats');

  const [rb1, rb2] = rows(`SELECT id, name FROM players WHERE position = 'RB' AND fantasy_relevant = 1 ORDER BY id LIMIT 2`);
  const qb = row(`SELECT id, name FROM players WHERE position = 'QB' AND fantasy_relevant = 1 LIMIT 1`);
  const wr = row(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 LIMIT 1`);
  const te = row(`SELECT id, name FROM players WHERE position = 'TE' AND fantasy_relevant = 1 LIMIT 1`);
  for (const [id, espnId] of [[qb.id, 8101], [rb1.id, 8102], [wr.id, 8103], [te.id, 8104]]) {
    run('UPDATE players SET espn_id = ? WHERE id = ?', espnId, id);
  }
  // rb2 stays on the bench and un-projected (adj_ppg 0) so it can never outrank
  // the starting rb1 — no real gap exists for the optimizer to find.
  run('UPDATE players SET espn_id = ? WHERE id = ?', 8105, rb2.id);

  insertLeague(202, {
    teams: [{
      id: 1, name: 'My Team',
      roster: { entries: [
        fakeQb(qb.id, 8101, qb.name),
        fakeRb(8102, rb1.name, 2),
        fakeWr(8103, wr.name),
        fakeTe(8104, te.name),
        fakeRb(8105, rb2.name, 20)
      ] }
    }]
  }, ['QB', 'RB', 'WR', 'TE']);

  const lg = row('SELECT * FROM leagues WHERE id = 202');
  lineupDiff(lg, '1');
  const list = await (await fetch(base)).json();
  assert.equal(list.filter(r => r.leagueId === 202).length, 0, 'no swap worth recommending should publish nothing');
});

/* ---------------------------------------------- wired-in engine #2: waiver */
// server/services/waiver-brain.js's waiverUpgrades() — "Add a free-agent RB
// before waivers process" is the audit's own lead waiver example.

test('waiverUpgrades() publishes an "add before waivers process" recommendation for a real upgrade, and does not change its own return value', async () => {
  await run('DELETE FROM decision_recommendations');
  await run('DELETE FROM player_season_stats');

  const [strong, weak] = rows(`SELECT id, name FROM players WHERE position = 'RB' AND fantasy_relevant = 1 ORDER BY id LIMIT 2`);
  const qb = row(`SELECT id, name FROM players WHERE position = 'QB' AND fantasy_relevant = 1 LIMIT 1`);
  const wr = row(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 LIMIT 1`);
  const te = row(`SELECT id, name FROM players WHERE position = 'TE' AND fantasy_relevant = 1 LIMIT 1`);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',300,17)`, strong.id);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',50,17)`, weak.id);

  // `strong` is deliberately left off every roster in this league so
  // freeAgents()/waiverUpgrades() see him as available.
  insertLeague(301, {
    teams: [{
      id: 1, name: 'My Team',
      roster: { entries: [
        { playerPoolEntry: { player: { id: 9201, fullName: qb.name, defaultPositionId: 1 } } },
        { playerPoolEntry: { player: { id: 9202, fullName: weak.name, defaultPositionId: 2 } } },
        { playerPoolEntry: { player: { id: 9203, fullName: wr.name, defaultPositionId: 3 } } },
        { playerPoolEntry: { player: { id: 9204, fullName: te.name, defaultPositionId: 4 } } }
      ] }
    }]
  }, ['QB', 'RB', 'WR', 'TE']);

  const result = waiverUpgrades(301, { myTeamId: '1' });
  assert.ok(result.upgrades.length, 'fixture must produce at least one upgrade');
  assert.equal(result.upgrades[0].player.name, strong.name);
  assert.ok(result.upgrades[0].expected_value > 0.75);

  const list = await (await fetch(base)).json();
  const reco = list.find(r => r.type === 'waiver' && r.leagueId === 301);
  assert.ok(reco, 'waiverUpgrades() must publish a decision_recommendations row for a real upgrade');
  assert.equal(reco.title, `Add ${strong.name} before waivers process`);
  assert.equal(reco.sourceModel, 'waiver-brain');
  assert.equal(reco.link, '/brain');
  assert.equal(reco.urgency, 'high');

  waiverUpgrades(301, { myTeamId: '1' });
  const listAgain = await (await fetch(base)).json();
  assert.equal(listAgain.filter(r => r.type === 'waiver' && r.leagueId === 301).length, 1, 're-running waiverUpgrades() must not duplicate the open recommendation');
});

test('waiverUpgrades() does not publish when no free agent clears the roster', async () => {
  await run('DELETE FROM decision_recommendations');
  await run('DELETE FROM player_season_stats');
  // No player_season_stats rows at all in this league's context -> every
  // asset's adj_ppg is 0, so freeAgents() (which requires adj_ppg > 0) finds nothing.
  const qb = row(`SELECT id, name FROM players WHERE position = 'QB' AND fantasy_relevant = 1 LIMIT 1`);
  const rb = row(`SELECT id, name FROM players WHERE position = 'RB' AND fantasy_relevant = 1 LIMIT 1`);
  const wr = row(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 LIMIT 1`);
  const te = row(`SELECT id, name FROM players WHERE position = 'TE' AND fantasy_relevant = 1 LIMIT 1`);

  insertLeague(302, {
    teams: [{
      id: 1, name: 'My Team',
      roster: { entries: [
        { playerPoolEntry: { player: { id: 9301, fullName: qb.name, defaultPositionId: 1 } } },
        { playerPoolEntry: { player: { id: 9302, fullName: rb.name, defaultPositionId: 2 } } },
        { playerPoolEntry: { player: { id: 9303, fullName: wr.name, defaultPositionId: 3 } } },
        { playerPoolEntry: { player: { id: 9304, fullName: te.name, defaultPositionId: 4 } } }
      ] }
    }]
  }, ['QB', 'RB', 'WR', 'TE']);

  const result = waiverUpgrades(302, { myTeamId: '1' });
  assert.equal(result.upgrades.length, 0);
  const list = await (await fetch(base)).json();
  assert.equal(list.filter(r => r.leagueId === 302).length, 0);
});
