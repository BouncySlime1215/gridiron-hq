/**
 * `rosterContext()` swallowed `analyzeLeague`'s failure and returned an EMPTY
 * MAP (server/services/trade-engine.js, the bare `catch {}`). Every downstream
 * read then degraded to absent with no signal:
 *
 *   - `evaluate()`'s `ctx.theirNeeds` is undefined, so `hurtsNeed` is always
 *     empty and `brokenForThem` collapses to "does it leave a hole";
 *   - `their_window` is null, indistinguishable from a team we have no window on.
 *
 * The engine keeps producing offers that read exactly as confident as the ones
 * where the check actually ran. `evaluate`'s own docstring says the context
 * exists so the check can see "whether this package actually makes sense for
 * them, not just whether the numbers pencil out" — with an empty map that is
 * precisely what it falls back to, silently. CLAUDE.md names this shape: two
 * shipped bugs where a silent catch deleted a data layer and the page kept
 * printing numbers.
 *
 * The tell is the sibling. `counterparty-pricing.js#deriveRosterNeeds` catches
 * the SAME call and the SAME failure, returns `null`, and its caller records
 * `{ source, reason: 'no roster read for this league (analyzeLeague produced
 * none)' }` at :773. One reports, one hides. So this is not a design argument
 * about whether absence should be visible — the house already answered.
 *
 * Third case, found while writing this and deliberately pinned: POST
 * /:leagueId/evaluate (routes/trades.js:934, the Trade Lab "check this trade"
 * button) calls `evaluate()` with NO context at all. Nothing failed there; the
 * read was simply never asked for. That surface must not be able to claim a
 * read it never had, which is why the field defaults to the not-supplied
 * reason rather than to null.
 */
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-roster-read-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
process.env.NFL_WEEK = '2';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded NFL team needs a game in the weeks this fixture prices, or
// current_week_ppg is 0 for everybody and no package ever improves a lineup.
// matchupModel() caches the slate per process, so this lands before the first
// assetUniverse() call (test/decision-inbox.test.js does the same).
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 2, abbr, 1 FROM nfl_teams`);
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');

// tradelab.js is imported FIRST and mocked BEFORE trade-engine.js is loaded.
// trade-engine.js:58 binds `analyzeLeague` from this module at its own load, so
// a mock installed after that import would never be seen — the trap recorded in
// test/waiver-confidence-is-hand-set.test.js. tradelab.js does not import
// trade-engine.js, so there is no cycle to fall foul of here.
const { default: tradelabRouter, analyzeLeague: realAnalyzeLeague, ...tradelabNamed } =
  await import('../server/routes/tradelab.js');

// Flipped per test. `true` is the defect's precondition: a league whose payload
// analyzeLeague cannot read.
let analyzeThrows = false;
mock.module('../server/routes/tradelab.js', {
  defaultExport: tradelabRouter,
  namedExports: {
    ...tradelabNamed,
    analyzeLeague: lg => {
      if (analyzeThrows) throw new Error('league payload cannot be analysed');
      return realAnalyzeLeague(lg);
    }
  }
});

await import('../server/routes/stats.js');       // player_season_stats
await import('../server/routes/aggregates.js');  // player_metrics
await import('../server/routes/nfldata.js');     // roster_players
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { deriveFormat } = await import('../server/services/format.js');

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'request failed' }));

const TOKEN = 'roster-read-token';
db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (886,'roster-read-user','Roster Read User')`).run();
db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (886,?,datetime('now','+1 day'))`)
  .run(hashSessionToken(TOKEN));

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

async function request(url, body = null) {
  const payload = body ? JSON.stringify(body) : null;
  const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
  req.url = url; req.method = payload ? 'POST' : 'GET';
  // `content-length` is not decoration: express.json() asks type-is whether the
  // request has a body at all, and without a length or a transfer-encoding the
  // answer is no — the body is silently never parsed and the route sees an
  // empty `req.body`, which reads as "the caller sent nothing".
  req.headers = { authorization: `Bearer ${TOKEN}`,
    ...(payload ? { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)) } : {}) };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    };
    app.handle(req, res, reject);
  });
}

// A roster entry needs `id` and `defaultPositionId` or loadRosters matches
// nobody and says nothing — recorded in [[mocking-trade-engine-in-tests]].
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
function pool(position, n) {
  return rows(`SELECT id, name, position FROM players
               WHERE position = ? AND fantasy_relevant = 1
               ORDER BY id LIMIT ?`, position, n);
}

let fakeId = 960000;

/**
 * A league where a real mutual upgrade exists, so `/find` actually returns
 * deals. My team is deep at RB and thin at WR; theirs is the mirror. Without
 * this the fixture produces an empty deal list and every assertion below is
 * vacuous — the exact way this suite's earlier fixtures passed for the wrong
 * reason ([[mocking-trade-engine-in-tests]]).
 *
 * Projections descend rather than repeat, because VOR is `proj -
 * replacementLevel` and identical projections collapse a whole position to
 * VOR 0.
 */
function league(id) {
  const qb = pool('QB', 2), rb = pool('RB', 6), wr = pool('WR', 6), te = pool('TE', 2);
  const mine = [...qb.slice(0, 1), ...rb.slice(0, 3), ...wr.slice(0, 3), ...te.slice(0, 1)];
  const theirs = [...qb.slice(1, 2), ...rb.slice(3, 6), ...wr.slice(3, 6), ...te.slice(1, 2)];
  const project = (player, points) =>
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games)
         VALUES (?, 2026, 'projected', ?, 17)`, player.id, points);
  // assetUniverse reads player_season_stats; only projected players get an
  // adj_ppg above zero and reach a pool at all.
  const BY_POSITION = {
    mine:   { QB: [300], RB: [320, 300, 285], WR: [130, 120, 110], TE: [200] },
    theirs: { QB: [290], RB: [140, 125, 115], WR: [310, 295, 280], TE: [190] }
  };
  const assign = (list, table) => {
    const next = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const p of list) project(p, table[p.position][next[p.position]++]);
  };
  run('DELETE FROM player_season_stats');
  assign(mine, BY_POSITION.mine);
  assign(theirs, BY_POSITION.theirs);
  const entries = list => list.map(p => ({
    playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } }));
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, 10, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-${id}`, `Roster Read League ${id}`,
    JSON.stringify({
      teams: [
        { id: 1, name: 'My Team', roster: { entries: entries(mine) } },
        { id: 2, name: 'Rival Team', roster: { entries: entries(theirs) } }
      ],
      settings: { name: `Roster Read League ${id}` },
      status: { currentMatchupPeriod: 2 }
    }),
    JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 886, 'commissioner')`, id);
  // Market price. Without a dynasty_values row every asset's `value` is 0, and
  // the trade search's first prune is `if (!total) continue` on give+get value
  // — so a fixture with no prices considers exactly zero packages and returns
  // an empty deal list that looks like "no good trades" rather than "no data".
  const { formatKey } = deriveFormat(rows('SELECT * FROM leagues WHERE id = ?', id)[0]);
  const price = (player, points) => run(
    `INSERT OR REPLACE INTO dynasty_values (format_key, player_id, value, redraft_value, pos_rank)
     VALUES (?, ?, ?, ?, 1)`, formatKey, player.id, Math.round(points * 20), Math.round(points * 20));
  for (const p of mine) price(p, BY_POSITION.mine[p.position][mine.filter(x => x.position === p.position).indexOf(p)]);
  for (const p of theirs) price(p, BY_POSITION.theirs[p.position][theirs.filter(x => x.position === p.position).indexOf(p)]);
  return { mine, theirs };
}

async function deals(leagueId) {
  // `mutual=0` is the UI's "aggressive" mode, not a workaround: it keeps deals
  // that only help my side, which is exactly the population where the roster-fit
  // check matters most — those are the ones whose plausibility rests on what the
  // other side needs. With mutual required this fixture yields 0 deals and 19
  // considered, so every per-deal assertion would be vacuous.
  const res = await request(`/api/trades/${leagueId}/find?team_id=1&mutual=0`);
  assert.equal(res.status, 200, `find failed: ${JSON.stringify(res.body).slice(0, 200)}`);
  const list = res.body.deals ?? [];
  // Mandatory, per the fixture note above: a deal list of zero makes every
  // per-deal assertion pass by vacuity.
  assert.ok(list.length > 0, 'the fixture must produce deals, or the assertions below test nothing');
  return list;
}

test('the mock actually reaches the engine, which is what makes the rest of this file mean anything', async () => {
  // The precondition, asserted against the engine rather than against a local
  // copy of the throw: if `mock.module` had not taken, analyzeLeague would
  // succeed inside trade-engine.js and every "absent" assertion below would be
  // testing the happy path under a misleading name.
  league(400);
  analyzeThrows = true;
  try {
    const { analyzeLeague } = await import('../server/routes/tradelab.js');
    assert.throws(() => analyzeLeague({ id: 400 }), /cannot be analysed/);
  } finally { analyzeThrows = false; }
});

test('a league whose roster read failed says so on every offer it prices', async () => {
  league(401);
  analyzeThrows = true;
  try {
    for (const d of await deals(401)) {
      assert.equal(d.roster_read_absent, 'no roster read for this league (analyzeLeague produced none)',
        'a deal priced with no roster read must say so, not read as one where the check ran');
    }
  } finally { analyzeThrows = false; }
});

test('the same shape of league says nothing is absent once the read works', async () => {
  // The control. Without it a field hardcoded to the reason string would pass
  // the test above and be just as dishonest in the other direction.
  league(402);
  for (const d of await deals(402)) assert.equal(d.roster_read_absent, null);
});

test('the absence does not silently widen what counts as plausible', async () => {
  // The consequence, not just the label. With no needs read, `hurtsNeed` is
  // always empty and `brokenForThem` collapses to "does it leave a hole" — so
  // a deal can be called plausible on numbers alone. It may still be plausible;
  // what it may not do is claim the roster-fit check backed that verdict.
  league(405);
  analyzeThrows = true;
  try {
    const priced = await deals(405);
    for (const d of priced.filter(x => x.plausible)) {
      assert.equal(d.roster_read_absent, 'no roster read for this league (analyzeLeague produced none)');
      assert.equal(d.their_window, null);
    }
  } finally { analyzeThrows = false; }
});

test('the wording is the one counterparty-pricing already uses for this failure', async () => {
  // Two surfaces must not name the same failure differently; that is how a
  // reader concludes they are two different problems.
  const { ROSTER_READ_ABSENT } = await import('../server/services/trade-engine.js');
  assert.equal(ROSTER_READ_ABSENT.unavailable,
    'no roster read for this league (analyzeLeague produced none)');
});

test('an evaluation handed no context at all cannot claim a read it never had', async () => {
  // POST /:leagueId/evaluate (routes/trades.js:934, the Trade Lab "check this
  // trade" button) passes no ctx. Nothing failed there; the read was never
  // asked for. The field must default to saying so, not to null — otherwise
  // this fix makes that surface MORE misleading than before, because a null
  // would now read as "the check ran".
  const { mine, theirs } = league(404);
  const give = [mine.find(p => p.position === 'RB').id];
  const get = [theirs.find(p => p.position === 'WR').id];
  const res = await request('/api/trades/404/evaluate', { my_team_id: '1', their_team_id: '2', give, get });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.roster_read_absent, 'no roster read was supplied to this evaluation');
});

