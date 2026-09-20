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
// lineupDiff() decides on THIS week's projection (current_week_ppg), which is 0 for a
// team with no game on the schedule. Give every seeded team a week-1 game so the
// fixture's players are actually playing this week (matchupModel() caches the slate
// per process, so this has to land before the first assetUniverse() call).
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);

// Side-effect imports: assetUniverse() (trade-engine.js) reads tables created
// ad-hoc at import time by these route files, exactly like test/post-draft-plan.test.js.
await import('../server/routes/stats.js');       // player_season_stats
await import('../server/routes/aggregates.js');  // player_metrics
await import('../server/routes/tradelab.js');    // trending_players
await import('../server/routes/nfldata.js');     // roster_players

const { publishRecommendation, toRecommendation } = await import('../server/routes/decision-inbox.js');
const { lineupDiff } = await import('../server/services/trade-engine.js');
const { waiverUpgrades } = await import('../server/services/waiver-brain.js');

/*
 * THIS FILE USED TO DRIVE AN EXPRESS APP. The four routes were deleted on 2026-09-20
 * (nothing called them, in any tree), so every assertion that was really about the
 * MODULE now goes at the module directly, and the ones that were about the route layer
 * are gone. What went, and why none of it is a lost assertion:
 *
 *   - "a fresh install has no open recommendations", "list is sorted by urgency first",
 *     "summary counts open by urgency" — GET / and GET /summary did the filtering,
 *     ordering and counting. That code is deleted, so there is nothing left to assert
 *     about it. Ordering is now the job of whatever reads the table next.
 *   - "POST / requires an authenticated caller (a6-money-path)" — the gate was on the
 *     route. With no route there is no anonymous publish path to close: the only way
 *     in is importing the function, which needs no session. Keeping a 401 assertion
 *     against a deleted handler would be a green test guarding nothing.
 *   - the two resolve tests — `POST /:id/resolve` was the only writer of `status`,
 *     `resolved_at` and `outcome`. It had no caller either, so no row has ever been
 *     resolved; the tests were exercising a path the app could not reach. The
 *     module-level consequence that DOES still hold — a resolved row is never silently
 *     reopened — is asserted below against a row resolved directly in SQL.
 *
 * `openRows()` replaces `fetch(base)`: same shape, read from the table through the
 * same `toRecommendation` the publish path returns through, so the tests below still
 * fail if that mapping breaks.
 */
const openRows = () => rows(`SELECT * FROM decision_recommendations WHERE status = 'open'`)
  .map(toRecommendation);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('020_decision_recommendations ran and created the table', () => {
  assert.ok(applied.includes('020_decision_recommendations'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='decision_recommendations'`));
});

/* ------------------------------------------------------- publish contract */

test('publishing persists the row and returns the shape its callers read', () => {
  const body = publishRecommendation({
    dedupKey: 'test:trade:1', sport: 'NFL', type: 'trade', title: 'Sell high on Player X',
    rationale: 'Market value is diverging from role.', urgency: 'medium',
    sourceModel: 'trade-engine', link: '/trade-lab'
  });
  assert.equal(body.title, 'Sell high on Player X');
  assert.equal(body.status, 'open');
  assert.equal(body.urgency, 'medium');
  assert.deepEqual(body.subjectIds, []);
  assert.equal(row(`SELECT COUNT(*) n FROM decision_recommendations WHERE dedup_key='test:trade:1'`).n, 1);
});

/*
 * The deleted POST route turned each of these into a 400. The validation itself was
 * never the route's — it is in `publishRecommendation`, which throws — so the same
 * four rules are asserted here, now against the thing that enforces them. An engine
 * calling this with a bad payload gets an exception, not a silently dropped row.
 */
test('a publish missing a required field throws rather than writing a partial row', () => {
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NFL', type: 'trade', sourceModel: 'x' }), /title/);
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NHL', type: 'trade', title: 'x', sourceModel: 'x' }), /invalid sport/);
  assert.throws(() => publishRecommendation({ sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x' }), /dedupKey/);
  assert.throws(() => publishRecommendation({ dedupKey: 'x', sport: 'NFL', type: 'trade', title: 'x' }), /sourceModel/);
  assert.equal(row(`SELECT COUNT(*) n FROM decision_recommendations WHERE dedup_key='x'`).n, 0);
});

test('an invalid urgency value falls back to medium rather than rejecting the publish', () => {
  const body = publishRecommendation({ dedupKey: 'test:urgency', sport: 'NFL', type: 'trade', title: 'x', sourceModel: 'x', urgency: 'critical' });
  assert.equal(body.urgency, 'medium');
});

test('publishing the same dedupKey again refreshes the open row instead of duplicating it', () => {
  run('DELETE FROM decision_recommendations');
  const first = publishRecommendation({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v1', sourceModel: 'x', expectedValue: 1 });
  const second = publishRecommendation({ dedupKey: 'dupe-1', sport: 'NFL', type: 'x', title: 'v2', sourceModel: 'x', expectedValue: 2 });
  assert.equal(second.id, first.id, 'same dedup key while open must update in place, not create a new id');

  const list = openRows();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'v2');
  assert.equal(list[0].expectedValue, 2);
});

/*
 * The resolve ROUTE is gone and nothing resolves rows today, but the rule this guards
 * is in `publishRecommendation` itself — its dedup lookup is scoped to `status = 'open'`
 * precisely so resolution history survives a later republish. The row is resolved here
 * in SQL, which is what any future resolver will do underneath whatever calls it.
 */
test('a resolved row is never silently reopened by a later publish on the same key', () => {
  run('DELETE FROM decision_recommendations');
  const opened = publishRecommendation({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'first occurrence', sourceModel: 'x' });
  run(`UPDATE decision_recommendations SET status='actioned', resolved_at=datetime('now') WHERE id=?`, opened.id);

  const reopened = publishRecommendation({ dedupKey: 'dupe-2', sport: 'NFL', type: 'x', title: 'second occurrence', sourceModel: 'x' });
  assert.notEqual(reopened.id, opened.id, 'a resolved recommendation must not be silently reopened/overwritten');
  assert.equal(openRows().filter(r => r.id === opened.id).length, 0, 'the actioned row must not be open again');
  assert.equal(row('SELECT title FROM decision_recommendations WHERE id = ?', opened.id).title,
    'first occurrence', 'the resolved row keeps what it said when it was resolved');
});

/*
 * Expiry used to be swept on the read path, before every GET. With the routes gone the
 * sweep hangs off `publishRecommendation` instead, so this now asserts something it did
 * not before: that publishing ANY recommendation expires every other lapsed one. If
 * that call is ever removed, nothing marks a row expired again and every stale
 * recommendation reads as open forever.
 */
test('publishing expires every lapsed row, including ones it is not about', () => {
  run('DELETE FROM decision_recommendations');
  publishRecommendation({
    dedupKey: 'expired-1', sport: 'NFL', type: 'x', title: 'stale by now', sourceModel: 'x',
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(row(`SELECT status FROM decision_recommendations WHERE dedup_key='expired-1'`).status,
    'open', 'its own publish cannot expire it: the sweep runs before the row exists');

  publishRecommendation({ dedupKey: 'unrelated', sport: 'NFL', type: 'x', title: 'a later, live one', sourceModel: 'x' });
  assert.equal(row(`SELECT status FROM decision_recommendations WHERE dedup_key='expired-1'`).status, 'expired');
  assert.deepEqual(openRows().map(r => r.title), ['a later, live one']);
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

  const list = openRows();
  const reco = list.find(r => r.type === 'lineup' && r.leagueId === 201);
  assert.ok(reco, 'lineupDiff() must publish a decision_recommendations row for a real swap');
  assert.equal(reco.title, `Start ${strong.name} over ${weak.name}`);
  assert.equal(reco.sourceModel, 'lineup-brain');
  assert.equal(reco.link, '/lineup');
  assert.deepEqual(reco.subjectIds.sort(), [strong.id, weak.id].sort());
  assert.equal(reco.urgency, 'high', 'an 11+ point gap is right at least 75% of the time (Phi(gap / 14.5)), so urgency high');

  // Recomputing (e.g. the page reloading) must refresh the same row, not spam a duplicate.
  lineupDiff(lg, '1');
  const listAgain = openRows();
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
  const list = openRows();
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

  const list = openRows();
  const reco = list.find(r => r.type === 'waiver' && r.leagueId === 301);
  assert.ok(reco, 'waiverUpgrades() must publish a decision_recommendations row for a real upgrade');
  assert.equal(reco.title, `Add ${strong.name} before waivers process`);
  assert.equal(reco.sourceModel, 'waiver-brain');
  assert.equal(reco.link, '/brain');
  assert.equal(reco.urgency, 'high');

  waiverUpgrades(301, { myTeamId: '1' });
  const listAgain = openRows();
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
  const list = openRows();
  assert.equal(list.filter(r => r.leagueId === 302).length, 0);
});
